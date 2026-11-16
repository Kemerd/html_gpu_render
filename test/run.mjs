/**
 * test/run.mjs: the invariants this project claims, checked by rendering the demo pages.  `npm test`
 *
 *   node test/run.mjs [--dpr 1] [--only <word>] [--keep]
 *
 * Needs an Electron binary (ELECTRON_BIN, or an installed "electron" package), as the tool itself does. Every run
 * is hidden, short, and one after the other. Frames go to out/test/ and are removed again (unless --keep).
 * The size is 1720 x 720 CSS px at --dpr (default 1; the numbers in the README were checked with --dpr 2).
 *
 * Checks:
 *   order        frames are identical with 1 frame in flight and with 8
 *   roads        the canvas roads (copy, direct) give identical frames, for a WebGL2 and for a WebGPU canvas
 *   formats      raw, stream and png hold the same pixels
 *   blur-n1      --subframes 1 is today's plain render, bit for bit
 *   blur-still   a still page gives the same picture with any number of sub-frames (within 1 of 255)
 *   blur-average the GPU average equals the average of the sub-frames rendered one by one (linear and srgb)
 *   blur-streak  a square moving at a known speed leaves a streak of the expected length (shutter 0.5 and 1.0)
 *   hdr          values above 1.0 drawn by the page arrive in the float formats unclamped (see test/hdr.mjs)
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const { decodePng } = require('../src/png.cjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const only = opt('--only');
const keep = args.includes('--keep');
const base = { width: 1720, height: 720, dpr: Number(opt('--dpr', 1)), fps: 30, priority: 'low' };
const page = (name) => resolve(ROOT, 'demo', name);

let failed = 0, passed = 0;
const made = [];

/** One render into out/test/<name>; gives the summary plus a reader for its frames. */
async function shoot(name, options) {
  const out = resolve(ROOT, 'out/test', name);
  rmSync(out, { recursive: true, force: true });
  made.push(out);
  const summary = await render({ ...base, ...options, out }, { onLine: () => {} });
  const [W, H] = summary.pixels;
  return {
    summary, W, H, dir: out,
    /** Frame i as RGBA bytes, whatever the format. */
    frame(i) {
      const stem = resolve(out, `frame_${String(i).padStart(6, '0')}`);
      if (summary.format === 'png') return decodePng(readFileSync(stem + '.png')).data;
      if (summary.format === 'stream') return readFileSync(resolve(out, 'frames.rgba')).subarray(i * W * H * 4, (i + 1) * W * H * 4);
      return readFileSync(stem + '.rgba');
    },
  };
}

/** The largest difference between two byte pictures, and how many bytes differ. */
function diff(a, b) {
  if (a.length !== b.length) return { max: 255, count: Math.abs(a.length - b.length) };
  let max = 0, count = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { count++; if (d > max) max = d; } }
  return { max, count };
}

/** Runs one named check; a thrown error or a false result is a failure. */
async function check(name, what, fn) {
  if (only && !name.includes(only)) return;
  const began = Date.now();
  try {
    const detail = await fn();
    passed++;
    console.log(`ok    ${name.padEnd(13)} ${what}${detail ? '  [' + detail + ']' : ''}  (${((Date.now() - began) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name.padEnd(13)} ${what}\n      ${String((e && e.message) || e)}`);
  }
}
const must = (condition, message) => { if (!condition) throw new Error(message); };

// sRGB transfer, as the shaders have it
const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

await check('order', 'frames in flight do not change or reorder frames', async () => {
  const a = await shoot('order1', { page: page('motion.html'), frames: 12, format: 'raw', inflight: 1 });
  const b = await shoot('order8', { page: page('motion.html'), frames: 12, format: 'raw', inflight: 8 });
  for (let i = 0; i < 12; i++) must(diff(a.frame(i), b.frame(i)).max === 0, `frame ${i} differs between --inflight 1 and 8`);
  // and the frames are not all one picture: the page moves
  must(diff(a.frame(0), a.frame(5)).count > 1000, 'frames 0 and 5 are the same picture: the seek hook did nothing');
  return '12 frames identical';
});

await check('roads', 'canvas roads give identical frames', async () => {
  const out = [];
  for (const [label, file, extra] of [['WebGL2', 'canvas.html', {}], ['WebGPU', 'canvas_webgpu.html', { ready: 'window.__ready' }]]) {
    const copy = await shoot('road_copy', { page: page(file), mode: 'canvas', canvasRoad: 'copy', frames: 4, format: 'raw', ...extra });
    const direct = await shoot('road_direct', { page: page(file), mode: 'canvas', canvasRoad: 'direct', frames: 4, format: 'raw', ...extra });
    must(copy.summary.road === 'external-copy', `${label}: the copy road was not taken (${copy.summary.road})`);
    must(direct.summary.road !== 'external-copy', `${label}: the direct road was not taken`);
    for (let i = 0; i < 4; i++) must(diff(copy.frame(i), direct.frame(i)).max === 0, `${label}: frame ${i} differs between the roads`);
    out.push(`${label}: ${direct.summary.road} = external-copy`);
  }
  return out.join('; ');
});

await check('formats', 'raw, stream and png hold the same pixels', async () => {
  const raw = await shoot('fmt_raw', { page: page('page.html'), frames: 3, format: 'raw', alpha: 'straight' });
  const stream = await shoot('fmt_stream', { page: page('page.html'), frames: 3, format: 'stream', alpha: 'straight' });
  const png = await shoot('fmt_png', { page: page('page.html'), frames: 3, format: 'png' });
  for (let i = 0; i < 3; i++) {
    must(diff(raw.frame(i), stream.frame(i)).max === 0, `frame ${i}: raw and stream differ`);
    must(diff(raw.frame(i), png.frame(i)).max === 0, `frame ${i}: raw and png differ`);
  }
  return '3 frames, three formats';
});

