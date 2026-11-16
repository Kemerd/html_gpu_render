/**
 * screenshot.cjs: capture mode 'screenshot', the usual way and the baseline the other two modes are measured
 * against. The page is loaded directly (no host document, no canvas) and every frame is one DevTools call
 * Page.captureScreenshot (png, optimizeForSpeed): the browser composites the page, encodes a PNG, base64-encodes
 * it and sends it over the DevTools connection.
 *
 * Both backends use this loop; `io` is what differs:
 *   send(method, params) -> Promise      a DevTools protocol command for the page
 *   evaluate(expression) -> Promise      run JavaScript in the page, awaited
 *   progress(done, of)                   (optional)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { makeSink, frameName } = require('./sink.cjs');
const { decodePng } = require('./png.cjs');

/** mean / median / p95 / max of a list of milliseconds, rounded to 0.01 ms. */
function stat(list) {
  if (!list || !list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const r = (v) => Math.round(v * 100) / 100;
  return { mean: r(s.reduce((a, b) => a + b, 0) / s.length), median: r(s[s.length >> 1]), p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: r(s[s.length - 1]), n: s.length };
}

/** The DevTools colour for --background: transparent, or the colour itself. */
function backgroundColour(text) {
  if (!text || text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  let h = String(text).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`--background: "${text}" is not transparent, #rgb, #rrggbb or #rrggbbaa`);
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/**
 * The whole render in screenshot mode. The page must already be loaded and the device metrics set.
 * @returns {Promise<object>} the summary (the caller adds what it knows and writes render.json)
 */
async function screenshotLoop(cfg, io) {
  const W = Math.round(cfg.width * cfg.dpr), H = Math.round(cfg.height * cfg.dpr);
  const frames = Math.max(1, cfg.frames | 0);
  const seekName = cfg.seek && cfg.seek !== 'none' ? String(cfg.seek) : null;

  // the same preparations as the other modes: the hook, the faces, the caller's ready condition
  if (seekName && !(await io.evaluate(`typeof window[${JSON.stringify(seekName)}] === 'function'`))) {
    throw new Error(`the page has no function window.${seekName}(t). Define it (it sets the page to time t in seconds), name another with --seek <name>, or pass --seek none for a page that does not move.`);
  }
  await io.evaluate('document.fonts.ready.then(() => true)');
  if (cfg.ready) {
    const until = Date.now() + cfg.timeout * 1000;
    while (!(await io.evaluate(`!!(${cfg.ready})`))) {
      if (Date.now() > until) throw new Error(`--ready "${cfg.ready}" did not become true within ${cfg.timeout} s.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (cfg.wait > 0) await new Promise((r) => setTimeout(r, cfg.wait));
  await io.send('Emulation.setDefaultBackgroundColorOverride', { color: backgroundColour(cfg.background) });

  // png frames are written as the browser made them; raw frames are decoded first (slow: this mode is the baseline)
  const png = cfg.format === 'png';
  if (png) fs.mkdirSync(cfg.out, { recursive: true });
  const sink = png ? null : await makeSink({ out: cfg.out, format: cfg.format, width: W, height: H, frames, pngLevel: cfg.pngLevel, fsync: cfg.fsync, preallocate: cfg.preallocate });

  const T = { seek: [], capture: [], write: [] };
  const t0 = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      const a = performance.now();
      if (seekName) await io.evaluate(`window[${JSON.stringify(seekName)}](${cfg.from + i / cfg.fps})`);
      const b = performance.now();
      // a capture that never answers must end the run with a message, not hang it (seen with headless browsers)
      let timer = null;
      const shot = await Promise.race([
        io.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Page.captureScreenshot did not answer within 30 s (frame ${i}): the browser stopped producing frames.`)), 30000); }),
      ]);
      clearTimeout(timer);
      const c = performance.now();
      const bytes = Buffer.from(shot.data, 'base64');
      if (png) fs.writeFileSync(path.join(cfg.out, frameName(i, 'png')), bytes);
      else if (cfg.format !== 'none') {
        const picture = decodePng(bytes);
        if (picture.width !== W || picture.height !== H) throw new Error(`the screenshot is ${picture.width} x ${picture.height}, not ${W} x ${H}`);
        await sink.write(i, picture.data);
      }
      T.seek.push(b - a); T.capture.push(c - b); T.write.push(performance.now() - c);
      if (io.progress && ((i + 1) % 50 === 0 || i + 1 === frames)) io.progress(i + 1, frames);
    }
  } finally {
    if (sink) await sink.close();
  }
  const total = performance.now() - t0;

  return {
    tool: 'html_gpu_render', mode: 'screenshot',
    page: cfg.page, width: cfg.width, height: cfg.height, dpr: cfg.dpr, pixels: [W, H], canvas: null,
    frames, fps: cfg.fps, from: cfg.from,
    format: cfg.format, alpha: backgroundColour(cfg.background).a === 1 ? 'opaque' : 'straight', background: cfg.background || 'transparent',
    files: cfg.format === 'stream' ? 'frames.rgba' : cfg.format === 'none' ? null : `frame_%06d.${png ? 'png' : 'rgba'}`,
    layout: png ? 'PNG as the browser encoded it' : `raw RGBA, 8 bits per channel, ${W * 4} bytes per row, rows top to bottom, ${W * H * 4} bytes per frame`,
    colour: 'sRGB encoded values, as the browser composites them',
    msTotal: Math.round(total), msPerFrame: Math.round((total / frames) * 100) / 100, framesPerSecond: Math.round((frames / (total / 1000)) * 10) / 10,
    ms: { seek: stat(T.seek), capture: stat(T.capture), write: stat(T.write) },
    warnings: [],
  };
}

module.exports = { screenshotLoop, backgroundColour };
