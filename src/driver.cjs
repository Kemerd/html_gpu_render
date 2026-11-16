/**
 * driver.cjs: the frame loop, shared by both backends.
 *
 * `driver` is ONE SELF-CONTAINED FUNCTION: it uses nothing from this file's scope, because the browser backend
 * sends its source text into the page (driver.toString()) while the Electron backend calls it from the preload.
 * Everything that differs between the two comes in through `env`.
 *
 * The host document is one canvas whose only child is an <iframe> holding the page. Two capture modes run here
 * (the third, 'screenshot', is src/screenshot.cjs), over four "roads" from the picture to bytes:
 *
 * mode 'element' (HTML-in-Canvas), road 'element': the whole page, whatever it is made of.
 *     seek -> canvas.requestPaint() and its 'paint' event (the browser now holds a snapshot of the page) ->
 *     GPUQueue.copyElementImageToTexture() (drawElementImageToTexture() in newer Chromium) rasters the snapshot
 *     into a WebGPU texture -> one pass -> copyTextureToBuffer -> mapAsync.
 *
 * mode 'canvas' (direct GPU readback): the page's picture IS one <canvas>. The road is picked automatically:
 *     'webgl2-readpixels'  a WebGL2 canvas: gl.readPixels into a pixel-pack buffer in the same task as the draw
 *                          (so a canvas without preserveDrawingBuffer still holds its picture), a fence, then
 *                          getBufferSubData. No WebGPU and no extra texture copy. The y flip is a GPU blit.
 *     'webgpu-copy'        a WebGPU canvas configured with rgba8unorm, COPY_SRC and premultiplied alpha:
 *                          copyTextureToBuffer from its current texture on the page's own device, then mapAsync.
 *     'external-copy'      everything else (2D canvases, WebGL1, a WebGPU canvas configured otherwise, a wanted
 *                          alpha form the canvas does not hold, a background colour):
 *                          GPUQueue.copyExternalImageToTexture(canvas) into a texture of this loop's own device,
 *                          then as in element mode.
 *
 * Two things keep the per-frame cost down:
 *   - No row padding to remove. WebGPU pads the rows of a readback to 256 bytes. Where the frame's rows are not a
 *     multiple of 256 bytes, the one pass re-lays the picture out into a texture whose rows are (same pixels, same
 *     order, wider and less high), so the mapped buffer IS the tightly packed frame and is written as it is.
 *   - Frames in flight. A ring of readback buffers: the wait for frame n (mapAsync or the fence) and its write run
 *     while frame n+1 is drawn. A slot is given back only when its frame is safely written, so frames can neither
 *     overtake each other nor pile up.
 *
 * Motion blur by sub-frames (cfg.subframes = n > 1): for one output frame the page is set to n times inside the
 * frame interval and each picture is ADDED on the GPU into a float texture; only the average is read back.
 *   sample times   t_k = T + ((k + 0.5) / n - 0.5) * shutter / fps      k = 0 .. n-1,  T = from + i / fps
 *                  (evenly spaced over the open part of the interval, centred on the frame time; n = 1 gives T)
 *   what is summed premultiplied values, in rgba32float: with blurSpace 'linear' the colour is first decoded from
 *                  sRGB to linear light (un-premultiply, decode, premultiply again), with 'srgb' the encoded
 *                  values are summed as they are. Alpha is summed as it is in both.
 *   the resolve    the same one pass that lays the rows out: divide by n, encode again, background, straight alpha.
 * No sub-frame leaves the GPU. Sub-frames need this loop's own device, so canvas mode takes the copy road.
 *
 * Float output (cfg.format raw16f, raw32f, png16, exr): the pass writes a float texture (rgba16float or
 * rgba32float) instead of rgba8unorm and that is read back, so nothing is clamped to 0..1 or cut to 8 bits. A
 * float picture comes from: a canvas that holds one (a WebGPU canvas configured rgba16float keeps values above 1
 * and below 0 through copyExternalImageToTexture: measured), the page's float hook (road 'webgl2-float-hook': the
 * page names a WebGL2 framebuffer with a float attachment, it is read with readPixels FLOAT and uploaded), or the
 * sub-frame sum, which is float whatever the source. The same pass can convert the colour: input transfer (sRGB or
 * linear) -> linear light -> primaries -> output transfer (sRGB, linear or PQ), on straight colour.
 *
 * env:
 *   seek(name, t) -> Promise<'sync' | 'async'>   call the page's hook. The hook itself must have RUN when this
 *                                   call returns; the promise then says whether the hook returned a promise
 *   has(name) -> Promise<boolean>   is window.<name> a function in the page
 *   fonts() -> Promise              the page's document.fonts.ready
 *   test(expression) -> Promise<boolean>   evaluate the caller's --ready expression in the page
 *   floatInfo(name) -> Promise<{ width, height } | null>   the page's float hook window.<name>(), if it has one
 *   floatBind(name) / floatUnbind()   bind the hook's framebuffer as READ_FRAMEBUFFER of the page's WebGL2
 *                                   context, and put the previous binding back (both must act when called)
 *   take(bytes) -> Uint8Array       a buffer for one frame (only the roads that must copy use it)
 *   write(i, bytes, width, height) -> Promise   put frame i where it belongs; resolves when it is safely there. `bytes` is
 *                                   only valid until that promise settles (it may be GPU-mapped memory)
 *   probe(bytes) -> Promise         (optional) measurement only: the cost of one more hop for a frame
 *   progress(done, of)              (optional)
 *
 * Returns the summary object (timings included); the caller adds what it knows and writes render.json.
 */
'use strict';

