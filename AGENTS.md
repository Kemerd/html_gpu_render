# AGENTS.md

Terse facts for a coding agent that wants to turn an HTML page or a canvas animation into video frames with this
project. Details and every measurement: README.md. Map of the docs: llms.txt.

## What it is

`html_gpu_render` renders a page frame by frame to raw / PNG / EXR frames. No screenshot: the picture goes into a
WebGPU texture (Chromium HTML-in-Canvas for a whole page, or a copy of a `<canvas>`) and is read back with
`mapAsync` in a hidden Electron window. Zero npm dependencies. Experimental: pin the Electron version.

## Run it

```sh
export ELECTRON_BIN=/path/to/electron        # Electron 43.2.0 (Chromium 150) is the tested one
node tools/probe.mjs                         # must print a line with "dialect: chromium-150" or "chromium-157"
node bin/html-gpu-render.mjs page.html --out out/run --width 1920 --height 1080 --dpr 1 --frames 120 --fps 60 --format png
npm test                                     # the invariants, about 40 s
```

- Exit code 0 = frames are in `--out`, with `render.json` (size, road, alpha form, bit depth, transfer, timings).
- Exit code 1 = one line `[html_gpu_render] ERROR: <reason>` on stdout. README has a table of fixes.
- No Electron? `--browser <chrome or edge exe>` (Chromium 157+). It stalled in some long runs; prefer Electron.
- Programmatic: `import { render } from './src/index.mjs'; const summary = await render({ page, out, ... })`.

## Page contract

- The page defines `window.__seek = (t) => {...}`: sets the whole page to time `t` seconds. May return a promise.
- Frame `i` is `t = from + i / fps`. No reliance on timers or `requestAnimationFrame`.
- Still page: `--seek none`. Other hook name: `--seek myName`. Wait for assets: `--ready "window.__ready"`.
- Local files are served from the page's folder (`--root` to widen it). Everything must be same-origin.

## Pick a mode

- `--mode element` (default): any HTML / CSS / SVG / text page.
- `--mode canvas [--canvas "#id"]`: the picture is one WebGL / WebGPU / 2D canvas (three.js). Frame size = canvas pixel size. The seek hook must draw synchronously, or the canvas must use `preserveDrawingBuffer: true`. Leave `--canvas-road` at `auto` (for WebGL the GPU copy road is 2.7 times faster than `readPixels`).
- `--mode screenshot`: `Page.captureScreenshot`, about 9 times slower; use it as the reference.

## Output

- `--format raw`: `frame_000000.rgba`, width*dpr x height*dpr x 4 bytes, RGBA8, top row first, premultiplied alpha.
- `--format stream`: one `frames.rgba`; `ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r FPS -i frames.rgba ...`.
- `--format png`: straight alpha. `--alpha straight|premultiplied` overrides; `--background #rrggbb` gives opaque frames.
- Float: `raw16f` (half, `ffmpeg -pixel_format rgbaf16le`), `raw32f`, `exr` (half, uncompressed, linear by default), `png16` (16-bit with cICP).
- A run exits 1 if any frame is not on disk in full.

## Motion blur

- `--subframes 16 --shutter 0.5`: 16 seeks per output frame, averaged on the GPU, one frame written.
- Sample times: `t_k = T + ((k + 0.5) / n - 0.5) * shutter / fps`. `--blur-space linear` (default) or `srgb`.
- Cost at 3440 x 1440: about 1.3 ms per extra sub-frame (element), 0.6 ms (canvas).

## HDR

- Float pictures come from: a WebGPU canvas configured `rgba16float`; a WebGL2 float framebuffer named by the page
  hook `window.__hgrFloatSource = () => ({ framebuffer, width, height })`; the sub-frame sum.
- Element mode is 8-bit sRGB content even into a float file (measured in Chromium 150).
- `--input-transfer linear --transfer pq --primaries rec2020 --white-nits 203 --format png16` for HDR10-style
  frames; README has the tested ffmpeg line for 10-bit HEVC. `--transfer hlg` is not implemented.

## Speed (3440 x 1440, Electron 43, RTX 5090, ms per frame)

element raw 6.5 · canvas raw 6 to 8 · png 18 · element with 8 sub-frames 18 · float canvas raw16f 34 · exr 72 ·
png16 142 · screenshot 61. Separate raw files are faster than `stream`. Slow disk: raise `--inflight` (default 8,
at most 16).

## Check the result

```sh
node bin/html-gpu-render.mjs page.html --out out/ref --mode screenshot --format png --frames 3 [same size options]
node tools/compare.mjs out/run out/ref --frames 0-2 --premultiply
```

Expect: text and boxes within 1 of 255; curved vector edges differ on single pixels; over an opaque background a
screenshot has LCD-fringed text and this tool has greyscale text.

## Known traps

- Chromium 150: `mix-blend-mode` anywhere on the page makes every element-mode frame empty (warning: "no covered pixel").
- Chromium 157: a 2D canvas inside the page is missing, a WebGL canvas in a positioned clipped box is offset. Use `--mode canvas` for canvas pages.
- The API was renamed between Chromium 150 and 157 (README, "Versions"). The tool handles both; a later version may differ.
- Cross-origin iframes and redirects to another origin are not drawn.
- A page with `<meta name="color-scheme" content="dark">` needs `--color-scheme dark` to stay transparent.
- Canvas mode: the page must have created the canvas's context before it reports ready.
- 200 raw frames of 3440 x 1440 are 4 GB (float: 8 or 16 GB): mind the disk.
- Wrap long runs in a timeout of your own (`timeout 300 node ...`).

## Layout

- `bin/html-gpu-render.mjs` CLI. `src/index.mjs` API (`render(options)`, `DEFAULTS`).
- `src/driver.cjs` the frame loop (one self-contained function, shared by both backends): roads, ring, sub-frames, float pass.
- `src/main.cjs` + `src/preload.cjs` Electron backend. `src/browser.mjs` + `src/cdp.mjs` browser backend.
- `src/screenshot.cjs` screenshot mode. `src/host.cjs` host document. `src/sink.cjs` file output. `src/png.cjs`, `src/exr.cjs` encoders.
- `tools/probe.mjs`, `tools/compare.mjs`, `tools/bench.mjs`. `test/run.mjs`, `test/hdr.mjs`. `demo/` test pages.
