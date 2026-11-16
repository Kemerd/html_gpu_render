# html_gpu_render

Render an HTML page or a canvas animation **frame by frame, deterministically, to raw or PNG frames** for video
(HTML to video frames), **without screenshots**. The picture goes into a WebGPU texture, through Chromium's
**HTML-in-Canvas** API for a whole page or straight from a `<canvas>`, and the pixels are read back from the GPU
(**WebGPU readback**, `mapAsync`) in a hidden **Electron** window. True alpha in one pass, optional **motion blur**
summed on the GPU from sub-frames, optional **HDR / float** output (half float, 32-bit float, OpenEXR, 16-bit PNG
with PQ). No visible window, no `Page.captureScreenshot`, no base64, no dependencies.

**Why it exists.** When a page is rendered to video one frame at a time (Puppeteer or Playwright, seek, screenshot,
repeat), the screenshot is the bottleneck: the browser composites, encodes a PNG, base64-encodes it and sends it
over the DevTools connection. On the machine below that is 61 ms for a 3440 x 1440 frame. Reading the same frame
back from the GPU and writing it raw takes 6.5 ms.

**Status: experimental.** It rests on a browser API that is behind a switch in Chromium 150 and was renamed by
Chromium 157. Pin your Electron version (see [Versions](#versions-and-the-api-rename)) and read
[Known limits](#known-limits).

## Contents

[Quick start](#quick-start) · [Modes](#which-mode) · [Page contract](#the-page-contract) · [CLI](#cli) ·
[API](#api) · [Output](#output) · [Motion blur](#motion-blur-by-sub-frames) · [HDR](#hdr-and-float-output) ·
[How it works](#how-it-works) · [Versions](#versions-and-the-api-rename) · [Numbers](#measured-numbers) ·
[Fidelity](#fidelity-against-a-screenshot) · [Limits](#known-limits) · [Failures](#failure-messages) ·
[Tools and tests](#tools-and-tests)

## Quick start

```sh
# 1. an Electron whose Chromium has the API: Electron 43 (Chromium 150) is the tested one.
#    Either point at a binary you have ...
export ELECTRON_BIN=/path/to/electron            # PowerShell:  $env:ELECTRON_BIN = "C:\path\to\electron.exe"
#    ... or install it beside this project:  npm install --no-save electron@43.2.0

# 2. does that binary expose the API?
node tools/probe.mjs

# 3. render the demo: 60 frames, 1720 x 720 CSS px at device scale 2 = 3440 x 1440, PNG with alpha
node bin/html-gpu-render.mjs demo/page.html --out out/demo --width 1720 --height 720 --dpr 2 --frames 60 --fps 60 --format png

# raw frames in one file, straight into ffmpeg
node bin/html-gpu-render.mjs demo/page.html --out out/demo --width 1720 --height 720 --dpr 2 --frames 60 --fps 60 --format stream
ffmpeg -f rawvideo -pix_fmt rgba -s 3440x1440 -r 60 -i out/demo/frames.rgba -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le out/demo.mov
```

Requirements: Node 22 or newer; an Electron binary (`ELECTRON_BIN`, `--electron`, or the `electron` package, which
is an optional peer dependency and is not installed by this project). A headless Chrome / Edge 157+ can be used
instead (`--browser`), with the caveats under [Known limits](#known-limits).

## Which mode

| `--mode` | what is captured | needs | use it when |
| --- | --- | --- | --- |
| `element` (default) | the whole page, whatever it is made of | HTML-in-Canvas + WebGPU | the page is HTML, CSS, SVG, text |
| `canvas` | one `<canvas>` of the page (WebGL, WebGL2, WebGPU, 2D), read back from the GPU | WebGPU, no switch | the picture is already a canvas: three.js, a game, a shader |
| `screenshot` | the page, with `Page.captureScreenshot` (png, optimizeForSpeed) | nothing special | you want the reference picture, or the other modes cannot draw your page |

In `canvas` mode the frame has the canvas's own pixel size (`canvas.width` x `canvas.height`); `--canvas <selector>`
picks the canvas (default: the first one). The canvas is taken in the same task as the seek, so a WebGL canvas
without `preserveDrawingBuffer` works as long as the seek hook draws synchronously. The page must have created the
canvas's context by the time it is ready (`--ready`).

### Canvas roads

`render.json` says which road a run took (`"road"`). `--canvas-road auto | copy | direct` chooses; `auto` takes
what measured fastest for the kind of canvas.

| road | what it does | taken by `auto` for | measured (3440 x 1440, no write) |
| --- | --- | --- | --- |
| `external-copy` | `GPUQueue.copyExternalImageToTexture(canvas)` into this tool's texture, one pass, `copyTextureToBuffer`, `mapAsync`; written out of the mapped memory | WebGL, WebGL2, 2D, and WebGPU canvases not configured for the direct road | **4.2 ms** per frame (WebGL2 canvas) |
| `webgl2-readpixels` | `gl.readPixels` into a pixel-pack buffer in the same task as the draw, two GPU blits (resolve, then y flip), `fenceSync`, `getBufferSubData` | nothing while WebGPU exists (`--canvas-road direct`, or a browser without WebGPU) | 11.4 ms per frame |
| `webgpu-copy` | `copyTextureToBuffer` from the canvas's current texture on the page's own device, `mapAsync` | a WebGPU canvas configured with `format: 'rgba8unorm'`, `usage` including `COPY_SRC`, `alphaMode: 'premultiplied'` | 5.0 ms per frame (copy road on the same page: 4.8; equal within noise) |
| `webgl2-float-hook` | the page's float framebuffer, `readPixels` FLOAT, uploaded (see [HDR](#hdr-and-float-output)) | a page with the float hook, when a float format is asked for | 126 ms per frame |

Reading a WebGL canvas "directly" is the **slower** road in Chromium, although it skips a GPU copy: the pixels of
a pixel-pack buffer come back through `getBufferSubData`, a synchronous 20 MB copy on the page's thread (9 ms
here; Chromium's fast path for it did not engage, it logs "READ-usage buffer was written, then fenced, but written
again before being read back"), and the read itself takes the GPU process about 11 ms per frame, one frame after
the other. `copyExternalImageToTexture` is one GPU-side copy and `mapAsync` then hands over the memory without any
copy. The three 8-bit roads give bit-identical frames (120 of 120 compared). The direct roads need the canvas to
hold the alpha form that is asked for, no `--background`, no sub-frames and an 8-bit format; otherwise the copy
road is taken.

## The page contract

```js
// Set everything on the page to time t (seconds). No clocks, no requestAnimationFrame: t alone defines the frame.
window.__seek = (t) => { /* ... */ };        // may return a promise; it is awaited
```

Frame `i` shows `t = from + i / fps`. The hook's name is `--seek <name>`; `--seek none` renders a page that does not
move. `--ready "<expression>"` waits until the expression is truthy in the page (for example `window.__ready`) before
the first frame; fonts (`document.fonts.ready`) are always awaited. A page given as a file is served from its folder
(`--root`) over `http://127.0.0.1`, so module scripts, `fetch()` and fonts beside it work.

## CLI

```
node bin/html-gpu-render.mjs <page> [options]        <page>: a file path or an http(s) URL

--mode <m>            element | canvas | screenshot                              (default: element)
--canvas <selector>   canvas mode: which canvas                                  (default: the first <canvas>)
--canvas-road <r>     canvas mode: auto | copy | direct                          (default: auto)
--out <dir>           folder for the frames and render.json                      (default: out)
--width / --height    viewport in CSS pixels                                     (default: 1920 x 1080)
--dpr <n>             device scale factor; frames are width*dpr x height*dpr     (default: 1)
--frames <n>          number of frames                                           (default: 1)
--fps <n>             frame i shows time from + i / fps                          (default: 60)
--from <seconds>      time of the first frame                                    (default: 0)
--format <f>          8-bit: raw | png | stream | none    float: raw16f | raw32f | exr | png16   (default: raw)
--alpha <a>           premultiplied | straight     (default: straight for png and png16, premultiplied otherwise)
--background <c>      transparent | #rrggbb | #rrggbbaa: composite over it on the GPU   (default: transparent)

--subframes <n>       motion blur: seek n times inside each frame interval, average on the GPU   (default: 1 = off)
--shutter <0..1>      the open part of the frame interval the sub-frames cover   (default: 0.5 = 180 degrees)
--blur-space <s>      linear | srgb: average in linear light, or the encoded values   (default: linear)

--input-transfer <t>  float formats: what the page's values are: srgb | linear   (default: srgb)
--transfer <t>        float formats: what is written: srgb | linear | pq   (default: as the input; linear for exr)
--primaries <p>       float formats: srgb | p3 | rec2020 (the input is taken as sRGB)   (default: srgb)
--white-nits <n>      transfer pq: the luminance of the value 1.0                (default: 203)
--float-hook <name>   canvas mode: the page function naming a WebGL2 float framebuffer   (default: __hgrFloatSource)

--seek <name>         the page's hook window.<name>(t); "none" for a still page  (default: __seek)
--ready <expression>  wait until this is truthy in the page
--wait <ms>           extra wait before the first frame                          (default: 0)
--timeout <seconds>   allowed for loading and --ready                            (default: 60)
--root <dir>          folder served as "/" for a local page                      (default: the page's folder)
--query <string>      query string added to a local page's URL
--color-scheme <s>    dark | light: set it when the page declares a color-scheme and you want transparency

--inflight <n>        frames between drawn and written at once                   (default: 8; 1 = one after the other)
--fsync               flush every frame to the device before it counts as written (slower)
--preallocate         stream format: give frames.rgba its full size first
--png-level <0-9>     zlib level for png and png16                               (default: 1)
--electron <path>     the Electron binary             (default: $ELECTRON_BIN, then an installed "electron" package)
--browser <path>      use a headless Chrome / Edge / Chromium (157+) instead of Electron
--switch <name[=v]>   an extra Chromium switch (repeatable)
--priority <p>        normal | low (the whole process tree below normal priority)
--vsync               pace frames by the display refresh (slower; never needed)
--profile             time the GPU part of the copy into the texture separately (adds a wait per frame)
--ipc-probe           also time sending every frame to Electron's main process (measurement only)
--verbose             print the page's console and Chromium's log
```

Exit code 0 on success. On failure the exit code is 1 and one line `[html_gpu_render] ERROR: ...` says why.

## API

```js
import { render } from './src/index.mjs';

const summary = await render({
  page: 'demo/page.html', out: 'out/demo',
  width: 1720, height: 720, dpr: 2, frames: 200, fps: 60,
  format: 'raw',                        // every CLI option, in camelCase: subframes, blurSpace, inputTransfer,
});                                     // whiteNits, canvasRoad, pngLevel, colorScheme, floatHook, ...
console.log(summary.msPerFrame, summary.pixels, summary.road);
```

`render()` resolves with the summary that is also written to `<out>/render.json`, and rejects with the same message
the CLI prints. `render(options, { onLine })` receives the progress lines instead of printing them. `DEFAULTS`
(exported from the same module) lists every option with its default.

## Output

| `--format` | files | contents |
| --- | --- | --- |
| `raw` | `frame_000000.rgba`, ... | width x height x 4 bytes, RGBA, 8 bits, rows top to bottom, no header, no padding |
| `stream` | `frames.rgba` | the same frames end to end in one file (`ffmpeg -f rawvideo -pix_fmt rgba`) |
| `png` | `frame_000000.png`, ... | 8-bit RGBA PNG, zlib level `--png-level` |
| `raw16f` | `frame_000000.rgba16f`, ... | RGBA half floats (IEEE 754 binary16), little-endian, 8 bytes per pixel, tight (`ffmpeg -pixel_format rgbaf16le`) |
| `raw32f` | `frame_000000.rgba32f`, ... | RGBA 32-bit floats, little-endian, 16 bytes per pixel, tight |
| `exr` | `frame_000000.exr`, ... | OpenEXR, half float RGBA, scanlines, no compression, `chromaticities` set |
| `png16` | `frame_000000.png`, ... | 16-bit RGBA PNG (values 0..1 scaled to 0..65535, the rest clipped) with a `cICP` chunk |
| `none` | nothing | timing runs |

`render.json` beside the frames records the size, the alpha form, the road taken, bit depth, transfer, primaries
and value scale, the Chromium version, the GPU adapter and the milliseconds per stage.

- **Alpha is real**: a page with a transparent background gives transparent frames. `raw`, the float raw formats
  and `exr` are premultiplied by default (what the browser holds, and the EXR convention); `png` and `png16` are
  straight (what PNG means). `--alpha` overrides. `--background #000000` composites over a colour on the GPU.
- **8-bit values** are sRGB-encoded, exactly as the browser composites them.
- **A frame that is not on disk fails the run** (exit code 1): every write is checked for its length, and at the
  end every file of a fixed-size format (or the stream file) is checked for its size.

## Motion blur by sub-frames

```sh
node bin/html-gpu-render.mjs demo/motion.html --out out/blur --width 1720 --height 720 --dpr 2 --frames 60 --fps 30 --subframes 16 --shutter 0.5 --format png
```

For each output frame the page is seeked `n` times inside the frame interval; every sub-frame goes through the
normal road into a texture and is **added on the GPU** into a 32-bit float texture; one pass divides by `n` and the
result is read back and written as **one** frame. No sub-frame leaves the GPU.

- **Sample times**, for output frame `i` at `T = from + i / fps`:
  `t_k = T + ((k + 0.5) / n - 0.5) * shutter / fps`, `k = 0 .. n-1`. Evenly spaced over the open part of the
  interval, centred on the frame time. `n = 1` gives exactly `T`. `--shutter 0.5` is a 180 degree shutter.
- **What is summed**: premultiplied values, so translucent edges average correctly. With `--blur-space linear`
  (default) each colour is decoded from sRGB to linear light first (un-premultiply, decode, premultiply again) and
  encoded again after the division; with `--blur-space srgb` the encoded values are averaged as they are, which is
  what a naive frame blend in a video editor does. A page whose values are already linear
  (`--input-transfer linear`) is summed as it is.
- Works in `element` and `canvas` mode, with the frames-in-flight ring and with every format. Canvas mode takes
  the copy road, since the sum needs this tool's own WebGPU device.

Checked at 3440 x 1440 (`npm test -- --dpr 2`):

| check | result |
| --- | --- |
| `--subframes 1` against the plain render | bit-identical, element and canvas |
| a still page with n = 4 and n = 16, linear and srgb | identical to n = 1 (maximum difference 0) |
| GPU average against the average of the 8 sub-frames rendered one by one (computed in double precision) | within 0.56 of 255 in linear, 0.50 in srgb (0.5 is the rounding to 8 bits itself) |
| streak of a 40 px square moving at 2400 px/s, 30 fps, n = 16 | shutter 0.5: 78 px measured, 77.5 expected; shutter 1.0: 115 measured, 115 expected |

Cost: see [Measured numbers](#sub-frames).

## HDR and float output

The float formats skip the 8-bit texture altogether: the pass writes `rgba16float` (`raw16f`, `exr`) or
`rgba32float` (`raw32f`, `png16`) and that is read back. Nothing is clamped to 0..1 and nothing is cut to 8 bits.

### Where a float picture comes from

| source | how | measured |
| --- | --- | --- |
| a **WebGPU canvas configured `rgba16float`** (`toneMapping: { mode: 'extended' }`) | `--mode canvas`: `copyExternalImageToTexture` into an `rgba16float` texture | values 0.5, 1, 2, 4, 8 and negative values arrive exactly (also with tone mapping `standard`) |
| a **WebGL2 float framebuffer** (a three.js `WebGLRenderTarget` of `HalfFloatType` / `FloatType`) | `--mode canvas` and the page hook below: `readPixels` FLOAT in the same task as the draw | values exact; slow (synchronous read) |
| the **sub-frame sum** (`--subframes n`) | always 32-bit float on the GPU; with a float format it is written at that precision | the average is within 1.3e-7 of the exact mean (1 of 255 is 3.9e-3) |
| **element mode** (HTML-in-Canvas) | accepts float destinations, but see below | 8-bit sRGB content only |

The float hook, for a WebGL2 page:

```js
// the framebuffer must belong to the WebGL2 context of the canvas that --canvas selects
window.__hgrFloatSource = () => ({ framebuffer, width, height });
// three.js:  framebuffer = renderer.properties.get(renderTarget).__webglFramebuffer
```

A WebGPU page with a float render target of its own should present it to an `rgba16float` canvas and use that.

**What HTML-in-Canvas gives (Chromium 150, measured with `rgba16float` and `rgba32float` destinations):** the
calls are accepted, and the content is 8-bit sRGB. `color(srgb-linear 2 2 2)` and `color(srgb 2 2 2)` arrive as
1.0; `color(srgb-linear 0.5 0.5 0.5)` arrives as 0.7368, which is 188 / 255; `color(display-p3 1 0 0)` arrives as
sRGB red (clipped to the sRGB gamut, also with a `display-p3` destination, which only re-expresses that red as
0.9175 0.2002 0.1385); `color(rec2100-pq ...)` and `color(rec2100-hlg ...)` are not parsed (`CSS.supports` says
false; nothing is drawn); `dynamic-range-limit: no-limit` is parsed and changes nothing. The same with
`--force-color-profile=scrgb-linear` and `hdr10`. HDR images were not tested. So in element mode a float format
gives the 8-bit picture in a float file, and real extra precision only comes from sub-frames.

### Colour

Float values are written as the page gave them unless a conversion is asked for. `--input-transfer` says what the
page's values are (`srgb`: encoded, the default; `linear`: scene-linear, as a three.js float target usually is).
`--transfer` and `--primaries` say what to write; if they differ from the input, one GPU pass converts, on straight
colour: input transfer to linear light (the sRGB curve mirrored at zero for values outside 0..1), the primaries
matrix from sRGB / Rec.709 (D65), then the output transfer.

- `--transfer pq`: SMPTE ST 2084. A value of 1.0 becomes `--white-nits` cd/m2 (default 203, the HDR reference
  white of BT.2408): 1.0 is written as 0.5807, 8.0 as 0.8047. Negative values are clipped to 0 first.
- `--transfer hlg` is **not implemented**.
- `exr` defaults to `--transfer linear`, as EXR files are scene-linear by convention.
- `png16` carries a `cICP` chunk (primaries, transfer, RGB, full range): sRGB 1 / 13, linear 1 / 8, PQ with
  Rec.2020 9 / 16. ffprobe reads it back as `color_transfer=smpte2084 color_primaries=bt2020`.

Checked (`npm test`, and by reading the files with other software):

| check | result |
| --- | --- |
| `raw32f`, `raw16f`, `exr` of the float canvas | 0.5, 1, 2, 4, 8 and the coloured row exact |
| the WebGL2 hook, `raw32f` | exact, rows the right way up |
| linear to PQ at 203 cd/m2, Rec.2020 | `raw32f` within 4.6e-6 of ST 2084 computed in double precision; `png16` within 9.0e-6 (under one 16-bit step) |
| linear sRGB to Rec.2020 primaries | within 1.3e-8 (relative) of the BT.2087 matrix |
| a float file of an 8-bit page, rounded to 8 bits | identical to the 8-bit file, element and canvas |
| the EXR read with OpenCV | float32, 0.5 0.25 0.125 ... 8 4 2: exact |
| the EXR read with ffprobe / ffmpeg | recognised (`gbrapf16le`, `color_transfer=linear`); ffmpeg's own conversion to another pixel format clips above 1.0 |
| the PQ PNG read with OpenCV | 16-bit, values within 1 of the expected code |
| the 8-bit formats after all of this was added | unchanged: `--subframes 1` and the float tests leave the same bytes, and the differences against a screenshot are the same pixel counts as before |

### To a 10-bit HEVC PQ file

```sh
# 16-bit PNGs with PQ and Rec.2020 written in (tested: ffprobe reports hevc, yuv420p10le, smpte2084, bt2020)
node bin/html-gpu-render.mjs page.html --mode canvas --out out/hdr --frames 300 --fps 30 \
     --format png16 --input-transfer linear --transfer pq --primaries rec2020 --white-nits 203
ffmpeg -framerate 30 -i out/hdr/frame_%06d.png \
       -vf "scale=out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le" \
       -c:v libx265 -crf 18 -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv \
       -x265-params "hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" -tag:v hvc1 out/hdr.mp4

# the same from raw half floats, which are 4 times faster to write than the PNGs (also tested)
node bin/html-gpu-render.mjs page.html --mode canvas --out out/hdr --frames 300 --fps 30 \
     --format raw16f --input-transfer linear --transfer pq --primaries rec2020
ffmpeg -f image2 -framerate 30 -c:v rawvideo -pixel_format rgbaf16le -video_size 3440x1440 -i out/hdr/frame_%06d.rgba16f \
       -vf "scale=in_range=pc:out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le" \
       -c:v libx265 -crf 18 -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv \
       -x265-params "hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc" -tag:v hvc1 out/hdr.mp4
```

A frame decoded again from the first file had 33387, 38081, 42851, 47770, 52763 (16-bit) where the PNG had 33395,
38055, 42872, 47785, 52738.

## How it works

1. A local page gets an origin: its folder is served on `127.0.0.1`.
2. A host document **on the page's own origin** is loaded: one `<canvas layoutsubtree content="drawable">` whose only
   child is an `<iframe drawable>` holding the page. The page itself is not modified. (Same origin is required: the
   API draws nothing for a cross-origin frame, silently.)
3. Per frame: call the seek hook, `canvas.requestPaint()`, wait for the canvas `paint` event, then
   `GPUQueue.copyElementImageToTexture()` rasters the page into a WebGPU texture, and `copyTextureToBuffer` +
   `mapAsync` bring the pixels back. In canvas mode the paint step is replaced by a copy of the canvas.
4. **No row padding to remove.** WebGPU pads the rows of a readback to 256 bytes (3440 pixels are 13760 bytes,
   padded to 13824). Instead of copying the rows out one by one, one full-screen pass re-lays the picture out
   into a texture whose rows are a multiple of 256 bytes (3440 x 1440 becomes 3456 x 1434: the same pixels in the
   same order). The mapped buffer then IS the tightly packed frame and is written as it is, with no copy. The same
   pass does the background, the sub-frame resolve and the colour conversion.
5. **Frames in flight.** A ring of readback buffers (`--inflight`, default 8): the `mapAsync` wait and the write of
   frame n run while frame n+1 is drawn. A slot is freed only when its frame is written, so frames cannot overtake
   each other or pile up. Checked: frames identical between `--inflight 1` and the pipelined run.
6. Electron backend: the loop runs in a preload with Node, so a frame goes from the GPU-mapped memory to `fs` in
   the same process (the write runs on Node's thread pool). Browser backend: the loop runs in the page and POSTs
   each frame as raw bytes to a server on `127.0.0.1` in the Node process.

## Versions and the API rename

HTML-in-Canvas ([WICG explainer](https://github.com/WICG/html-in-canvas)) changed shape between the two Chromium
versions tested. **Pin the Electron version you have validated**; `tools/probe.mjs` prints what a binary has.

| Chromium | switch needed | canvas attribute | child | WebGPU call |
| --- | --- | --- | --- | --- |
| 150 (Electron 43.2.0) | `--enable-blink-features=CanvasDrawElement` (also on with `--enable-features=CanvasDrawElement` or `--enable-experimental-web-platform-features`) | `layoutsubtree` | any child | `queue.copyElementImageToTexture({ source }, { destination: { texture, premultipliedAlpha } })` |
| 157 (Edge 157.0.4341.60) | none: exposed by default in that build | `content="drawable"` | must carry `drawable` | `queue.drawElementImageToTexture({ source }, { texture, premultipliedAlpha })` |

The tool sets the switch itself, writes both attribute sets and picks the call that exists. In both dialects the
texture receives **straight** alpha unless `premultipliedAlpha: true` is passed. Other names seen: Chromium 150 has
`CanvasRenderingContext2D.drawElementImage` and `gl.texElementImage2D`; 157 keeps `drawElementImage`, replaces the
WebGL call by `texElementSubImage2D` and adds `canvas.updateElementGeometry`. Canvas mode needs none of this, only
WebGPU.

## Measured numbers

Hardware and software: NVIDIA RTX 5090 (Direct3D via ANGLE / Dawn), Windows 11, a 3.7 TB NTFS volume on NVMe
SSDs, Node 26.3.1, Electron 43.2.0 (Chromium 150.0.7871.129). Frames of **3440 x 1440** (1720 x 720 CSS px at
device scale 2; 19.8 MB per 8-bit raw frame), process priority below normal, other GPU work running on the machine
at the same time. Means, milliseconds per output frame, one run each; run-to-run noise is about 1 ms on the
fast rows. `node tools/bench.mjs --frames 120` reproduces the 8-bit table; the rest are single CLI runs.

### 8-bit (120 frames)

| run | ms per frame | frames per second |
| --- | --- | --- |
| **element** (demo/page.html), no write | 5.8 | 173 |
| **element, raw files** | **6.5** | 154 |
| element, raw, over `#000000` | 6.2 | 162 |
| element, one raw stream file | 10.4 | 96 |
| element, png level 1 | 17.6 | 57 |
| **canvas**, WebGL2 (demo/canvas.html), copy road, no write | 4.2 | 240 |
| **canvas, WebGL2, copy road, raw files** | **8.1** (6.1 with `--inflight 16`) | 123 (164) |
| canvas, WebGL2, direct road (`readPixels`), no write / raw files | 11.4 / 17.0 | 88 / 59 |
| canvas, WebGPU (demo/canvas_webgpu.html), direct road, no write / raw files | 5.0 / 7.3 | 200 / 137 |
| canvas, WebGPU, copy road, no write / raw files | 4.8 / 8.7 | 210 / 115 |
| **screenshot** of page.html, png | **61.3** | 16 |
| screenshot of canvas.html, png | 87.2 | 11 |

What bounds each: **element mode: the GPU** (rastering the page takes about 6 ms of GPU-process time per frame,
one frame after the other; the loop's own thread needs 2.7 ms, writing adds 0.7 ms). **Canvas mode without
writing: the GPU copy and readback** (the loop's thread needs 0.3 ms). **Canvas mode writing dense frames: the
disk.**

Against the first version of the loop (one frame after the other, rows unpadded by a CPU copy): element raw 11.8
to 6.5 ms, canvas raw 14.0 to 8.1 ms; the unpadding copy (2.3 ms) is gone and the loop's own thread went from 11.7
to 2.7 ms (element) and from 14.0 to 0.3 ms (canvas).

### Sub-frames

60 output frames, raw files; element is demo/motion.html, canvas is demo/canvas.html.

| sub-frames | element, ms per output frame | canvas, ms per output frame |
| --- | --- | --- |
| 1 | 8.1 | 7.8 |
| 4 | 12.8 | 10.0 |
| 8 | 18.4 (17.4 without writing; 20.2 as png) | 12.9 (9.1 without writing) |
| 16 | 28.0 | 16.3 |

Bound: **the GPU**, about 1.3 ms per additional sub-frame in element mode on this page and about 0.6 ms in canvas
mode; in canvas mode the write of the dense frames is the larger part until about 8 sub-frames. `--blur-space`
makes no measurable difference (18.6 against 18.4 ms).

### Float formats

60 frames. "Float canvas" is demo/hdr_webgpu.html (a dense picture).

| run | ms per frame | bound by |
| --- | --- | --- |
| float canvas, `raw16f` (39.6 MB per frame) | 34.0 | the disk: 134 ms per write, 8 in flight |
| float canvas, `raw16f`, converted to PQ / Rec.2020 on the GPU | 31.5 | the disk (the conversion is not measurable) |
| float canvas, `raw16f`, 8 sub-frames | 33.8 | the disk |
| float canvas, `raw32f` (79.3 MB per frame) | 43.1 | the disk |
| float canvas, `exr` | 71.9 | the CPU: channels are regrouped per scanline, then the disk |
| float canvas, `png16` (PQ) | 142.0 | the CPU: float to 16-bit and deflate, about 960 ms per frame, 8 at once |
| WebGL2 float hook, `raw16f` / `raw32f` | 126.1 / 131.2 | the synchronous `readPixels` FLOAT and upload: 93 to 100 ms on the page's thread |
| element (demo/motion.html), `raw16f` | 11.1 | GPU and disk (8-bit `raw` on the same page: 8.1) |
| element, `raw16f`, 8 sub-frames | 22.0 | the GPU |
| element, `png16`, 8 sub-frames | 70.7 | the CPU |

### Disk

Measured with the tool itself (`--format none` against `raw` / `stream`, `--inflight`, `--fsync`), 8-bit frames:

| what | result |
| --- | --- |
| one write of a 19.8 MB frame, alone (`--inflight 1`) | 6.8 ms (2.9 GB/s into the file cache) |
| raw files, flat page frames (mostly transparent), 8 in flight | 6.5 ms per frame = 3.0 GB/s; 0.7 ms above not writing at all |
| raw files, dense canvas frames, 3 / 6 / 12 / 16 in flight | 10.1 / 8.1 / 6.7 / 6.1 ms per frame (up to 3.3 GB/s); not writing: 4.2 |
| the same with `--fsync` (every file flushed to the device), 6 / 12 in flight | 9.1 / 8.7 ms per frame = **2.2 to 2.3 GB/s: the device limit seen here** |
| flat page frames with `--fsync`, 8 in flight | 6.9 ms per frame = 2.9 GB/s |
| one stream file (`--format stream`), 4 or 8 in flight | 9.7 to 10.4 ms per frame: slower than separate files; writes into one file do not overlap |
| stream with `--preallocate` | 9.2 to 9.9: no gain |

- The time of one write depends on the content of the frame on this volume (9 ms for a mostly empty 8-bit frame,
  17 to 46 ms for a dense one under load, 134 ms for a dense 39.6 MB float frame); the cause was not looked for.
- More frames in flight is what helps a slow write; `--inflight 16` is the largest the tool takes. A frame is
  already one write call.
- No worker thread was added for writing: the writes already run on Node's thread pool (one thread per frame in
  flight), and the loop's own thread is not what holds a run.
- Nothing is skipped to gain speed: by default a write counts when the file system has taken all its bytes, and
  the sizes are checked again at the end. `--fsync` adds the flush to the device.

### Other measurements

- Sending each frame to Electron's main process over IPC instead of writing it from the preload cost another 33 ms
  per frame, which is why the preload writes.
- **Headless Edge 157 (browser backend)**, measured once with the first version of the loop (200 frames) and **not
  re-measured** since: element no write 9.5 ms, element raw 44.8 (one run; three later runs stalled), element png
  42.7, canvas no write 7.4, canvas raw 32.4, screenshot png 62.0. The POST of a 19.8 MB frame to `127.0.0.1` is
  the slow part there (about 20 to 35 ms). With the current code only short checks were run in Edge: element and
  canvas frames bit-identical to Electron's, and one `raw16f` frame of the float canvas written.

## Fidelity against a screenshot

Compared with `tools/compare.mjs` on demo/page.html, same Chromium, same page, same size:

- **Element mode in Electron 150 and in Edge 157 give bit-identical frames**; so do the two browsers' screenshots.
- **Transparent background, element vs screenshot:** text (four faces, 13 to 58 px), boxes, borders, box shadows and
  gradients agree to within 1 of 255 (the rounding of premultiplied to straight alpha). **Curved vector edges
  differ**: SVG stroked paths, circles and `border-radius: 50%` are antialiased slightly differently (maximum
  difference 117 of 255 on single edge pixels; 0.25 % of all pixels differ, 0.11 % by more than 8). Both are
  properly antialiased; the eye does not tell them apart.
- **Opaque background:** a screenshot over an opaque colour uses LCD subpixel text antialiasing (coloured fringes);
  element mode always uses greyscale antialiasing. So over black, 0.38 % of pixels differ by more than 8, nearly
  all of them small text. For video the greyscale form is the one you want.
- **Alpha comes through.** One pass gives the page with true alpha; there is no need for a black pass and a white
  pass.
- **Canvas mode vs screenshot** (demo/canvas.html, screenshot from headless Edge): identical to within 1 of 255
  (0.4 % of pixels differ by 1, none by more), identical between Electron and Edge, and identical between the
  canvas roads.

What element mode does with other content (demo/media.html, compared cell by cell with an Edge screenshot):

| content | Chromium 150 (Electron 43) | Chromium 157 (Edge) |
| --- | --- | --- |
| WebGL canvas | same as screenshot (max 1) | **drawn at the wrong offset** when inside a positioned, clipped box; correct when it fills the page |
| 2D canvas | same as screenshot (max 1) | **missing** |
| `<img>` (SVG, PNG) | same but for a few edge pixels (max 24) | same |
| `<video>` | drawn; 1 % of pixels differ by more than 8 | same |
| `filter: drop-shadow` | same (max 1) | same |
| `backdrop-filter: blur` | drawn; 4 % of pixels differ by more than 8 | same |
| `mix-blend-mode` | **the whole frame comes back empty** if it appears anywhere on the page | drawn correctly |

## Known limits

- **The API is experimental and moving.** Between Chromium 150 and 157 the attribute, the child requirement and
  the WebGPU call were all renamed. A future version may change them again.
- **Per-version drawing bugs**, listed in the table above. Test your own page against `--mode screenshot` with
  `tools/compare.mjs` before trusting it.
- **Browser backend stalls.** In one sweep of 200-frame runs headless Edge 157 stopped producing frames in 3 of
  the 4 element runs that wrote frames (`no canvas "paint" event within 10 s`), and its screenshot path hung twice. The cause was not
  found. The Electron backend completed every run. Prefer Electron.
- **Screenshot mode in Electron** uses an offscreen window (a hidden one never answers `Page.captureScreenshot`),
  and there the first frames of a WebGL canvas came back empty. Use the browser backend for reference screenshots
  of canvas pages.
- **Same origin only.** A page that redirects to another origin, or embeds cross-origin frames, has those parts
  left out. Remote `http(s)` pages are supported by design (the host document is injected on the page's origin
  through the DevTools protocol) but **were not tested**; only local pages were.
- **The page runs inside an iframe.** `window.top !== window`; `X-Frame-Options` and `frame-ancestors` are
  stripped by the Electron backend, not by the browser backend.
- **Text is greyscale-antialiased**, never LCD subpixel.
- **A `color-scheme` on the page that differs from the host's** makes the browser give the iframe an opaque
  backdrop: pass `--color-scheme dark` (or `light`) to keep transparency.
- **Canvas mode**: an asynchronous seek hook needs the canvas to keep its picture (`preserveDrawingBuffer: true`).
  The tool asks the canvas for its context to find out its kind; a canvas with **no context yet** when the page
  is ready gets one from that question, so create the context before the page reports ready. The direct WebGPU
  road copies the rows out one by one (3.4 ms) unless the canvas is a multiple of 64 pixels wide.
- **HDR**: element mode is 8-bit sRGB content (measured). `--transfer hlg` is not implemented. The float hook is
  WebGL2 only and slow. The input primaries are always taken as sRGB / Rec.709. `png16` clips to 0..1 (it holds
  HDR only as PQ). EXR files are uncompressed. HDR images and video inside a page were not tested.
- **Sub-frames** multiply the page's own work per frame by `n`; a seek hook that is slow stays slow `n` times.
- Not tested: sizes above 3440 x 1440, macOS, Linux, GPUs other than the one named above, web fonts loaded from
  files (system fonts were used), pages longer than 200 frames, three.js itself (the demos use WebGL2 and WebGPU
  directly).

## Failure messages

| message | cause and fix |
| --- | --- |
| `no Electron binary...` | set `ELECTRON_BIN`, pass `--electron`, install `electron`, or use `--browser` |
| `GPUQueue has neither copyElementImageToTexture nor drawElementImageToTexture` | this Chromium has no HTML-in-Canvas; run `tools/probe.mjs`, use Electron 43 or a newer browser, or `--mode canvas` |
| `WebGPU is not available` | no GPU process; do not pass `--disable-gpu` |
| `the page has no function window.__seek(t)` | define the hook, name it with `--seek`, or pass `--seek none` |
| `the first frame has no covered pixel at all` (warning) | the page was not drawn: cross-origin content, `mix-blend-mode` on Chromium 150, the page not ready yet (`--ready`), or a truly empty page |
| `the page ended up on another origin` | give the final URL; cross-origin frames are never drawn |
| `no canvas "paint" event within 10 s` | the renderer stopped producing frames (seen with the browser backend); run again or use Electron |
| `--mode canvas: the page has no <canvas> matching ...` | pass `--canvas <selector>` |
| `--ready "..." did not become true` | the expression never became truthy; check it in the page, raise `--timeout` |
| `window.__hgrFloatSource() names a float framebuffer, but the canvas ... has no WebGL2 context` | the hook's framebuffer must belong to the canvas `--canvas` selects |
| `--transfer, --input-transfer and --primaries need a float format` | add `--format raw16f`, `raw32f`, `exr` or `png16` |
| `--subframes needs --mode element or canvas` / `--format ... needs --mode element or canvas` | screenshot mode is 8-bit and cannot be summed |
| `frame N is not on disk in full` | the disk is full or the write failed; the run is not usable |
| `Page.captureScreenshot did not answer within 30 s` | screenshot mode hung in the browser; run again |

## Tools and tests

- `npm test` (`node test/run.mjs [--dpr 2] [--only <word>]`): renders the demos and checks the invariants above:
  frame order, canvas roads, formats, the four motion-blur checks, the six float checks. About 40 seconds at 3440
  x 1440. Needs the Electron binary.
- `node tools/probe.mjs [--electron <exe> | --browser <exe>]`: which API dialect a binary exposes, per switch.
- `node tools/compare.mjs <dirA> <dirB> [--frames 0,10 | 0-119] [--premultiply] [--quiet] [--diff out.png]`:
  maximum and mean difference between two 8-bit renders, how many pixels differ, and where.
- `node tools/bench.mjs [--frames 60] [--browser <exe>]`: the 8-bit timing table; each finished run is appended to
  `out/bench_results.txt`.
- Demo pages: `demo/page.html` (text, SVG, translucent boxes), `demo/motion.html` (fast motion, for the blur),
  `demo/canvas.html` (one WebGL2 canvas), `demo/canvas_webgpu.html` (one WebGPU canvas), `demo/hdr_webgpu.html`
  (float canvas with values up to 16), `demo/hdr_webgl.html` (WebGL2 float target and the hook), `demo/media.html`
  (WebGL, 2D canvas, img, video, backdrop-filter, blend modes). The WebGPU pages and media.html want
  `--ready "window.__ready"`.

## Licence

MIT, see [LICENSE](LICENSE).
