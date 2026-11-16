#!/usr/bin/env node
/**
 * html-gpu-render: render an HTML page frame by frame to raw RGBA or PNG frames, through Chromium's HTML-in-Canvas
 * API and a WebGPU readback. No screenshot is taken and no window is shown.
 *
 *   node bin/html-gpu-render.mjs <page> [options]
 *
 * <page> is a file path or an http(s) URL. Run with --help for the options.
 */
import { render, DEFAULTS } from '../src/index.mjs';

const HELP = `html-gpu-render <page> [options]

  <page>                 file path or http(s) URL of the page

  --mode <m>             element     the whole page through HTML-in-Canvas + WebGPU readback (default)
                         canvas      one <canvas> of the page (WebGL / WebGPU / 2D) read straight back from the GPU
                         screenshot  Page.captureScreenshot per frame: the usual way, here as the baseline
  --canvas <selector>    canvas mode: which canvas                        (default: the first <canvas> in the page)
  --out <dir>            folder for the frames and render.json            (default: out)
  --width <css px>       viewport width                                   (default: 1920)
  --height <css px>      viewport height                                  (default: 1080)
  --dpr <n>              device scale factor; frames are width*dpr x height*dpr pixels   (default: 1)
  --frames <n>           number of frames                                 (default: 1)
  --fps <n>              frame i shows time  from + i / fps               (default: 60)
  --from <seconds>       time of the first frame                          (default: 0)
  --format <f>           raw     one frame_000000.rgba per frame (default)
                         png     one frame_000000.png per frame
                         stream  one frames.rgba, the frames end to end (feeds ffmpeg -f rawvideo)
                         none    nothing written: timing only
                         raw16f  one frame_000000.rgba16f per frame: half float RGBA, nothing clipped
                         raw32f  one frame_000000.rgba32f per frame: 32-bit float RGBA
                         exr     one frame_000000.exr per frame: OpenEXR half float, uncompressed
                         png16   one frame_000000.png per frame: 16-bit RGBA with a cICP chunk
  --input-transfer <t>   float formats: what the page's values are: srgb | linear        (default: srgb)
  --transfer <t>         float formats: what is written: srgb | linear | pq   (default: as the input; linear for exr)
  --primaries <p>        float formats: srgb | p3 | rec2020 (the input is taken as sRGB)  (default: srgb)
  --white-nits <n>       transfer pq: the luminance of the value 1.0                      (default: 203)
  --float-hook <name>    canvas mode: the page function naming a WebGL2 float framebuffer (default: __hgrFloatSource)
  --alpha <a>            premultiplied | straight        (default: straight for png and png16, premultiplied otherwise)
  --background <c>       transparent | #rrggbb | #rrggbbaa: composite over this colour   (default: transparent)
  --seek <name>          the page's hook window.<name>(t), t in seconds; "none" for a still page  (default: __seek)
  --ready <expression>   wait until this JS expression is truthy in the page
  --wait <ms>            extra wait before the first frame                (default: 0)
  --timeout <seconds>    allowed for loading and --ready                  (default: 60)
  --root <dir>           folder served as "/" for a local page            (default: the page's folder)
  --query <string>       query string added to a local page's URL
  --color-scheme <s>     dark | light: set it when the page declares a color-scheme and you want transparency
  --subframes <n>        motion blur: seek n times inside each frame interval and average on the GPU   (default: 1 = off)
  --shutter <0..1>       the open part of the frame interval the sub-frames cover       (default: 0.5 = 180 degrees)
  --blur-space <s>       linear | srgb: average in linear light, or the encoded values  (default: linear)
  --inflight <n>         frames between drawn and written at once         (default: 8; 1 = strictly one after the other)
  --canvas-road <r>      canvas mode: copy    copyExternalImageToTexture + mapAsync
                                      direct  readPixels + fence (WebGL2) or the canvas's own texture (WebGPU)
                                      auto    the fastest measured for the canvas's kind       (default: auto)
  --fsync                flush every frame to the device before it counts as written (slower)
  --preallocate          stream format: give frames.rgba its full size first
  --png-level <0-9>      zlib level for png                               (default: 1)
  --electron <path>      the Electron binary                              (default: $ELECTRON_BIN, then the "electron" package)
  --browser <path>       use a headless Chrome / Edge / Chromium (157 or newer) instead of Electron
  --switch <name[=v]>    an extra Chromium switch (repeatable)
  --priority <p>         normal | low (below normal priority for the whole process tree)
  --vsync                pace the frames by the display refresh (slower)
  --profile              time the GPU part of element -> texture separately (adds a wait per frame)
  --ipc-probe            also time sending every frame to the main process (measurement only)
  --verbose              print the page's console and Chromium's log
  --help

The page contract: define  window.__seek = (t) => { ...set everything to time t... }  (it may return a promise).
Exit code 0 on success; 1 with a line "[html_gpu_render] ERROR: ..." otherwise.`;

// flag name -> option name, and which flags take no value
const FLAGS = { 'color-scheme': 'colorScheme', 'png-level': 'pngLevel', 'ipc-probe': 'ipcProbe', 'canvas-road': 'canvasRoad', 'blur-space': 'blurSpace', 'input-transfer': 'inputTransfer', 'white-nits': 'whiteNits', 'float-hook': 'floatHook' };
const BOOLEAN = new Set(['vsync', 'profile', 'ipcProbe', 'verbose', 'fsync', 'preallocate']);

function parse(argv) {
  const options = { switches: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { console.log(HELP); process.exit(0); }
    if (!arg.startsWith('--')) {
      if (options.page) throw new Error(`unexpected argument "${arg}" (the page is already "${options.page}").`);
      options.page = arg;
      continue;
    }
    // --name value  or  --name=value
    const eq = arg.indexOf('=');
    const flag = arg.slice(2, eq < 0 ? undefined : eq);
    const name = FLAGS[flag] || flag;
    if (name === 'switch') {
      const v = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (v === undefined) throw new Error('--switch needs a value.');
      options.switches.push(v);
      continue;
    }
    if (!(name in DEFAULTS)) throw new Error(`unknown option --${flag}. Run with --help.`);
    if (BOOLEAN.has(name)) { options[name] = eq < 0 ? true : arg.slice(eq + 1) !== 'false'; continue; }
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`--${flag} needs a value.`);
    options[name] = value;
  }
  return options;
}

let printed = false;
try {
  const options = parse(process.argv.slice(2));
  if (!options.page) { console.log(HELP); process.exit(2); }
  await render(options, { onLine: (line) => { if (/^\[html_gpu_render\] ERROR:/.test(line)) printed = true; console.log(line); } });
} catch (e) {
  // a failure inside the run has already been printed as "[html_gpu_render] ERROR: ..."; anything else is printed here
  if (!printed) console.error('[html_gpu_render] ERROR:', (e && e.message) || e);
  process.exit(1);
}
