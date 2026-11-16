/**
 * main.cjs: the Electron main process of html_gpu_render. Started by src/index.mjs (or bin/html-gpu-render.mjs)
 * with the whole configuration as JSON in the environment variable HGR_CONFIG. No window is ever shown.
 *
 * What it does:
 *   - turns on the HTML-in-Canvas API (--enable-blink-features=CanvasDrawElement) before Chromium starts
 *   - serves a local page over http://127.0.0.1 (src/serve.cjs), so it has a real origin
 *   - loads the host document (src/host.cjs) from the SAME ORIGIN as the page: a canvas around an <iframe> of the
 *     page. Same origin matters: the API draws nothing for a cross-origin frame (by design, and without an error)
 *   - fixes the viewport and the device scale factor through the DevTools protocol
 *   - tells the preload (src/preload.cjs) to run the frame loop, and exits with its result
 *
 * Configuration fields (all set by index.mjs): page, root, out, width, height, dpr, frames, fps, from, format
 * ('raw' | 'png' | 'stream' | 'none'), alpha ('premultiplied' | 'straight'), background, seek, ready, wait,
 * timeout, inflight, pngLevel, colorScheme, profile, ipcProbe, verbose, vsync, mode ('element' | 'canvas' |
 * 'screenshot'), canvas (a CSS selector, canvas mode).
 */
'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { HOST_PATH, hostHtml, locate, WAIT_FOR_FRAME, frameProblem } = require('./host.cjs');
const { screenshotLoop } = require('./screenshot.cjs');

const say = (...a) => console.log('[html_gpu_render]', ...a);
const fail = (message) => { console.error('[html_gpu_render] ERROR:', message); cleanup(); app.exit(1); };

// ── configuration ──
let cfg = null;
try { cfg = JSON.parse(process.env.HGR_CONFIG || ''); }
catch { console.error('[html_gpu_render] ERROR: HGR_CONFIG is missing or not JSON. Start this through bin/html-gpu-render.mjs.'); process.exit(2); }

// ── Chromium switches: these must be set before the app is ready ──
app.commandLine.appendSwitch('enable-blink-features', 'CanvasDrawElement');   // the HTML-in-Canvas API itself
app.commandLine.appendSwitch('force-color-profile', 'srgb');                  // the same colours on every monitor set-up
app.commandLine.appendSwitch('force-device-scale-factor', '1');               // the display's own scaling must not leak in
app.commandLine.appendSwitch('disable-renderer-backgrounding');               // a hidden window must not be slowed down
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (!cfg.vsync) {
  // a frame is produced as soon as it is asked for, not on the display's next refresh
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
for (const s of Array.isArray(cfg.switches) ? cfg.switches : []) {
  // extra switches from the caller: "name" or "name=value"
  const text = String(s).replace(/^--/, ''), i = text.indexOf('=');
  if (i < 0) app.commandLine.appendSwitch(text); else app.commandLine.appendSwitch(text.slice(0, i), text.slice(i + 1));
}

// a profile folder of this run's own: nothing is shared with any other Electron application
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'html_gpu_render-'));
app.setPath('userData', profile);

// If the process that started this one dies (Ctrl+C, a killed script), a hidden Electron must not stay behind.
const parent = process.ppid;
setInterval(() => {
  try { process.kill(parent, 0); }
  catch { cleanup(); app.exit(1); }
}, 2000).unref();

let closeServer = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (closeServer) closeServer();
}
// the profile folder can only go once Chromium has let go of it
app.on('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the system's temp cleaning */ } });

