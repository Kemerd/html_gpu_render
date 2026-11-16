/**
 * index.mjs: the programmatic entry of html_gpu_render.
 *
 *   import { render } from './src/index.mjs';
 *   const summary = await render({ page: 'demo/page.html', out: 'out/demo', width: 1720, height: 720, dpr: 2, frames: 200, fps: 60 });
 *
 * render() starts one hidden Electron process (or, with `browser`, one headless browser), waits for it and gives back the summary (the same object that is
 * written to <out>/render.json). It rejects with the tool's error message when the run fails.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every option with its default. The CLI's flags are these names. */
export const DEFAULTS = Object.freeze({
  page: null,                 // file path or http(s) URL of the page
  mode: 'element',            // 'element' (HTML-in-Canvas, the whole page) | 'canvas' (read one <canvas> straight back) | 'screenshot' (the baseline)
  canvas: null,               // canvas mode: CSS selector of the canvas in the page (default: the first <canvas>)
  out: 'out',                 // folder for the frames and render.json
  width: 1920,                // viewport, CSS pixels
  height: 1080,
  dpr: 1,                     // device scale factor: the frames are width*dpr x height*dpr pixels
  frames: 1,                  // how many frames
  fps: 60,                    // frame i shows time  from + i / fps
  from: 0,                    // seconds
  format: 'raw',              // 8-bit: 'raw' (one .rgba per frame) | 'png' | 'stream' (one frames.rgba) | 'none' (timing only); float: 'raw16f' | 'raw32f' | 'exr' | 'png16'
  inputTransfer: 'srgb',      // float formats: what the page's values are, 'srgb' (encoded) or 'linear'
  transfer: null,             // float formats: what is written, 'srgb' | 'linear' | 'pq' (default: as the input; 'linear' for exr)
  primaries: 'srgb',          // float formats: the primaries written, 'srgb' | 'p3' | 'rec2020' (the input is taken as sRGB / Rec.709)
  whiteNits: 203,             // transfer pq: the luminance of the value 1.0 in cd/m2 (203 = the HDR reference white of BT.2408)
  floatHook: '__hgrFloatSource', // canvas mode, float formats: the page function that names a WebGL2 float framebuffer
  alpha: null,                // 'premultiplied' | 'straight'; default: straight for png, premultiplied otherwise
  background: 'transparent',  // 'transparent' or #rrggbb[aa]: composite the page over this colour on the GPU
  seek: '__seek',             // name of the page's hook window.<name>(t), or 'none'
  ready: null,                // a JS expression evaluated in the page; the render starts when it is truthy
  wait: 0,                    // extra milliseconds to wait before the first frame
  timeout: 60,                // seconds allowed for loading and for --ready
  root: null,                 // folder served as '/' for a local page (default: the page's folder)
  query: null,                // query string added to a local page's URL
  colorScheme: null,          // 'dark' / 'light': set it when the page declares a color-scheme, to keep transparency
  subframes: 1,               // motion blur: sub-frames per output frame, summed on the GPU (1 = off)
  shutter: 0.5,               // the open part of the frame interval the sub-frames are spread over (0.5 = 180 degrees)
  blurSpace: 'linear',        // 'linear': sum in linear light (decode sRGB first); 'srgb': sum the encoded values
  inflight: 8,                // how many frames may be between drawn and written at once (the ring of readback buffers)
  writers: null,              // older name of inflight
  canvasRoad: 'auto',         // canvas mode: 'copy' = copyExternalImageToTexture + mapAsync; 'direct' = readPixels (WebGL2) or the canvas's own texture (WebGPU); 'auto' = the fastest measured for the canvas's kind
  fsync: false,               // flush every frame to the device before it counts as written (slower: shows the device's own speed)
  preallocate: false,         // stream format: give frames.rgba its full size before the first frame
  pngLevel: 1,                // zlib level for png
  vsync: false,               // true: let the display's refresh rate pace the frames (slower, never needed)
  profile: false,             // measure the GPU time of element -> texture separately (adds a wait per frame)
  ipcProbe: false,            // also time sending each frame to the main process (measurement only)
  priority: 'normal',         // 'low': run the whole process tree below normal priority
  verbose: false,
  electron: null,             // path of the Electron binary (default: $ELECTRON_BIN, then an installed 'electron' package)
  browser: null,              // path of a Chrome / Edge / Chromium executable: use the browser backend instead of Electron
  switches: [],               // extra Chromium switches, "name" or "name=value"
});

