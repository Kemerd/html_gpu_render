/**
 * compare.mjs: how far apart are two renders of the same frames?
 *
 *   node tools/compare.mjs <dirA> <dirB> [--frames 0,50,199 | 0-199] [--premultiply] [--diff <file.png>] [--quiet]
 *
 * Each folder holds frame_000000.png or frame_000000.rgba (a folder of .rgba needs its render.json for the size).
 * For every frame named, the two pictures are compared channel by channel (8-bit values):
 *   max        the largest difference of any channel of any pixel
 *   mean       the mean absolute difference over all channels of all pixels
 *   differing  how many pixels differ at all, and how many by more than 1 and more than 8
 *   box        the rectangle that holds every differing pixel
 * --premultiply multiplies RGB by alpha in both before comparing: the fair way to compare pictures with alpha,
 *               since the colour of a fully transparent pixel means nothing and that of a faint one is ill-defined.
 * --quiet       prints only the frames that differ, and a count of the identical ones.
 * --diff        writes a picture of the first frame's differences (white = same, darker = further apart, x32).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { decodePng, encodePng } = createRequire(import.meta.url)('../src/png.cjs');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dirs = args.filter((a, i) => !a.startsWith('--') && !['--frames', '--diff'].includes(args[i - 1]));
if (dirs.length !== 2) { console.error('usage: node tools/compare.mjs <dirA> <dirB> [--frames 0,50] [--premultiply] [--diff out.png]'); process.exit(2); }
// --frames 0,5,9  or  --frames 0-119  (both forms may be mixed)
const frames = (opt('--frames') || '0').split(',').flatMap((part) => {
  const m = /^(\d+)-(\d+)$/.exec(part.trim());
  if (!m) return [Number(part)];
  const list = [];
  for (let i = Number(m[1]); i <= Number(m[2]); i++) list.push(i);
  return list;
});
const quiet = args.includes('--quiet');
let identical = 0;
const premultiply = args.includes('--premultiply');

/** Loads frame i of a folder as { width, height, data } (RGBA). */
function load(dir, i) {
  const stem = resolve(dir, `frame_${String(i).padStart(6, '0')}`);
  if (existsSync(stem + '.png')) return decodePng(readFileSync(stem + '.png'));
  if (existsSync(stem + '.rgba')) {
    const meta = JSON.parse(readFileSync(resolve(dir, 'render.json'), 'utf8'));
    return { width: meta.pixels[0], height: meta.pixels[1], data: readFileSync(stem + '.rgba') };
  }
  throw new Error(`no frame ${i} in ${dir}`);
}

let worst = 0;
for (const i of frames) {
  const a = load(dirs[0], i), b = load(dirs[1], i);
  if (a.width !== b.width || a.height !== b.height) { console.log(`frame ${i}: sizes differ, ${a.width} x ${a.height} against ${b.width} x ${b.height}`); worst = 255; continue; }
  const n = a.width * a.height;
  const A = a.data, B = b.data;
  let max = 0, sum = 0, differing = 0, over1 = 0, over8 = 0, alphaMax = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  const diffPic = opt('--diff') && i === frames[0] ? Buffer.alloc(n * 4, 255) : null;
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    let d = 0;
    const aa = A[o + 3], ba = B[o + 3];
    for (let c = 0; c < 3; c++) {
      // with --premultiply both colours are weighted by their own alpha first
      const va = premultiply ? Math.round((A[o + c] * aa) / 255) : A[o + c];
      const vb = premultiply ? Math.round((B[o + c] * ba) / 255) : B[o + c];
      const e = Math.abs(va - vb);
      sum += e;
      if (e > d) d = e;
    }
    const ea = Math.abs(aa - ba);
    sum += ea;
    if (ea > alphaMax) alphaMax = ea;
    if (ea > d) d = ea;
    if (d) {
      differing++;
      if (d > 1) over1++;
      if (d > 8) over8++;
      if (d > max) max = d;
      const x = p % a.width, y = (p / a.width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (diffPic) { const v = Math.max(0, 255 - d * 32); diffPic[o] = v; diffPic[o + 1] = v; diffPic[o + 2] = v; }
    }
  }
  if (max > worst) worst = max;
  const pct = (v) => ((100 * v) / n).toFixed(3) + ' %';
  if (!differing) identical++;
  if (!quiet || differing) console.log(`frame ${i}: ${a.width} x ${a.height}${premultiply ? ' (premultiplied)' : ''}  max ${max}  mean ${(sum / (n * 4)).toFixed(5)}  alpha max ${alphaMax}  differing ${differing} (${pct(differing)}), >1: ${over1} (${pct(over1)}), >8: ${over8} (${pct(over8)})${differing ? `  box x ${x0}..${x1}, y ${y0}..${y1}` : '  identical'}`);
  if (diffPic) { writeFileSync(resolve(opt('--diff')), await encodePng(diffPic, a.width, a.height, 6)); console.log(`  differences of frame ${i} drawn in ${resolve(opt('--diff'))}`); }
}
if (quiet) console.log(`${identical} of ${frames.length} frames identical`);
process.exitCode = worst === 0 ? 0 : 3;