app.whenReady().then(async () => {
  // ── where the page is: a local file is served on the loopback interface ──
  let pageUrl, origin;
  try {
    const where = await locate(cfg);
    pageUrl = where.pageUrl; origin = where.origin; closeServer = where.close;
  } catch (e) { return fail(e.message); }

  // ── the window: never shown ──
  // Screenshot mode needs an offscreen window (a merely hidden one never answers Page.captureScreenshot), opaque
  // when a background colour is asked for, and no frame loop script. The other modes need the preload.
  const shots = cfg.mode === 'screenshot';
  const opaque = shots && cfg.background && cfg.background !== 'transparent';
  const win = new BrowserWindow({
    show: false, frame: false, transparent: !opaque, ...(opaque ? { backgroundColor: String(cfg.background).slice(0, 7) } : {}), skipTaskbar: true, focusable: false,
    width: Math.min(cfg.width, 1920), height: Math.min(cfg.height, 1080), useContentSize: true,
    webPreferences: shots
      ? { offscreen: true, backgroundThrottling: false }
      : { preload: path.join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.on('console-message', (event) => {
    const message = event && event.message !== undefined ? event.message : '';
    if (/Electron Security Warning/.test(message)) return;
    if (cfg.verbose || (event && (event.level === 'error' || event.level === 3))) console.log('[page]', message);
  });
  wc.on('render-process-gone', (_e, details) => fail(`the renderer process is gone (${details && details.reason}, exit code ${details && details.exitCode}).`));
  app.on('child-process-gone', (_e, details) => { if (details && details.type === 'GPU') console.error('[html_gpu_render] the GPU process is gone:', details.reason); });

  // the page must be allowed inside the host's frame, even if its server says X-Frame-Options or frame-ancestors
  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (/^x-frame-options$/i.test(key)) delete headers[key];
      else if (/^content-security-policy$/i.test(key)) headers[key] = headers[key].map((v) => String(v).split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';'));
    }
    done({ responseHeaders: headers });
  });

  // a preload that fails to load would leave the run waiting for ever: say so instead
  wc.on('preload-error', (_e, file, error) => fail(`the frame loop script did not load (${file}): ${error && error.message}`));
  let startedTimer = null;
  ipcMain.on('hgr:started', () => clearTimeout(startedTimer));

  // ── the frame loop's messages ──
  ipcMain.on('hgr:progress', (_e, p) => say(`${p.done} of ${p.of} frames`));
  ipcMain.handle('hgr:probe', (_e, data) => (data ? data.byteLength : 0));
  ipcMain.on('hgr:fail', (_e, message) => fail(message));
  const done = (summary) => {
    for (const w of summary.warnings || []) console.error('[html_gpu_render] WARNING:', w);
    say(`${summary.frames} frames of ${summary.pixels[0]} x ${summary.pixels[1]} in ${(summary.msTotal / 1000).toFixed(2)} s = ${summary.msPerFrame} ms per frame (${summary.framesPerSecond} frames per second), ${summary.format}, in ${cfg.out}`);
    if (cfg.profile || cfg.verbose) say('ms per stage (mean): ' + Object.entries(summary.ms).filter(([, v]) => v).map(([k, v]) => `${k} ${v.mean}`).join(', '));
    cleanup();
    app.exit(0);
  };
  ipcMain.on('hgr:done', (_e, summary) => done(summary));

  // a guard for the whole start-up: a page that never loads must not leave a hidden process behind
  const guard = setTimeout(() => fail(`the page did not finish loading within ${cfg.timeout} s: ${pageUrl}`), cfg.timeout * 1000);

  try {
    // the DevTools protocol needs a document to talk to before the device can be emulated
    await win.loadURL('about:blank');
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: cfg.width, height: cfg.height, deviceScaleFactor: cfg.dpr, mobile: false });
    await wc.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    if (shots) {
      // screenshot mode: the page itself, loaded directly, one DevTools screenshot per frame
      await win.loadURL(pageUrl);
      clearTimeout(guard);
      if (cfg.verbose) say(`Chromium ${process.versions.chrome}, Electron ${process.versions.electron}; page ${pageUrl}`);
      const summary = await screenshotLoop({ ...cfg, out: path.resolve(cfg.out) }, {
        send: (method, params) => wc.debugger.sendCommand(method, params),
        evaluate: (expression) => wc.executeJavaScript(expression),
        progress: (n, of) => say(`${n} of ${of} frames`),
      });
      summary.backend = 'electron';
      summary.chromium = process.versions.chrome;
      summary.electron = process.versions.electron;
      fs.mkdirSync(path.resolve(cfg.out), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(cfg.out), 'render.json'), JSON.stringify(summary, null, 2));
      return done(summary);
    }

    // the first document asked for on the page's origin is answered with the host document; nothing else is touched
    let served = false;
    wc.debugger.on('message', (_e, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      if (!served && params.request.url === origin + HOST_PATH) {
        served = true;
        wc.debugger.sendCommand('Fetch.fulfillRequest', {
          requestId: params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from(hostHtml(cfg, pageUrl), 'utf8').toString('base64'),
        }).catch((e) => fail(`could not serve the host document: ${e.message}`));
      } else {
        wc.debugger.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => { /* the request is gone */ });
      }
    });
    await wc.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: origin + HOST_PATH, requestStage: 'Request' }] });
    await win.loadURL(origin + HOST_PATH);
    await wc.debugger.sendCommand('Fetch.disable');

    // wait until the page inside the frame has loaded (it may already have)
    const state = await wc.executeJavaScript(WAIT_FOR_FRAME);
    if (state !== 'ok') return fail(frameProblem(state, pageUrl, origin));
    clearTimeout(guard);

    if (cfg.verbose) say(`Chromium ${process.versions.chrome}, Electron ${process.versions.electron}; page ${pageUrl}`);
    wc.send('hgr:start', { ...cfg, out: path.resolve(cfg.out), page: cfg.page });
    startedTimer = setTimeout(() => fail('the frame loop did not answer within 15 s (the preload script is not running in the host document).'), 15000);
  } catch (e) {
    clearTimeout(guard);
    fail((e && e.message) || String(e));
  }
});

// no window is ever shown, and closing the only one must not quit before the result is out
app.on('window-all-closed', () => { /* the run ends through app.exit */ });