await check('blur-n1', '--subframes 1 is the plain render, bit for bit', async () => {
  const out = [];
  for (const [label, options] of [['element', { page: page('motion.html') }], ['canvas', { page: page('canvas.html'), mode: 'canvas' }]]) {
    const plain = await shoot('n1_plain', { ...options, frames: 4, format: 'raw' });
    const one = await shoot('n1_sub', { ...options, frames: 4, format: 'raw', subframes: 1, shutter: 1 });
    for (let i = 0; i < 4; i++) must(diff(plain.frame(i), one.frame(i)).max === 0, `${label}: frame ${i} differs`);
    out.push(label);
  }
  return out.join(', ') + ': identical';
});

await check('blur-still', 'a still page is unchanged by sub-frames (within 1 of 255)', async () => {
  const out = [];
  for (const [label, options] of [['element', { page: page('motion.html'), query: 'still=1' }], ['canvas', { page: page('canvas.html'), mode: 'canvas', seek: 'none' }]]) {
    const one = await shoot('still_1', { ...options, frames: 1, format: 'raw' });
    for (const space of ['linear', 'srgb']) {
      for (const n of [4, 16]) {
        const many = await shoot('still_n', { ...options, frames: 1, format: 'raw', subframes: n, blurSpace: space });
        const d = diff(one.frame(0), many.frame(0));
        must(d.max <= 1, `${label}, ${space}, n = ${n}: differs by ${d.max}`);
        out.push(`${label} ${space} n=${n}: max ${d.max} (${d.count} bytes)`);
      }
    }
  }
  return out.join('; ');
});

await check('blur-average', 'the GPU average equals the average of the sub-frames rendered one by one', async () => {
  const out = [];
  const n = 8, shutter = 0.5, T = 1.1;
  for (const [label, options] of [['element', { page: page('motion.html') }], ['canvas', { page: page('canvas.html'), mode: 'canvas' }]]) {
    // the n sub-frames on their own: frame k of this run is at  T + ((k + 0.5) / n - 0.5) * shutter / fps
    const parts = await shoot('avg_parts', { ...options, frames: n, format: 'raw', fps: (n * base.fps) / shutter, from: T - shutter / (2 * base.fps) + shutter / (2 * n * base.fps) });
    const frames = [];
    for (let k = 0; k < n; k++) frames.push(parts.frame(k));
    const size = frames[0].length;
    for (const space of ['linear', 'srgb']) {
      const gpu = (await shoot('avg_gpu', { ...options, frames: 1, format: 'raw', from: T, subframes: n, shutter, blurSpace: space })).frame(0);
      // the same average on the CPU, of premultiplied values, in double precision
      let max = 0, over1 = 0;
      for (let p = 0; p < size; p += 4) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < n; k++) {
          const f = frames[k], fa = f[p + 3] / 255;
          if (space === 'linear') {
            if (fa > 0) { r += decode(Math.min(1, f[p] / 255 / fa)) * fa; g += decode(Math.min(1, f[p + 1] / 255 / fa)) * fa; b += decode(Math.min(1, f[p + 2] / 255 / fa)) * fa; }
          } else { r += f[p] / 255; g += f[p + 1] / 255; b += f[p + 2] / 255; }
          a += fa;
        }
        r /= n; g /= n; b /= n; a /= n;
        if (space === 'linear' && a > 0) { r = encode(Math.min(1, r / a)) * a; g = encode(Math.min(1, g / a)) * a; b = encode(Math.min(1, b / a)) * a; }
        const want = [r, g, b, a];
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(gpu[p + c] - want[c] * 255);
          if (d > max) max = d;
          if (d > 1) over1++;
        }
      }
      // 0.5 is the rounding to 8 bits itself; the rest is float32 against double
      must(max <= 1, `${label}, ${space}: the GPU frame is ${max.toFixed(3)} of 255 away from the CPU average (${over1} values beyond 1)`);
      out.push(`${label} ${space}: max ${max.toFixed(3)} of 255`);
    }
  }
  return out.join('; ');
});

await check('blur-streak', 'the streak of a moving square has the expected length', async () => {
  // demo/motion.html: a 40 px square at 2400 CSS px per second, alone on the rows 80..120
  const n = 16, speed = 2400, side = 40, T = 1.1;
  const out = [];
  for (const shutter of [0.5, 1.0]) {
    const run = await shoot('streak', { page: page('motion.html'), frames: 1, format: 'raw', from: T, subframes: n, shutter });
    const f = run.frame(0), dpr = base.dpr;
    // the extent of everything covered on the row through the middle of the square
    const y = Math.round(100 * dpr);
    let first = -1, last = -1, full = 0;
    for (let x = 0; x < run.W; x++) { const a = f[(y * run.W + x) * 4 + 3]; if (a > 0) { if (first < 0) first = x; last = x; } if (a === 255) full++; }
    const measured = (last - first + 1) / dpr;
    // the first and the last sample are (n - 1) / n of the open interval apart
    const expected = side + (speed * shutter / base.fps) * (n - 1) / n;
    must(Math.abs(measured - expected) <= 1.5, `shutter ${shutter}: streak ${measured} CSS px, expected ${expected}`);
    out.push(`shutter ${shutter}: ${measured} px measured, ${expected} expected`);
  }
  return out.join('; ');
});

// the float formats have their own file
if (existsSync(resolve(ROOT, 'test/hdr.mjs')) && (!only || 'hdr'.includes(only))) {
  const { hdrChecks } = await import('./hdr.mjs');
  await hdrChecks({ check, must, shoot, page, base, ROOT });
}

if (!keep) for (const dir of made) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
