/**
 * bench.mjs: the timing table of the README, measured on this machine.
 *
 *   node tools/bench.mjs [--frames 60] [--width 1720 --height 720 --dpr 2] [--browser <chrome or edge exe>] [--keep]
 *
 * Renders the demo pages a number of times, one run after the other (never two at once), each into its own folder
 * under out/bench/, and prints ms per frame for every run and every stage (loop = the thread that drives the page; readback wait,
 * copy out and write run beside it, several frames at once). Frame folders are deleted after each run
 * unless --keep is given: 200 raw frames of 3440 x 1440 are 4 GB. Every finished run is also appended at once to
 * out/bench_results.txt (one JSON line per run), so a sweep that is stopped half way still leaves its numbers.
 *
 * Runs, on the Electron backend and (with --browser) on the browser backend:
 *   mode element     demo/page.html     no write, raw files, one raw stream, png, raw over a colour, profiled
 *   mode canvas      demo/canvas.html (WebGL2) and demo/canvas_webgpu.html, by both roads: raw files, png
 *   mode screenshot  both pages         png as the browser encodes it, and not written at all
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const keep = args.includes('--keep');
const browser = opt('--browser');
const base = { width: Number(opt('--width', 1720)), height: Number(opt('--height', 720)), dpr: Number(opt('--dpr', 2)), frames: Number(opt('--frames', 60)), fps: 60, priority: 'low' };
const PAGE = resolve(ROOT, 'demo/page.html'), CANVAS = resolve(ROOT, 'demo/canvas.html'), CANVAS_GPU = resolve(ROOT, 'demo/canvas_webgpu.html');

const rows = [];
const RESULTS = resolve(ROOT, 'out/bench_results.txt');
mkdirSync(resolve(ROOT, 'out'), { recursive: true });
/** Keeps a finished run: in the table printed at the end, and at once in out/bench_results.txt. */
const keepRow = (row) => { rows.push(row); appendFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), frames: base.frames, ...row }) + String.fromCharCode(10)); };
const m = (s) => (s ? s.mean.toFixed(2) : '-');

/** One render through the tool; its frames are removed again unless --keep. */
async function run(label, extra) {
  console.error(`running: ${label}`);
  const out = resolve(ROOT, 'out/bench', label.replace(/[^a-z0-9]+/gi, '_'));
  try {
    const s = await render({ ...base, ...extra, out }, { onLine: () => {} });
    keepRow({ label, road: s.road || s.mode, perFrame: s.msPerFrame.toFixed(2), fps: s.framesPerSecond.toFixed(1), seek: m(s.ms.seek), paint: m(s.ms.paint), copyCall: m(s.ms.copyCall), copyGpu: m(s.ms.copyGpu), loop: m(s.ms.loop), wait: m(s.ms.readbackWait), copyOut: m(s.ms.copyOut), capture: m(s.ms.capture), write: m(s.ms.write), hop: m(s.ms.extraHopProbe) });
  } catch (e) {
    keepRow({ label, perFrame: 'FAILED: ' + e.message });
  }
  if (!keep) rmSync(out, { recursive: true, force: true });
}

for (const [name, extra] of [['electron', {}], ...(browser ? [['browser', { browser }]] : [])]) {
  await run(`${name} element, no write`, { ...extra, page: PAGE, format: 'none' });
  await run(`${name} element, raw files`, { ...extra, page: PAGE, format: 'raw' });
  await run(`${name} element, one raw stream`, { ...extra, page: PAGE, format: 'stream' });
  await run(`${name} element, png level 1`, { ...extra, page: PAGE, format: 'png' });
  await run(`${name} element, raw, over #000000`, { ...extra, page: PAGE, format: 'raw', background: '#000000' });
  if (name === 'electron') await run(`${name} element, raw, profiled + IPC probe`, { ...extra, page: PAGE, format: 'raw', profile: true, ipcProbe: true });
  await run(`${name} canvas (WebGL2), no write`, { ...extra, page: CANVAS, mode: 'canvas', format: 'none' });
  await run(`${name} canvas (WebGL2), raw files`, { ...extra, page: CANVAS, mode: 'canvas', format: 'raw' });
  await run(`${name} canvas (WebGL2), direct road, raw files`, { ...extra, page: CANVAS, mode: 'canvas', canvasRoad: 'direct', format: 'raw' });
  await run(`${name} canvas (WebGPU), raw files`, { ...extra, page: CANVAS_GPU, mode: 'canvas', ready: 'window.__ready', format: 'raw' });
  await run(`${name} canvas (WebGPU), copy road, raw files`, { ...extra, page: CANVAS_GPU, mode: 'canvas', ready: 'window.__ready', canvasRoad: 'copy', format: 'raw' });
  await run(`${name} canvas (WebGL2), png level 1`, { ...extra, page: CANVAS, mode: 'canvas', format: 'png' });
  await run(`${name} screenshot of page.html, png`, { ...extra, page: PAGE, mode: 'screenshot', format: 'png' });
  await run(`${name} screenshot of page.html, no write`, { ...extra, page: PAGE, mode: 'screenshot', format: 'none' });
  await run(`${name} screenshot of canvas.html, png`, { ...extra, page: CANVAS, mode: 'screenshot', format: 'png' });
}

// the table: ms per frame (means), one row per run
const cols = [['label', 'run'], ['road', 'road'], ['perFrame', 'ms/frame'], ['fps', 'frames/s'], ['seek', 'seek'], ['paint', 'paint'], ['copyCall', 'copy call'], ['copyGpu', 'copy GPU'], ['loop', 'loop'], ['wait', 'readback wait'], ['copyOut', 'copy out'], ['capture', 'capture'], ['write', 'write'], ['hop', 'IPC hop']];
const width = (k, h) => Math.max(h.length, ...rows.map((r) => String(r[k] ?? '-').length));
console.log(`\n${base.frames} frames of ${Math.round(base.width * base.dpr)} x ${Math.round(base.height * base.dpr)} (${base.width} x ${base.height} CSS px at device scale ${base.dpr}), milliseconds (means)\n`);
console.log(cols.map(([k, h]) => h.padEnd(width(k, h))).join('  '));
for (const r of rows) console.log(cols.map(([k, h]) => String(r[k] ?? '-').padEnd(width(k, h))).join('  '));