async function driver(cfg, env) {
  const now = () => performance.now();

  /** mean / median / p95 / max of a list of milliseconds, rounded to 0.01 ms. */
  const stat = (list) => {
    if (!list || !list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const r = (v) => Math.round(v * 100) / 100;
    return { mean: r(s.reduce((a, b) => a + b, 0) / s.length), median: r(s[s.length >> 1]), p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: r(s[s.length - 1]), n: s.length };
  };

  /** '#rgb', '#rrggbb' or '#rrggbbaa' to [r, g, b, a] in 0..1, or null for 'transparent' / nothing. */
  const parseColour = (text) => {
    if (!text || text === 'transparent' || text === 'none') return null;
    let h = String(text).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`--background: "${text}" is not transparent, #rgb, #rrggbb or #rrggbbaa`);
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  };

  /** Gives the event loop one turn, without the clamping of nested timers (used to poll a GL fence). */
  const turn = (() => {
    const channel = new MessageChannel();
    const waiting = [];
    channel.port1.onmessage = () => { const next = waiting.shift(); if (next) next(); };
    return () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
  })();

  // The one pass of the WebGPU roads. It reads the source texture (premultiplied, sRGB-encoded values) and writes
  // the layout texture: pixel number n of the target, counted row by row, is pixel number n of the source. With
  // target rows that are a multiple of 256 bytes the readback then has no padding at all. The same pass composites
  // over the background colour when there is one, in the encoded space the browser itself composites in.
  const WGSL = `
struct Params { bg: vec4f, mode: vec4f, dims: vec4u, conv: vec4f, m0: vec4f, m1: vec4f, m2: vec4f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // one triangle that covers the target
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
// linear light to sRGB-encoded (IEC 61966-2-1), and back; both carried on beyond 0..1 by mirroring at zero
// ("extended sRGB"), which is the same function inside 0..1
fn encode(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, 12.92 * a, a <= vec3f(0.0031308));
}
fn decode(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
}
// SMPTE ST 2084 (PQ): y is luminance as a fraction of 10000 cd/m2
fn pq(y: vec3f) -> vec3f {
  let p = pow(y, vec3f(0.1593017578125));
  return pow((0.8359375 + 18.8515625 * p) / (1.0 + 18.6875 * p), vec3f(78.84375));
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // dims: source width, source height, target width, 1 = the source has its bottom row first
  let n = u32(pos.y) * params.dims.z + u32(pos.x);
  var at = vec2u(n % params.dims.x, n / params.dims.x);
  if (at.y >= params.dims.y) { return vec4f(0.0); }
  if (params.dims.w == 1u) { at.y = params.dims.y - 1u - at.y; }
  var o = textureLoad(src, at, 0);
  if (params.mode.z > 0.5) {
    // the source is a sum of mode.z sub-frames (premultiplied): the average, and back from linear light if summed there
    o = o / params.mode.z;
    if (params.mode.w > 0.5 && o.a > 0.0) {
      // m0.w: the source is a float picture, whose values may lie outside 0..1 and are left there
      var lin = o.rgb / o.a;
      if (params.m0.w < 0.5) { lin = clamp(lin, vec3f(0.0), vec3f(1.0)); }
      o = vec4f(encode(lin) * o.a, o.a);
    }
    // without a background the straight form, if asked for, is made here (the background branch makes its own)
    if (params.mode.y < 0.5 && params.mode.x > 0.5 && o.a > 0.0) { o = vec4f(o.rgb / o.a, o.a); }
  }
  if (params.mode.y > 0.5) {
    // source over the background (the background is given straight, so it is premultiplied first)
    let b = vec4f(params.bg.rgb * params.bg.a, params.bg.a);
    o = o + b * (1.0 - o.a);
    // a background that is itself translucent leaves alpha in the result: straight form if asked for
    if (params.mode.x > 0.5 && o.a > 0.0) { o = vec4f(o.rgb / o.a, o.a); }
  }
  if (params.conv.x > 0.5) {
    // Colour conversion, on the colour itself (o is premultiplied here): input transfer -> linear light ->
    // primaries -> output transfer. conv: on, input (0 sRGB, 1 linear), output (0 sRGB, 1 linear, 2 PQ),
    // PQ scale (the luminance of 1.0 as a fraction of 10000 cd/m2). m0..m2: the rows of the primaries matrix.
    var c = vec3f(0.0);
    if (o.a > 0.0) { c = o.rgb / o.a; }
    if (params.conv.y < 0.5) { c = decode(c); }
    c = vec3f(dot(params.m0.xyz, c), dot(params.m1.xyz, c), dot(params.m2.xyz, c));
    if (params.conv.z < 0.5) { c = encode(c); } else if (params.conv.z > 1.5) { c = pq(max(c, vec3f(0.0)) * params.conv.w); }
    // m1.w: straight alpha asked for; otherwise premultiplied again
    if (params.m1.w > 0.5) { o = vec4f(c, o.a); } else { o = vec4f(c * o.a, o.a); }
  }
  return o;
}`;

  // The accumulation pass of the motion blur: target = previous sum + this sub-frame. Two float textures take
  // turns as target and as previous sum, so no blending of float targets is needed.
  const WGSL_ACC = `
struct Acc { flags: vec4f }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var prev: texture_2d<f32>;
@group(0) @binding(2) var<uniform> acc: Acc;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
// sRGB-encoded to linear light (IEC 61966-2-1), carried on beyond 0..1 by mirroring at zero
fn decode(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let at = vec2u(pos.xy);
  // the sub-frame: premultiplied; flags.w: its bottom row is first
  var q = at;
  if (acc.flags.w > 0.5) { q.y = textureDimensions(src).y - 1u - at.y; }
  var s = textureLoad(src, q, 0);
  // flags.y: decode to linear light before summing: the colour itself (not the premultiplied value) is what
  // the curve applies to. flags.z: a float picture, whose values may lie outside 0..1 and are left there.
  if (acc.flags.y > 0.5 && s.a > 0.0) {
    var c = s.rgb / s.a;
    if (acc.flags.z < 0.5) { c = clamp(c, vec3f(0.0), vec3f(1.0)); }
    s = vec4f(decode(c) * s.a, s.a);
  }
  // flags.x: this is the first sub-frame of the frame: there is no previous sum
  var p = vec4f(0.0);
  if (acc.flags.x < 0.5) { p = textureLoad(prev, at, 0); }
  return p + s;
}`;

  if (!cfg || typeof cfg !== 'object' || !env) throw new Error('no configuration reached the frame loop');
  const canvas = document.getElementById('hgr-canvas');
  const frame = document.getElementById('hgr-frame');
  if (!canvas || !frame) throw new Error('the host document is not in place (canvas or frame missing)');

  // ── the page: the hook, the faces, the caller's own ready condition ──
  // (first of all: only a page that is ready has made its canvas context, which the road is chosen by)
  const seekName = cfg.seek && cfg.seek !== 'none' ? String(cfg.seek) : null;
  if (seekName && !(await env.has(seekName))) {
    throw new Error(`the page has no function window.${seekName}(t). Define it (it sets the page to time t in seconds), name another with --seek <name>, or pass --seek none for a page that does not move.`);
  }
  await env.fonts();
  if (cfg.ready) {
    // poll the caller's expression in the page until it is truthy
    const until = now() + cfg.timeout * 1000;
    while (!(await env.test(String(cfg.ready)))) {
      if (now() > until) throw new Error(`--ready "${cfg.ready}" did not become true within ${cfg.timeout} s.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (cfg.wait > 0) await new Promise((r) => setTimeout(r, cfg.wait));

  const mode = cfg.mode === 'canvas' ? 'canvas' : 'element';
  const frames = Math.max(1, cfg.frames | 0);
  const bg = parseColour(cfg.background);
  // Alpha: over a background the premultiplied form is taken and composited in the pass; otherwise the form asked
  // for is what is read back.
  // Sub-frames: how many, over which part of the frame interval, summed in which space. Sums are of
  // premultiplied values, so with sub-frames the premultiplied form is always what is taken.
  const sub = Math.max(1, Math.min(256, cfg.subframes | 0 || 1));
  const shutter = Number.isFinite(Number(cfg.shutter)) ? Math.max(0, Math.min(1, Number(cfg.shutter))) : 0.5;
  const blurLinear = cfg.blurSpace !== 'srgb';
  // Float output: the texture format that is read back and its bytes per pixel; 8-bit output otherwise.
  const FLOAT_OUT = { raw16f: ['rgba16float', 8], exr: ['rgba16float', 8], raw32f: ['rgba32float', 16], png16: ['rgba32float', 16] };
  const floatOut = FLOAT_OUT[cfg.format] || null;
  const outFormat = floatOut ? floatOut[0] : 'rgba8unorm';
  const bpp = floatOut ? floatOut[1] : 4;
  // Colour: what the page's values are (input transfer), what is written (transfer, primaries). Only float
  // output converts; without a difference nothing is touched.
  const inTransfer = cfg.inputTransfer === 'linear' ? 'linear' : 'srgb';
  const outTransfer = floatOut ? (cfg.transfer || inTransfer) : inTransfer;
  const primaries = floatOut ? (cfg.primaries || 'srgb') : 'srgb';
  const whiteNits = Number(cfg.whiteNits) > 0 ? Number(cfg.whiteNits) : 203;
  const convert = !!floatOut && (outTransfer !== inTransfer || primaries !== 'srgb');
  // with a linear input the sub-frames are summed as they are: they are linear light already
  const accDecode = blurLinear && inTransfer === 'srgb';
  const wantPremultiplied = !!bg || sub > 1 || convert || cfg.alpha !== 'straight';

  // ── canvas mode: find the canvas and pick the road ──
  let pageCanvas = null, road = 'element', gl = null, pageGpu = null, hook = null;
  const hookName = cfg.floatHook || '__hgrFloatSource';
  if (mode === 'canvas') {
    const selector = cfg.canvas || 'canvas';
    try { pageCanvas = frame.contentDocument.querySelector(selector); } catch (e) { throw new Error(`--canvas "${selector}" is not a valid selector.`); }
    if (!pageCanvas || String(pageCanvas.tagName).toUpperCase() !== 'CANVAS') throw new Error(`--mode canvas: the page has no <canvas> matching "${selector}". Name it with --canvas <css selector>, or use --mode element.`);
    road = 'external-copy';
    // Which roads may be taken (measured, README "Canvas roads"): for a WebGL2 canvas the copy road is the faster
    // one, so readPixels is only taken when asked for or when there is no WebGPU; for a WebGPU canvas that is
    // configured for it, reading its own texture is the faster one, so 'auto' takes it.
    const allowGl = cfg.canvasRoad === 'direct' || (cfg.canvasRoad !== 'copy' && !navigator.gpu);
    const allowGpu = cfg.canvasRoad !== 'copy';
    // Float output: the page's float hook first (a WebGL2 framebuffer with a float attachment, e.g. a three.js
    // render target); without a hook the canvas itself is the source, through the copy road.
    if (floatOut && env.floatInfo) {
      hook = await env.floatInfo(hookName);
      if (hook) {
        try { gl = pageCanvas.getContext('webgl2'); } catch (e) { gl = null; }
        if (!gl) throw new Error(`window.${hookName}() names a float framebuffer, but the canvas "${selector}" has no WebGL2 context: the framebuffer must belong to that canvas's context.`);
        if (!(hook.width > 0 && hook.height > 0)) throw new Error(`window.${hookName}() must return { framebuffer, width, height } with the size of the float attachment.`);
        road = 'webgl2-float-hook';
      }
    }
    if (!bg && sub === 1 && !floatOut && (allowGl || allowGpu)) {
      // Asking a canvas for the kind of context it already has returns that context; asking for another kind
      // returns null. (The page must have made its context by now: see README.)
      let g = null;
      try { g = pageCanvas.getContext('webgl2'); } catch (e) { g = null; }
      if (g) {
        const attrs = g.getContextAttributes() || {};
        // the drawing buffer holds what the page wrote: premultiplied values unless the context says otherwise
        const holdsWanted = attrs.alpha === false || (attrs.premultipliedAlpha !== false) === wantPremultiplied;
        if (allowGl && typeof g.fenceSync === 'function' && holdsWanted && g.drawingBufferWidth === pageCanvas.width && g.drawingBufferHeight === pageCanvas.height) { gl = g; road = 'webgl2-readpixels'; }
      } else if (allowGpu) {
        let c = null, conf = null;
        try { c = pageCanvas.getContext('webgpu'); conf = c && typeof c.getConfiguration === 'function' ? c.getConfiguration() : null; } catch (e) { conf = null; }
        if (conf && conf.device && conf.format === 'rgba8unorm' && (conf.usage & GPUTextureUsage.COPY_SRC) && conf.alphaMode === 'premultiplied' && wantPremultiplied) { pageGpu = { context: c, device: conf.device }; road = 'webgpu-copy'; }
      }
    }
  }

  const W = hook ? hook.width : pageCanvas ? pageCanvas.width : Math.round(cfg.width * cfg.dpr), H = hook ? hook.height : pageCanvas ? pageCanvas.height : Math.round(cfg.height * cfg.dpr);
  if (!(W > 0 && H > 0)) throw new Error(`bad frame size ${W} x ${H}`);
  const rowBytes = W * bpp;
  const frameBytes = rowBytes * H;

  // ── the API must be there for the road taken: say exactly what is missing ──
  // HTML-in-Canvas has had two spellings so far (see README, "API dialects"); either will do.
  const dialect = typeof GPUQueue === 'undefined' ? null
    : 'copyElementImageToTexture' in GPUQueue.prototype ? 'chromium-150'
    : 'drawElementImageToTexture' in GPUQueue.prototype ? 'chromium-157' : null;
  const ownDevice = road === 'element' || road === 'external-copy' || road === 'webgl2-float-hook';
  if (ownDevice && !navigator.gpu) throw new Error('WebGPU is not available (navigator.gpu is undefined). It needs a GPU process and a secure context: do not pass --disable-gpu.');
  if (road === 'element' && !dialect) {
    throw new Error('GPUQueue has neither copyElementImageToTexture nor drawElementImageToTexture. This Chromium lacks the HTML-in-Canvas API, or the switch --enable-blink-features=CanvasDrawElement did not take effect. Run tools/probe.mjs to see what the binary exposes.');
  }
  if (road === 'element' && typeof canvas.requestPaint !== 'function') throw new Error('canvas.requestPaint is not exposed (HTML-in-Canvas is only partly present in this Chromium).');
  if (road === 'external-copy' && !('copyExternalImageToTexture' in GPUQueue.prototype)) throw new Error('--mode canvas needs GPUQueue.copyExternalImageToTexture for this canvas, which this Chromium does not have.');

  // how many frames may be between "drawn" and "written" at once
  const ringSize = Math.max(1, Math.min(16, (cfg.inflight | 0) || 8));
  let gpuError = null;
  let adapterName = '';

  // ── the WebGPU device of this loop (element and external-copy roads) ──
  let device = null, elementTex = null, outTex = null, pipeline = null, bindGroup = null, copyElement = null;
  let accTex = null, accPipeline = null, accGroups = null, sourceIsFloat = false, hookPixels = null;
  // the layout of a readback on this device: rows of layoutW pixels, no padding when layoutW * 4 is a multiple of 256
  let layoutW = W, layoutH = H, needPass = false;
  if (ownDevice) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('navigator.gpu.requestAdapter() returned null: no usable GPU adapter.');
    adapterName = adapter.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description].filter(Boolean).join(' ') : '';
    if (rowBytes % 256 !== 0 || (floatOut && W % 64 !== 0)) {
      // the next width that is a multiple of 64 pixels, and as many rows as hold every pixel
      layoutW = Math.ceil(W / 64) * 64;
      layoutH = Math.ceil((W * H) / layoutW);
    }
    if (adapter.limits.maxTextureDimension2D < Math.max(W, H, layoutW, layoutH)) throw new Error(`the frame (${W} x ${H}) is larger than this adapter's texture limit (${adapter.limits.maxTextureDimension2D}).`);
    device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => { gpuError = gpuError || (e && e.error && e.error.message) || 'unknown WebGPU error'; });
    device.lost.then((info) => { gpuError = gpuError || `the WebGPU device was lost: ${info && info.message}`; });

    // the host canvas gets a WebGPU context so that it is a WebGPU canvas; nothing is ever drawn to it
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('canvas.getContext("webgpu") returned null.');
    ctx.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });

    // the texture the page (or its canvas) is put into
    // (8-bit normally; half float for a canvas when float output is asked for, so that a float canvas keeps its
    // values; 32-bit float for the hook road, which uploads what readPixels gave. HTML-in-Canvas itself gives
    // 8-bit sRGB values whatever the destination: measured, README "HDR")
    const sourceFormat = road === 'webgl2-float-hook' ? 'rgba32float' : road === 'external-copy' && floatOut ? 'rgba16float' : 'rgba8unorm';
    sourceIsFloat = sourceFormat !== 'rgba8unorm';
    elementTex = device.createTexture({
      size: [W, H], format: sourceFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // motion blur: the two float textures that take turns holding the sum, and the pass that adds a sub-frame
    if (sub > 1) {
      accTex = [0, 1].map(() => device.createTexture({ size: [W, H], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
      const accModule = device.createShaderModule({ code: WGSL_ACC });
      accPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: accModule, entryPoint: 'vs' },
        fragment: { module: accModule, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      });
      const flags = (first) => {
        const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, new Float32Array([first ? 1 : 0, accDecode ? 1 : 0, sourceIsFloat ? 1 : 0, road === 'webgl2-float-hook' ? 1 : 0]));
        return b;
      };
      const group = (prev, ubo) => device.createBindGroup({ layout: accPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: elementTex.createView() }, { binding: 1, resource: prev.createView() }, { binding: 2, resource: { buffer: ubo } }] });
      const later = flags(false);
      accGroups = {
        first: group(accTex[1], flags(true)),          // writes accTex[0]; the previous sum is not read
        into: [group(accTex[1], later), group(accTex[0], later)],   // into[j] writes accTex[j] and reads the other
      };
    }

    // the one pass: needed for a background, to lay the rows out without padding, or to resolve the sub-frames
    needPass = !!bg || layoutW !== W || sub > 1 || !!floatOut;
    outTex = elementTex;
    if (needPass) {
      outTex = device.createTexture({ size: [layoutW, layoutH], format: outFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const module = device.createShaderModule({ code: WGSL });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: outFormat }] },
        primitive: { topology: 'triangle-list' },
      });
      // Params: bg (4 floats), mode (4 floats), dims (4 unsigned), conv (4 floats), the three rows of the matrix
      // linear Rec.709 / sRGB primaries to the primaries written (D65 throughout)
      const MATRIX = {
        srgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        p3: [0.8224621, 0.1775380, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199],
        rec2020: [0.6274039, 0.3292830, 0.0433131, 0.0690973, 0.9195404, 0.0113623, 0.0163914, 0.0880133, 0.8955953],
      };
      const m = MATRIX[primaries] || MATRIX.srgb;
      const straight = cfg.alpha === 'straight';
      const raw = new ArrayBuffer(112);
      // with a conversion the straight form is made at its end (m1.w), not in the earlier branches (mode.x)
      new Float32Array(raw, 0, 8).set([...(bg || [0, 0, 0, 0]), straight && !convert ? 1 : 0, bg ? 1 : 0, sub > 1 ? sub : 0, sub > 1 && accDecode ? 1 : 0]);
      // a source with its bottom row first is turned over where it is first read: here, or in the accumulation
      new Uint32Array(raw, 32, 4).set([W, H, layoutW, road === 'webgl2-float-hook' && sub === 1 ? 1 : 0]);
      new Float32Array(raw, 48, 16).set([
        convert ? 1 : 0, inTransfer === 'linear' ? 1 : 0, outTransfer === 'linear' ? 1 : outTransfer === 'pq' ? 2 : 0, whiteNits / 10000,
        m[0], m[1], m[2], sourceIsFloat ? 1 : 0,
        m[3], m[4], m[5], straight && convert ? 1 : 0,
        m[6], m[7], m[8], 0,
      ]);
      const ubo = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ubo, 0, raw);
      // with sub-frames the pass reads the sum (it ends up in the texture the last sub-frame was written to)
      const passSource = sub > 1 ? accTex[(sub - 1) % 2] : elementTex;
      bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: passSource.createView() }, { binding: 1, resource: { buffer: ubo } }] });
    }

    // the call that fills the texture: the one place the roads and the dialects differ
    // (measured in both dialects: without premultipliedAlpha the texture gets STRAIGHT alpha)
    copyElement = road === 'webgl2-float-hook' ? () => readHook() : road === 'external-copy'
      ? () => device.queue.copyExternalImageToTexture({ source: pageCanvas }, { texture: elementTex, premultipliedAlpha: wantPremultiplied }, [W, H])
      : dialect === 'chromium-150'
        ? () => device.queue.copyElementImageToTexture({ source: frame }, { destination: { texture: elementTex, premultipliedAlpha: wantPremultiplied } })
        : () => device.queue.drawElementImageToTexture({ source: frame }, { texture: elementTex, premultipliedAlpha: wantPremultiplied });
  }

  // ── the WebGPU canvas road: the page's own device reads its own canvas texture ──
  // Nothing can be re-laid out here (the canvas texture cannot be sampled), so its rows keep WebGPU's padding and
  // are copied out; a canvas whose width is a multiple of 64 pixels has no padding and is written as it is.
  const padW = Math.ceil(rowBytes / 256) * 256;
  if (road === 'webgpu-copy') {
    pageGpu.device.addEventListener('uncapturederror', (e) => { gpuError = gpuError || (e && e.error && e.error.message) || 'unknown WebGPU error'; });
  }

  // ── the WebGL2 road: objects of this loop's own inside the page's context ──
  let glResolve = null, glFlip = null, glFlipOnCpu = false, glScratch = null, glChecked = false;
  if (road === 'webgl2-readpixels') {
    // Two renderbuffers of the frame's size. The drawing buffer is blitted into the first as it is (that resolves
    // an antialiased buffer, which may not be flipped while it is resolved), and from there upside down into the
    // second, so that the rows come out top first. If this context refuses the blits (checked once, on the first
    // frame), the drawing buffer is read as it is and the rows are turned over on the CPU instead.
    const keepRb = gl.getParameter(gl.RENDERBUFFER_BINDING), keepDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const target = () => {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      return gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? fbo : null;
    };
    glResolve = target();
    glFlip = target();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, keepDraw);
    gl.bindRenderbuffer(gl.RENDERBUFFER, keepRb);
    if (!glResolve || !glFlip) glFlipOnCpu = true;
  }

  // ── the ring: one slot per frame in flight ──
  const ring = [];
  for (let k = 0; k < ringSize; k++) {
    if (road === 'webgl2-readpixels') {
      const keep = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, frameBytes, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, keep);
      ring.push({ pbo, sync: null });
    } else if (road === 'webgpu-copy') {
      ring.push({ buf: pageGpu.device.createBuffer({ size: padW * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) });
    } else {
      ring.push({ buf: device.createBuffer({ size: layoutW * bpp * layoutH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) });
    }
  }
  const free = [...ring];
  let wakeFree = null;
  const takeSlot = async () => {
    while (!free.length) await new Promise((resolve) => { wakeFree = resolve; });
    return free.pop();
  };
  const giveSlot = (slot) => { free.push(slot); if (wakeFree) { const w = wakeFree; wakeFree = null; w(); } };

  /**
   * The float hook road: the page's float framebuffer, read with readPixels FLOAT in the same task as the draw and
   * uploaded into the source texture (its bottom row first: the passes turn it over). Synchronous and therefore
   * slow, but exact: 32-bit floats, nothing clamped.
   */
  const readHook = () => {
    hookPixels = hookPixels || new Float32Array(W * H * 4);
    const keepPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const keepAlign = gl.getParameter(gl.PACK_ALIGNMENT), keepRowLen = gl.getParameter(gl.PACK_ROW_LENGTH);
    const keepSkipP = gl.getParameter(gl.PACK_SKIP_PIXELS), keepSkipR = gl.getParameter(gl.PACK_SKIP_ROWS);
    env.floatBind(hookName);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4); gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, hookPixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, keepPack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, keepAlign); gl.pixelStorei(gl.PACK_ROW_LENGTH, keepRowLen); gl.pixelStorei(gl.PACK_SKIP_PIXELS, keepSkipP); gl.pixelStorei(gl.PACK_SKIP_ROWS, keepSkipR);
    env.floatUnbind();
    device.queue.writeTexture({ texture: elementTex }, hookPixels, { bytesPerRow: W * 16, rowsPerImage: H }, [W, H]);
  };

  /** Motion blur: adds what is in the element texture as sub-frame k of the current frame. */
  const accumulate = (k) => {
    const j = k % 2;
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: accTex[j].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(accPipeline); pass.setBindGroup(0, k === 0 ? accGroups.first : accGroups.into[j]); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);
  };

  /** Element and external-copy roads: the pass (if any) and the copy into the slot's buffer, as one submission. */
  const submitOwn = (slot) => {
    const enc = device.createCommandEncoder();
    if (needPass) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: outTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
    }
    enc.copyTextureToBuffer({ texture: outTex }, { buffer: slot.buf, bytesPerRow: layoutW * bpp, rowsPerImage: layoutH }, [layoutW, layoutH]);
    device.queue.submit([enc.finish()]);
  };

  /** WebGPU canvas road: the canvas's current texture into the slot's buffer, on the page's device. */
  const submitPageGpu = (slot) => {
    const enc = pageGpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: pageGpu.context.getCurrentTexture() }, { buffer: slot.buf, bytesPerRow: padW, rowsPerImage: H }, [W, H]);
    pageGpu.device.queue.submit([enc.finish()]);
  };

  /**
   * WebGL2 road: the drawing buffer into the slot's pixel-pack buffer, and a fence behind it. Every piece of
   * context state touched is put back, so the page's renderer does not notice.
   */
  const kickGl = (slot) => {
    const keepRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), keepDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const keepPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const keepAlign = gl.getParameter(gl.PACK_ALIGNMENT), keepRowLen = gl.getParameter(gl.PACK_ROW_LENGTH);
    const keepSkipP = gl.getParameter(gl.PACK_SKIP_PIXELS), keepSkipR = gl.getParameter(gl.PACK_SKIP_ROWS);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (slot.sync) { gl.deleteSync(slot.sync); slot.sync = null; }

    // errors the page itself left behind are not this loop's: clear them before the one check below
    if (!glChecked && !glFlipOnCpu) { while (gl.getError() !== gl.NO_ERROR) { /* drop */ } }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (!glFlipOnCpu) {
      // drawing buffer -> first renderbuffer (resolve), first -> second upside down; a blit obeys the scissor,
      // so that is off for both
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, glResolve);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, glResolve);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, glFlip);
      gl.blitFramebuffer(0, 0, W, H, 0, H, W, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      if (!glChecked) {
        // once: did the context take the blits? (getError waits for the GPU process, so it is not asked per frame)
        glChecked = true;
        if (gl.getError() !== gl.NO_ERROR) glFlipOnCpu = true;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, glFlipOnCpu ? null : glFlip);
    }
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4); gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, keepPack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, keepAlign); gl.pixelStorei(gl.PACK_ROW_LENGTH, keepRowLen); gl.pixelStorei(gl.PACK_SKIP_PIXELS, keepSkipP); gl.pixelStorei(gl.PACK_SKIP_ROWS, keepSkipR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, keepRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, keepDraw);
    gl.flush();
  };

  // CPU buffers for the roads that must copy; reused, since a frame is tens of megabytes
  const pool = [];

  /**
   * Waits for the slot's pixels and gives them as { bytes, done }: bytes is the tightly packed frame, done() must
   * be called when it is no longer needed (it unmaps GPU memory or returns a buffer to the pool).
   */
  const collect = async (slot, times) => {
    const t0 = now();
    if (road === 'webgl2-readpixels') {
      // the fence is signalled once the GPU has finished the read; its state only moves between tasks
      for (;;) {
        const s = gl.clientWaitSync(slot.sync, 0, 0);
        if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED) break;
        if (s === gl.WAIT_FAILED) throw new Error('WebGL: waiting for the read of a frame failed (context lost?).');
        if (gl.isContextLost()) throw new Error('WebGL: the page\'s context was lost during the render.');
        await turn();
      }
      const t1 = now();
      const buf = pool.pop() || env.take(frameBytes);
      const keepPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      if (!glFlipOnCpu) gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf, 0, frameBytes);
      else {
        // bottom row first as GL has it: out into a scratch buffer, then row by row the other way up
        glScratch = glScratch || new Uint8Array(frameBytes);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, glScratch, 0, frameBytes);
        for (let y = 0; y < H; y++) buf.set(glScratch.subarray((H - 1 - y) * rowBytes, (H - y) * rowBytes), y * rowBytes);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, keepPack);
      gl.deleteSync(slot.sync); slot.sync = null;
      times.wait = t1 - t0; times.copyOut = now() - t1;
      return { bytes: buf.length === frameBytes ? buf : buf.subarray(0, frameBytes), done: () => pool.push(buf) };
    }

    await slot.buf.mapAsync(GPUMapMode.READ);
    const t1 = now();
    const mapped = new Uint8Array(slot.buf.getMappedRange());
    const padded = road === 'webgpu-copy' && padW !== rowBytes;
    if (!padded) {
      // the mapped memory is the frame itself: nothing is copied, it stays mapped until the frame is written
      times.wait = t1 - t0; times.copyOut = 0;
      return { bytes: mapped.subarray(0, frameBytes), done: () => slot.buf.unmap() };
    }
    const buf = pool.pop() || env.take(frameBytes);
    for (let y = 0; y < H; y++) buf.set(mapped.subarray(y * padW, y * padW + rowBytes), y * rowBytes);
    slot.buf.unmap();
    times.wait = t1 - t0; times.copyOut = now() - t1;
    return { bytes: buf.length === frameBytes ? buf : buf.subarray(0, frameBytes), done: () => pool.push(buf) };
  };

  /** One paint of the host canvas's children: resolves inside the 'paint' event, when the snapshot is current. */
  const painted = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no canvas "paint" event within 10 s: the page is not producing frames (a hidden or throttled renderer, or GPU compositing is off).')), 10000);
    canvas.addEventListener('paint', () => { clearTimeout(timer); resolve(); }, { once: true });
    canvas.requestPaint();
  });

  const T = { seek: [], paint: [], copy: [], copyGpu: [], submit: [], wait: [], copyOut: [], write: [], loop: [], probe: [] };
  const jobs = new Set();
  let jobError = null;
  let emptyFirst = false;
  const t0 = now();

  for (let i = 0; i < frames; i++) {
    if (gpuError) throw new Error(`WebGPU: ${gpuError}`);
    if (jobError) throw jobError;
    // a slot is free again only when its frame is written: this is what bounds the frames in flight
    const slot = await takeSlot();
    if (jobError) throw jobError;
    const tA = now();
    const t = cfg.from + i / cfg.fps;
    let msSeek = 0, msPaint = 0, msCopy = 0;

    // one turn for a plain frame; with sub-frames one turn per sample time, each added to the sum on the GPU
    for (let k = 0; k < sub; k++) {
      const tk = sub === 1 ? t : t + ((k + 0.5) / sub - 0.5) * shutter / cfg.fps;
      const t1 = now();
      let t2, t3;
      if (road === 'element') {
        // seek, then the paint that makes the snapshot show time tk, then snapshot -> texture
        if (seekName) await env.seek(seekName, tk);
        t2 = now();
        await painted();
        t3 = now();
        copyElement();
        if (cfg.profile && sub === 1) { await device.queue.onSubmittedWorkDone(); T.copyGpu.push(now() - t3); }
      } else {
        // Canvas roads: take the picture in the very same task as the draw. A WebGL canvas without
        // preserveDrawingBuffer (and a WebGPU canvas always) loses its picture once the browser has presented it,
        // so nothing may come between drawing and taking.
        const take = road === 'webgl2-readpixels' ? () => kickGl(slot) : road === 'webgpu-copy' ? () => submitPageGpu(slot) : copyElement;
        let taken = false, kind = 'sync';
        if (seekName) {
          const seeking = env.seek(seekName, tk);
          try { take(); taken = true; } catch (e) { taken = false; }
          kind = await seeking;
        }
        t2 = t3 = now();
        // a hook that returned a promise only finished drawing now: take (again) what the canvas holds
        if (!taken || kind === 'async') take();
        if (cfg.profile && device && sub === 1) { await device.queue.onSubmittedWorkDone(); T.copyGpu.push(now() - t3); }
      }
      if (sub > 1) accumulate(k);
      msSeek += t2 - t1; msPaint += t3 - t2; msCopy += now() - t3;
    }

    // the readback is started here and finished off the loop
    const tE = now();
    if (ownDevice) submitOwn(slot);
    const tF = now();

    const times = { wait: 0, copyOut: 0 };
    const job = (async () => {
      let held = null;
      try {
        held = await collect(slot, times);
        const bytes = held.bytes;
        // a first frame without a single covered pixel is nearly always a page that was not drawn at all
        if (i === 0) {
          // (alpha is the last of the pixel's four values; any set bit in it counts)
          let any = 0;
          const alphaAt = bpp - bpp / 4, alphaLen = bpp / 4;
          for (let stride = bpp * 97; stride >= bpp && !any; stride = stride === bpp ? 0 : bpp) {
            for (let k = alphaAt; k < frameBytes && !any; k += stride) for (let q = 0; q < alphaLen; q++) any |= bytes[k + q];
          }
          emptyFirst = !any;
        }
        // optional measurement: what one more hop for the frame would cost
        if (cfg.ipcProbe && env.probe) { const tI = now(); await env.probe(bytes); T.probe.push(now() - tI); }
        const tW = now();
        await env.write(i, bytes, W, H);
        T.write.push(now() - tW);
        T.wait.push(times.wait); T.copyOut.push(times.copyOut);
      } catch (e) {
        jobError = jobError || e;
      } finally {
        if (held) { try { held.done(); } catch (e) { jobError = jobError || e; } }
        jobs.delete(job);
        giveSlot(slot);
      }
    })();
    jobs.add(job);

    T.seek.push(msSeek); T.paint.push(msPaint); T.copy.push(msCopy); T.submit.push(tF - tE); T.loop.push(now() - tA);
    if (env.progress && ((i + 1) % 50 === 0 || i + 1 === frames)) env.progress(i + 1, frames);
  }

  // every frame written before the summary is made
  await Promise.all([...jobs]);
  if (jobError) throw jobError;
  if (gpuError) throw new Error(`WebGPU: ${gpuError}`);
  if (gl && gl.isContextLost()) throw new Error('WebGL: the page\'s context was lost during the render.');
  const total = now() - t0;

  return {
    tool: 'html_gpu_render', mode, road,
    page: cfg.page, width: cfg.width, height: cfg.height, dpr: cfg.dpr, pixels: [W, H], canvas: pageCanvas ? (cfg.canvas || 'canvas') : null,
    frames, fps: cfg.fps, from: cfg.from,
    format: cfg.format, alpha: bg && bg[3] === 1 ? 'opaque' : cfg.alpha, background: cfg.background || 'transparent',
    files: cfg.format === 'none' ? null : cfg.format === 'stream' ? 'frames.rgba' : `frame_%06d.${{ png: 'png', png16: 'png', exr: 'exr', raw16f: 'rgba16f', raw32f: 'rgba32f' }[cfg.format] || 'rgba'}`,
    layout: cfg.format === 'png' ? 'PNG, 8-bit RGBA' : cfg.format === 'png16' ? 'PNG, 16-bit RGBA (values 0..1 scaled to 0..65535, anything outside is clipped)'
      : cfg.format === 'exr' ? 'OpenEXR, half float RGBA, scanlines, no compression'
        : floatOut ? `raw RGBA, ${bpp * 2}-bit IEEE float per channel, little-endian, ${rowBytes} bytes per row, rows top to bottom, ${frameBytes} bytes per frame`
          : `raw RGBA, 8 bits per channel, ${rowBytes} bytes per row, rows top to bottom, ${frameBytes} bytes per frame`,
    bitDepth: floatOut ? (cfg.format === 'png16' ? 16 : bpp * 2) : 8, sampleType: floatOut && cfg.format !== 'png16' ? 'float' : 'unsigned integer',
    transfer: outTransfer, inputTransfer: inTransfer, primaries, converted: convert,
    valueScale: outTransfer === 'pq' ? `PQ (SMPTE ST 2084) code values; an input value of 1.0 is ${whiteNits} cd/m2` : '1.0 = the page\'s white (SDR reference white); float formats keep values above 1.0 and below 0',
    colour: floatOut ? `${outTransfer} transfer, ${primaries} primaries${convert ? ' (converted on the GPU)' : ' (the values as the page gave them)'}` : 'sRGB encoded values, as the browser composites them',
    sourceIsFloat,
    inflight: ringSize,
    subframes: sub, shutter: sub > 1 ? shutter : null, blurSpace: sub > 1 ? (blurLinear ? 'linear' : 'srgb') : null,
    sampleTimes: sub > 1 ? 't_k = T + ((k + 0.5) / subframes - 0.5) * shutter / fps, k = 0 .. subframes-1, T = from + i / fps' : 't = from + i / fps',
    readbackLayout: ownDevice ? (layoutW !== W ? `re-laid out on the GPU as ${layoutW} x ${layoutH}: no row padding, no copy` : 'rows already a multiple of 256 bytes: no padding, no copy')
      : road === 'webgpu-copy' ? (padW !== rowBytes ? `rows padded to ${padW} bytes by WebGPU: copied out row by row` : 'no padding, no copy')
        : (glFlipOnCpu ? 'one copy out of the pixel-pack buffer, rows turned over on the CPU' : 'one copy out of the pixel-pack buffer, rows turned over by a GPU blit'),
    adapter: adapterName, dialect: road === 'element' ? dialect : null, userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
    msTotal: Math.round(total), msPerFrame: Math.round((total / frames) * 100) / 100, framesPerSecond: Math.round((frames / (total / 1000)) * 10) / 10,
    // loop = what one frame costs the thread that drives the page; wait / copyOut / write run beside it
    ms: { seek: stat(T.seek), paint: stat(T.paint), copyCall: stat(T.copy), copyGpu: stat(T.copyGpu), submit: stat(T.submit), loop: stat(T.loop), readbackWait: stat(T.wait), copyOut: stat(T.copyOut), write: stat(T.write), extraHopProbe: stat(T.probe) },
    warnings: emptyFirst ? ['the first frame has no covered pixel at all: the page was probably not drawn (a cross-origin frame, a refused frame, or an empty page)'] : [],
  };
}

module.exports = { driver };