/** Finds the Electron binary: the option, then ELECTRON_BIN, then an 'electron' package near the caller or this file. */
export function findElectron(given) {
  const named = given || process.env.ELECTRON_BIN;
  if (named) {
    if (!existsSync(named)) throw new Error(`the Electron binary does not exist: ${named}`);
    return resolve(named);
  }
  for (const base of [resolve(process.cwd(), 'noop.js'), resolve(HERE, 'noop.js')]) {
    try {
      // the 'electron' package exports the path of its binary when it is required from Node
      const found = createRequire(base)('electron');
      if (typeof found === 'string' && existsSync(found)) return found;
    } catch { /* not installed there */ }
  }
  throw new Error('no Electron binary. Set ELECTRON_BIN (or pass --electron) to an electron executable whose Chromium has HTML-in-Canvas (Electron 43 / Chromium 150 is known to work), or install the "electron" package.');
}

/** Checks the options and fills in the defaults. Throws with a plain message on a bad value. */
export function normalise(options) {
  const o = { ...DEFAULTS, ...(options || {}) };
  if (!o.page) throw new Error('no page: give a file path or an http(s) URL.');
  if (o.writers !== null && o.writers !== undefined) o.inflight = o.writers;
  delete o.writers;
  for (const key of ['width', 'height', 'dpr', 'frames', 'fps', 'from', 'wait', 'timeout', 'inflight', 'pngLevel', 'subframes', 'shutter']) {
    o[key] = Number(o[key]);
    if (!Number.isFinite(o[key])) throw new Error(`--${key} must be a number.`);
  }
  if (!(o.width >= 1 && o.height >= 1)) throw new Error('--width and --height must be at least 1.');
  if (!(o.dpr > 0 && o.dpr <= 8)) throw new Error('--dpr must be above 0 and at most 8.');
  if (!Number.isInteger(o.width) || !Number.isInteger(o.height)) throw new Error('--width and --height are whole CSS pixels.');
  if (!(o.frames >= 1) || !Number.isInteger(o.frames)) throw new Error('--frames must be a whole number, at least 1.');
  if (!(o.fps > 0)) throw new Error('--fps must be above 0.');
  if (!['element', 'canvas', 'screenshot'].includes(o.mode)) throw new Error('--mode takes one of: element, canvas, screenshot.');
  if (!Number.isInteger(o.subframes) || o.subframes < 1 || o.subframes > 256) throw new Error('--subframes must be a whole number from 1 to 256.');
  if (!(o.shutter >= 0 && o.shutter <= 1)) throw new Error('--shutter must be from 0 to 1 (0.5 = 180 degrees).');
  if (!['linear', 'srgb'].includes(o.blurSpace)) throw new Error('--blur-space takes one of: linear, srgb.');
  if (o.subframes > 1 && o.mode === 'screenshot') throw new Error('--subframes needs --mode element or canvas: a screenshot cannot be summed on the GPU.');
  const FLOAT_FORMATS = ['raw16f', 'raw32f', 'exr', 'png16'];
  if (![ 'raw', 'png', 'stream', 'none', ...FLOAT_FORMATS].includes(o.format)) throw new Error('--format takes one of: raw, png, stream, none, raw16f, raw32f, exr, png16.');
  const float = FLOAT_FORMATS.includes(o.format);
  if (float && o.mode === 'screenshot') throw new Error(`--format ${o.format} needs --mode element or canvas: a screenshot is an 8-bit PNG.`);
  if (!['srgb', 'linear'].includes(o.inputTransfer)) throw new Error('--input-transfer takes one of: srgb, linear.');
  if (o.transfer === 'hlg') throw new Error('--transfer hlg is not implemented; use pq, linear or srgb.');
  if (o.transfer !== null && !['srgb', 'linear', 'pq'].includes(o.transfer)) throw new Error('--transfer takes one of: srgb, linear, pq.');
  if (!['srgb', 'p3', 'rec2020'].includes(o.primaries)) throw new Error('--primaries takes one of: srgb, p3, rec2020.');
  if (!float && (o.transfer !== null || o.primaries !== 'srgb' || o.inputTransfer !== 'srgb')) throw new Error('--transfer, --input-transfer and --primaries need a float format (raw16f, raw32f, exr, png16): the 8-bit formats are written as the browser has them.');
  if (float && o.transfer === null) o.transfer = o.format === 'exr' ? 'linear' : o.inputTransfer;
  o.whiteNits = Number(o.whiteNits);
  if (!(o.whiteNits > 0 && o.whiteNits <= 10000)) throw new Error('--white-nits must be above 0 and at most 10000.');
  o.alpha = o.alpha || (o.format === 'png' || o.format === 'png16' ? 'straight' : 'premultiplied');
  if (!['premultiplied', 'straight'].includes(o.alpha)) throw new Error('--alpha takes one of: premultiplied, straight.');
  if (!['normal', 'low'].includes(o.priority)) throw new Error('--priority takes one of: normal, low.');
  o.inflight = Math.max(1, Math.min(16, Math.round(o.inflight)));
  if (!['auto', 'copy', 'direct'].includes(o.canvasRoad)) throw new Error('--canvas-road takes one of: auto, copy, direct.');
  o.pngLevel = Math.max(0, Math.min(9, Math.round(o.pngLevel)));
  o.out = resolve(String(o.out));
  if (!/^https?:\/\//i.test(o.page)) o.page = resolve(String(o.page).replace(/^file:\/\/\/?/i, ''));
  if (o.root) o.root = resolve(String(o.root));
  o.switches = Array.isArray(o.switches) ? o.switches.map(String) : [];
  return o;
}

/**
 * Renders the frames.
 * @param {object} options   see DEFAULTS
 * @param {{ onLine?: (line: string) => void }} [hooks]   onLine gets every line the Electron process prints
 * @returns {Promise<object>} the summary (also in <out>/render.json)
 */
export function render(options, hooks = {}) {
  let o, electron = null;
  try { o = normalise(options); if (!o.browser) electron = findElectron(o.electron); }
  catch (e) { return Promise.reject(e); }

  // below normal priority is inherited by every process Electron starts, so it is set on this one first
  if (o.priority === 'low') { try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: carry on */ } }

  // file writes run on Node's thread pool inside Electron: one thread per frame in flight, at least the usual four
  const env = { ...process.env, HGR_CONFIG: JSON.stringify(o), UV_THREADPOOL_SIZE: String(Math.max(4, o.inflight)) };
  delete env.ELECTRON_RUN_AS_NODE;                      // with it set, Electron would start as plain Node
  const onLine = typeof hooks.onLine === 'function' ? hooks.onLine : (line) => console.log(line);

  // the browser backend runs the loop in a headless browser from this process (src/browser.mjs)
  if (o.browser) return import('./browser.mjs').then((m) => m.renderInBrowser(o, o.browser, onLine));

  return new Promise((res, rej) => {
    const child = spawn(electron, [resolve(HERE, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let lastError = null;
    const take = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = /\[html_gpu_render\] ERROR: (.*)$/.exec(line);
        if (m) lastError = m[1];
        // Chromium's own log lines are only of interest when asked for
        if (/^\[html_gpu_render\]|^\[page\]/.test(line) || o.verbose) onLine(line);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => rej(new Error(`could not start Electron (${electron}): ${e.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) return rej(new Error(lastError || `Electron exited with code ${code} before the frames were done.`));
      try { res(JSON.parse(readFileSync(resolve(o.out, 'render.json'), 'utf8'))); }
      catch (e) { rej(new Error(`the run ended without a readable render.json in ${o.out}: ${e.message}`)); }
    });
  });
}
