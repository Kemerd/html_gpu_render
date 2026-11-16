/**
 * test/hdr.mjs: the float formats, called from test/run.mjs.
 *
 *   hdr-values    the page's values 0.5, 1, 2, 4, 8 arrive unclamped in raw32f, raw16f and exr (WebGPU float canvas)
 *   hdr-hook      the same through the WebGL2 float hook
 *   hdr-pq        linear -> PQ at 203 cd/m2 gives the ST 2084 code values, in raw32f and in a 16-bit PNG with cICP
 *   hdr-primaries linear sRGB -> Rec.2020 primaries is the BT.2087 matrix
 *   hdr-8bit      a float file of an 8-bit page, rounded to 8 bits, is the 8-bit file; element mode stays within 0..1
 *   hdr-blur      the sub-frame average is written at float precision (far finer than 1 of 255)
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { decodePng } = require('../src/png.cjs');
const { decodeExr } = require('../src/exr.cjs');

/** A half float's bits as a number. */
function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Frame i of a run as { get(x, y) -> [r, g, b, a] } in floats, whatever float format it was written in. */
function floatFrame(run, i) {
  const { W, H } = run, stem = resolve(run.dir, `frame_${String(i).padStart(6, '0')}`);
  const format = run.summary.format;
  if (format === 'raw32f') {
    const b = readFileSync(stem + '.rgba32f');
    const f = new Float32Array(b.buffer, b.byteOffset, W * H * 4);
    return { get: (x, y) => [0, 1, 2, 3].map((c) => f[(y * W + x) * 4 + c]) };
  }
  if (format === 'raw16f') {
    const b = readFileSync(stem + '.rgba16f');
    const u = new Uint16Array(b.buffer, b.byteOffset, W * H * 4);
    return { get: (x, y) => [0, 1, 2, 3].map((c) => half(u[(y * W + x) * 4 + c])) };
  }
  if (format === 'exr') {
    const e = decodeExr(readFileSync(stem + '.exr'));
    if (e.width !== W || e.height !== H) throw new Error(`the EXR is ${e.width} x ${e.height}, not ${W} x ${H}`);
    return { get: (x, y) => [0, 1, 2, 3].map((c) => half(e.data[(y * W + x) * 4 + c])) };
  }
  const p = decodePng(readFileSync(stem + '.png'));
  if (p.depth !== 16) throw new Error('the PNG is not 16-bit');
  return { cicp: p.cicp, get: (x, y) => [0, 1, 2, 3].map((c) => p.data[(y * W + x) * 4 + c] / 65535) };
}

// SMPTE ST 2084, and the sRGB curve, in double precision
const pq = (y) => { const p = Math.pow(y, 0.1593017578125); return Math.pow((0.8359375 + 18.8515625 * p) / (1 + 18.6875 * p), 78.84375); };
const BANDS = [0.5, 1, 2, 4, 8];

