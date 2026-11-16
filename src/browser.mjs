/**
 * browser.mjs: the browser backend. The same frame loop (src/driver.cjs) runs inside a headless Chrome / Edge /
 * Chromium that already has the HTML-in-Canvas API, driven over the DevTools protocol. No Electron is needed.
 *
 * The one difference from the Electron backend is how a frame leaves the page: a web page has no file system, so
 * each frame is POSTed as raw bytes to a server on 127.0.0.1 in this Node process, which writes it
 * (src/sink.cjs). No base64 and no screenshot are involved; the cost is one copy over the loopback interface.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch } from './cdp.mjs';

const require = createRequire(import.meta.url);
const { driver } = require('./driver.cjs');
const { makeSink } = require('./sink.cjs');
const { HOST_PATH, hostHtml, locate, WAIT_FOR_FRAME, frameProblem } = require('./host.cjs');
const { screenshotLoop } = require('./screenshot.cjs');

/** The path frames are POSTed to: <FRAME_PATH>/<token>/<index>. The token is random per run. */
const FRAME_PATH = '/__html_gpu_render_frame__';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };

/**
 * Answers a frame upload (POST <FRAME_PATH>/<token>/<index>, the frame's bytes as the body) and its CORS preflight.
 * Returns false for any other request. The token keeps every other page on this machine from writing frames.
 */
function takeFrame(req, res, getSink, token) {
  const url = String(req.url || '');
  if (!url.startsWith(`${FRAME_PATH}/${token}/`)) return false;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true; }
  // <index>?w=<width>&h=<height>: the size comes with the frame, because only the loop in the page knows it
  const m = /^(\d+)\?w=(\d+)&h=(\d+)$/.exec(url.slice(`${FRAME_PATH}/${token}/`.length));
  if (req.method !== 'POST' || !m) { res.writeHead(404, CORS); res.end('not found'); return true; }
  const index = Number(m[1]);
  const length = Number(req.headers['content-length']);
  // the body arrives in pieces: they go straight into one buffer of the known size
  const body = Buffer.allocUnsafe(length);
  let at = 0;
  req.on('data', (chunk) => { if (at + chunk.length <= length) chunk.copy(body, at); at += chunk.length; });
  req.on('error', () => { res.writeHead(400, CORS); res.end('the upload broke off'); });
  req.on('end', () => {
    if (at !== length) { res.writeHead(400, CORS); res.end(`the upload was ${at} bytes, not ${length}`); return; }
    getSink(Number(m[2]), Number(m[3])).then((sink) => {
      if (length !== sink.frameBytes) throw new Error(`expected ${sink.frameBytes} bytes, got ${length}`);
      return sink.write(index, body);
    }).then(
      () => { res.writeHead(204, CORS); res.end(); },
      (e) => { res.writeHead(500, CORS); res.end(String((e && e.message) || e)); },
    );
  });
  return true;
}