export async function hdrChecks({ check, must, shoot, page }) {
  // the centre of band k in the upper half (grey) and in the lower half (v, v/2, v/4)
  const probe = (run, k) => ({ x: Math.floor((run.W * (k + 0.5)) / 5), up: Math.floor(run.H * 0.25), down: Math.floor(run.H * 0.75) });
  const gpuPage = { page: page('hdr_webgpu.html'), query: 'bar=0', mode: 'canvas', ready: 'window.__ready', frames: 1, inputTransfer: 'linear' };

  await check('hdr-values', 'values above 1.0 arrive unclamped in the float formats', async () => {
    const out = [];
    for (const format of ['raw32f', 'raw16f', 'exr']) {
      const run = await shoot('hdr_' + format, { ...gpuPage, format });
      must(run.summary.sourceIsFloat === true, `${format}: the source was not taken as a float picture`);
      const f = floatFrame(run, 0);
      for (let k = 0; k < 5; k++) {
        const { x, up, down } = probe(run, k), v = BANDS[k];
        const a = f.get(x, up), b = f.get(x, down);
        must(a[0] === v && a[1] === v && a[2] === v && a[3] === 1, `${format}: band ${v}, upper half is ${a.join(' ')}`);
        must(b[0] === v && b[1] === v / 2 && b[2] === v / 4 && b[3] === 1, `${format}: band ${v}, lower half is ${b.join(' ')}`);
      }
      out.push(format);
    }
    return out.join(', ') + ': 0.5, 1, 2, 4, 8 exact';
  });

  await check('hdr-hook', 'the WebGL2 float hook gives the framebuffer\'s values', async () => {
    const run = await shoot('hdr_hook', { page: page('hdr_webgl.html'), mode: 'canvas', frames: 2, format: 'raw32f', inputTransfer: 'linear' });
    must(run.summary.road === 'webgl2-float-hook', `the hook road was not taken (${run.summary.road})`);
    const f = floatFrame(run, 1);
    for (let k = 0; k < 5; k++) {
      const { x, up, down } = probe(run, k), v = BANDS[k];
      const a = f.get(x, up), b = f.get(x, down);
      must(a[0] === v && a[1] === v && a[2] === v && a[3] === 1, `band ${v}, upper half is ${a.join(' ')} (rows upside down?)`);
      must(b[0] === v && b[1] === v / 2 && b[2] === v / 4, `band ${v}, lower half is ${b.join(' ')}`);
    }
    return 'road webgl2-float-hook, values exact, rows the right way up';
  });

  await check('hdr-pq', 'linear to PQ at 203 cd/m2 gives the ST 2084 code values', async () => {
    const out = [];
    for (const [format, tolerance] of [['raw32f', 2e-5], ['png16', 1.5 / 65535]]) {
      const run = await shoot('hdr_pq_' + format, { ...gpuPage, format, transfer: 'pq', primaries: 'rec2020', whiteNits: 203 });
      const f = floatFrame(run, 0);
      if (format === 'png16') must(f.cicp && f.cicp.join(',') === '9,16,0,1', `the cICP chunk is ${f.cicp}, expected 9,16,0,1 (Rec.2020, PQ, RGB, full range)`);
      let worst = 0;
      for (let k = 0; k < 5; k++) {
        // grey stays grey under a change of primaries, so the expectation is the curve alone
        const { x, up } = probe(run, k), want = pq((BANDS[k] * 203) / 10000);
        const got = f.get(x, up);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - want));
      }
      must(worst <= tolerance, `${format}: the PQ values are off by ${worst}`);
      out.push(`${format}: max error ${worst.toExponential(1)}`);
    }
    return out.join('; ') + `; 1.0 -> ${pq(203 / 10000).toFixed(4)}, 8.0 -> ${pq((8 * 203) / 10000).toFixed(4)}`;
  });

  await check('hdr-primaries', 'linear sRGB to Rec.2020 primaries', async () => {
    const run = await shoot('hdr_2020', { ...gpuPage, format: 'raw32f', primaries: 'rec2020' });
    const f = floatFrame(run, 0);
    const M = [[0.6274039, 0.3292830, 0.0433131], [0.0690973, 0.9195404, 0.0113623], [0.0163914, 0.0880133, 0.8955953]];
    let worst = 0;
    for (let k = 0; k < 5; k++) {
      const { x, down } = probe(run, k), v = BANDS[k], src = [v, v / 2, v / 4];
      const got = f.get(x, down);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - (M[c][0] * src[0] + M[c][1] * src[1] + M[c][2] * src[2])) / v);
    }
    must(worst <= 1e-5, `the converted colours are off by ${worst} (relative)`);
    return `max relative error ${worst.toExponential(1)}`;
  });

  await check('hdr-8bit', 'a float file of an 8-bit page is the 8-bit file; element mode stays within 0..1', async () => {
    const out = [];
    for (const [label, options] of [['element', { page: page('page.html') }], ['canvas (WebGL2)', { page: page('canvas.html'), mode: 'canvas' }]]) {
      const bytes = (await shoot('eight_raw', { ...options, frames: 1, format: 'raw' })).frame(0);
      const run = await shoot('eight_f32', { ...options, frames: 1, format: 'raw32f' });
      const b = readFileSync(resolve(run.dir, 'frame_000000.rgba32f'));
      const f = new Float32Array(b.buffer, b.byteOffset, run.W * run.H * 4);
      let differ = 0, max = 0;
      for (let i = 0; i < f.length; i++) { if (Math.round(f[i] * 255) !== bytes[i]) differ++; if (f[i] > max) max = f[i]; }
      must(differ === 0, `${label}: ${differ} values of the float file do not round to the 8-bit file`);
      must(max <= 1, `${label}: a value of ${max} in a picture that is 8-bit`);
      out.push(`${label}: identical, max value ${max}`);
    }
    return out.join('; ');
  });

  await check('hdr-blur', 'the sub-frame average is written at float precision', async () => {
    const n = 8, shutter = 0.5, T = 1.1, fps = 30;
    const options = { page: page('motion.html') };
    const parts = await shoot('fblur_parts', { ...options, frames: n, format: 'raw', fps: (n * fps) / shutter, from: T - shutter / (2 * fps) + shutter / (2 * n * fps) });
    const frames = [];
    for (let k = 0; k < n; k++) frames.push(parts.frame(k));
    const run = await shoot('fblur_gpu', { ...options, frames: 1, format: 'raw32f', from: T, subframes: n, shutter, blurSpace: 'srgb' });
    const b = readFileSync(resolve(run.dir, 'frame_000000.rgba32f'));
    const f = new Float32Array(b.buffer, b.byteOffset, run.W * run.H * 4);
    // the plain mean of the encoded, premultiplied bytes, in double precision
    let worst = 0, between = 0;
    for (let i = 0; i < f.length; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += frames[k][i];
      const want = sum / n / 255;
      const d = Math.abs(f[i] - want);
      if (d > worst) worst = d;
      // a value that no 8-bit file could hold
      if (sum % n !== 0) between++;
    }
    must(worst <= 1e-6, `the float average is ${worst} away from the mean of the sub-frames`);
    must(between > 0, 'no value lies between two 8-bit steps: the page did not move');
    return `max error ${worst.toExponential(1)} (1 of 255 is 3.9e-3); ${between} values lie between 8-bit steps`;
  });
}