/** A frame server of its own, for a remote page (whose origin this process does not serve). */
function frameServer(getSink, token) {
  const server = http.createServer((req, res) => { if (!takeFrame(req, res, getSink, token)) { res.writeHead(404, CORS); res.end('not found'); } });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.keepAliveTimeout = 600000;           // the page keeps its connections open between frames
    server.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${server.address().port}`, close: () => { try { server.close(); server.closeAllConnections && server.closeAllConnections(); } catch { /* closed */ } } }));
  });
}

/**
 * Renders with a headless browser.
 * @param {object} o        normalised options (src/index.mjs)
 * @param {string} exe      the browser executable
 * @param {(line: string) => void} onLine
 * @returns {Promise<object>} the summary, also written to <out>/render.json
 */
export async function renderInBrowser(o, exe, onLine) {
  const say = (text) => onLine(`[html_gpu_render] ${text}`);
  const W = Math.round(o.width * o.dpr), H = Math.round(o.height * o.dpr);
  let where = null, frames = null, browser = null, sink = null;
  try {
    const token = randomBytes(16).toString('hex');
    // the sink is made when the first frame arrives and says its size
    let sinkMade = null;
    const getSink = (width, height) => sinkMade || (sinkMade = makeSink({ out: o.out, format: o.format, width, height, frames: o.frames, pngLevel: o.pngLevel, fsync: o.fsync, preallocate: o.preallocate, transfer: o.transfer || o.inputTransfer, primaries: o.primaries }).then((made) => { sink = made; return made; }));
    // A local page: the server that serves it also hands out the host document and takes the frames, so
    // everything is one origin. A remote page: the host document is slipped in through the DevTools protocol and
    // the frames go to a second server on the loopback interface.
    where = await locate(o, (req, res) => {
      if (takeFrame(req, res, getSink, token)) return true;
      if (String(req.url || '').split('?')[0] !== HOST_PATH) return false;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(hostHtml(o, where.pageUrl));
      return true;
    });
    if (!where.local) frames = await frameServer(getSink, token);
    const postUrl = `${where.local ? where.origin : frames.url}${FRAME_PATH}/${token}/`;

    browser = await launch(exe, [
      '--enable-blink-features=CanvasDrawElement',          // needed before Chromium 157, harmless after
      '--force-device-scale-factor=1', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      // a remote page posting frames to 127.0.0.1 is a request into the local network, which the browser would
      // refuse without a permission prompt nobody can answer in a headless run
      ...(where.local ? [] : ['--disable-features=LocalNetworkAccessChecks']),
      ...(o.vsync ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync']),
      ...o.switches.map((s) => (String(s).startsWith('--') ? String(s) : '--' + s)),
    ]);
    const version = await browser.version();
    const page = await browser.newPage();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    page.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
      const m = /^__hgr_progress__ (\d+) (\d+)$/.exec(text);
      if (m) say(`${m[1]} of ${m[2]} frames`);
      else if (o.verbose || e.type === 'error') onLine(`[page] ${text}`);
    });
    await page.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.dpr, mobile: false });
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // load with a limit: a page that never loads must not leave a hidden browser behind
    const limit = (promise, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} within ${o.timeout} s: ${where.pageUrl}`)), o.timeout * 1000).unref())]);
    const finish = (summary) => {
      summary.backend = 'browser';
      summary.browser = version.product;
      mkdirSync(o.out, { recursive: true });
      writeFileSync(resolve(o.out, 'render.json'), JSON.stringify(summary, null, 2));
      for (const w of summary.warnings || []) onLine(`[html_gpu_render] WARNING: ${w}`);
      say(`${summary.frames} frames of ${summary.pixels[0]} x ${summary.pixels[1]} in ${(summary.msTotal / 1000).toFixed(2)} s = ${summary.msPerFrame} ms per frame (${summary.framesPerSecond} frames per second), ${summary.format}, in ${o.out}`);
      if (o.profile || o.verbose) say('ms per stage (mean): ' + Object.entries(summary.ms).filter(([, v]) => v).map(([k, v]) => `${k} ${v.mean}`).join(', '));
      return summary;
    };

    if (o.mode === 'screenshot') {
      // screenshot mode: the page itself, loaded directly, one DevTools screenshot per frame
      const shown = new Promise((r) => page.on('Page.loadEventFired', r));
      await page.send('Page.navigate', { url: where.pageUrl });
      await limit(shown, 'the page did not finish loading');
      if (o.verbose) say(`${version.product}; page ${where.pageUrl}`);
      return finish(await screenshotLoop(o, { send: (method, params) => page.send(method, params), evaluate: (expression) => page.evaluate(expression), progress: (n, of) => say(`${n} of ${of} frames`) }));
    }

    // a remote page: the request for the host document, on the page's own origin, is answered here
    if (!where.local) page.on('Fetch.requestPaused', (params) => {
      if (params.request.url === where.origin + HOST_PATH) {
        page.send('Fetch.fulfillRequest', {
          requestId: params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from(hostHtml(o, where.pageUrl), 'utf8').toString('base64'),
        }).catch(() => { /* the request is gone */ });
      } else {
        page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => { /* the request is gone */ });
      }
    });
    if (!where.local) await page.send('Fetch.enable', { patterns: [{ urlPattern: where.origin + HOST_PATH, requestStage: 'Request' }] });

    // load the host document
    const loaded = new Promise((r) => page.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: where.origin + HOST_PATH });
    await limit(loaded, 'the page did not finish loading');
    const state = await limit(page.evaluate(WAIT_FOR_FRAME), 'the page did not finish loading');
    if (state !== 'ok') throw new Error(frameProblem(state, where.pageUrl, where.origin));
    if (o.verbose) say(`${version.product}; page ${where.pageUrl}`);

    // the frame loop, sent into the host document as source text; the page is reached directly (same origin)
    const cfg = { ...o, electron: undefined, browser: undefined };
    const summary = JSON.parse(await page.evaluate(`(async () => {
      const frame = document.getElementById('hgr-frame');
      const post = ${JSON.stringify(postUrl)};
      const writes = ${JSON.stringify(o.format !== 'none')};
      const env = {
        has: async (name) => typeof frame.contentWindow[name] === 'function',
        // not an async function on purpose: the hook must have run when this returns (canvas mode copies right after)
        seek: (name, t) => { const v = frame.contentWindow[name](t); return v && typeof v.then === 'function' ? v.then(() => 'async') : Promise.resolve('sync'); },
        fonts: () => frame.contentWindow.document.fonts.ready,
        test: async (expr) => !!frame.contentWindow.eval(expr),
        take: (bytes) => new Uint8Array(bytes),
        // the float hook: the page names a WebGL2 framebuffer with a float attachment (README, "HDR")
        floatInfo: async (name) => { const f = frame.contentWindow[name]; const s = typeof f === 'function' ? f() : null; return s && s.framebuffer ? { width: s.width | 0, height: s.height | 0 } : null; },
        floatBind: (name) => {
          const s = frame.contentWindow[name]();
          const gl = frame.contentDocument.querySelector(${JSON.stringify(o.canvas || 'canvas')}).getContext('webgl2');
          env.kept = { gl, binding: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) };
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.framebuffer);
        },
        floatUnbind: () => { if (env.kept) env.kept.gl.bindFramebuffer(env.kept.gl.READ_FRAMEBUFFER, env.kept.binding); env.kept = null; },
        write: async (i, buf, width, height) => {
          if (!writes) return;
          // a connection the server has just let go of fails once with a TypeError: try again before giving up
          for (let attempt = 0; ; attempt++) {
            let r = null;
            try { r = await fetch(post + i + '?w=' + width + '&h=' + height, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } }); }
            catch (e) { if (attempt < 3) continue; throw new Error('frame ' + i + ': could not reach the frame server (' + e.message + ')'); }
            if (!r.ok) throw new Error('frame ' + i + ': the frame server answered ' + r.status + ' ' + (await r.text()));
            return;
          }
        },
        progress: (done, of) => console.log('__hgr_progress__ ' + done + ' ' + of),
      };
      return JSON.stringify(await (${driver.toString()})(${JSON.stringify(cfg)}, env));
    })()`));

    // closing checks that every frame is on disk in full; a failed check fails the run
    const closing = sink;
    sink = null;
    if (closing) await closing.close();
    return finish(summary);
  } catch (e) {
    // errors thrown inside the page arrive wrapped; show the tool's own message
    const message = String((e && e.message) || e).replace(/^in the page: (Error: )?/, '').split('\n')[0];
    onLine(`[html_gpu_render] ERROR: ${message}`);
    throw new Error(message);
  } finally {
    // in this order: the browser first, so nothing is still posting when the servers go
    if (browser) await browser.close();
    if (frames) frames.close();
    if (sink) await sink.close().catch(() => { /* the run has already failed for another reason */ });
    if (where) where.close();
  }
}
