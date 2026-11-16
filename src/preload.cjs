/**
 * preload.cjs: the Electron backend's end of the frame loop. Runs in the host document's isolated world (an
 * Electron preload with Node available) and gives src/driver.cjs what it needs:
 *
 *   - the page's hook is called in the page's own world (webFrame.executeJavaScript)
 *   - frames are written with Node's fs from this same process, straight out of the GPU-mapped memory where the
 *     road allows it: no base64, no screenshot, no hop to another process, no copy
 *
 * Nothing here is exposed to the page: the page's world and this one only share the DOM.
 */
'use strict';
const { ipcRenderer, webFrame } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { driver } = require('./driver.cjs');
const { makeSink } = require('./sink.cjs');

/** Runs a snippet in the page's main world and gives back its (awaited) value. */
const inMain = (code) => webFrame.executeJavaScript(code, false);

async function run(cfg) {
  // helpers in the main world, reached by name from here: the frame's window is the page
  await inMain(`(() => {
    const frame = document.getElementById('hgr-frame');
    window.__hgr = {
      has: (name) => typeof frame.contentWindow[name] === 'function',
      // 'sync' or 'async': whether the hook returned a promise (the hook has run by the time this returns)
      seek: (name, t) => { const v = frame.contentWindow[name](t); return v && typeof v.then === 'function' ? v.then(() => 'async') : 'sync'; },
      fonts: () => frame.contentWindow.document.fonts.ready.then(() => true),
      test: (expr) => !!frame.contentWindow.eval(expr),
      // the float hook: the page names a WebGL2 framebuffer with a float attachment (README, "HDR")
      floatInfo: (name) => { const f = frame.contentWindow[name]; const s = typeof f === 'function' ? f() : null; return s && s.framebuffer ? { width: s.width | 0, height: s.height | 0 } : null; },
      floatBind: (name) => {
        const s = frame.contentWindow[name]();
        const canvas = frame.contentDocument.querySelector(${JSON.stringify(cfg.canvas || 'canvas')});
        const gl = canvas.getContext('webgl2');
        window.__hgr.kept = { gl, binding: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) };
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.framebuffer);
      },
      floatUnbind: () => { const k = window.__hgr.kept; if (k) k.gl.bindFramebuffer(k.gl.READ_FRAMEBUFFER, k.binding); window.__hgr.kept = null; },
    };
  })()`);

  // the frame size is only known once the driver has looked at the page (canvas mode), so the sink is made on the first frame
  let sinkMade = null;
  const sinkFor = (width, height) => sinkMade || (sinkMade = makeSink({ out: cfg.out, format: cfg.format, width, height, frames: cfg.frames, pngLevel: cfg.pngLevel, fsync: cfg.fsync, preallocate: cfg.preallocate, transfer: cfg.transfer || cfg.inputTransfer, primaries: cfg.primaries }));
  let summary;
  try {
    summary = await driver(cfg, {
      has: (name) => inMain(`__hgr.has(${JSON.stringify(name)})`),
      seek: (name, t) => inMain(`__hgr.seek(${JSON.stringify(name)}, ${Number(t)})`),
      fonts: () => inMain('__hgr.fonts()'),
      test: (expr) => inMain(`__hgr.test(${JSON.stringify(expr)})`),
      take: (bytes) => Buffer.allocUnsafe(bytes),
      // the bytes may be GPU-mapped memory: a Buffer over the same memory (no copy) goes to fs, which reads it on
      // a thread-pool thread while the driver keeps it mapped
      write: async (i, bytes, width, height) => (await sinkFor(width, height)).write(i, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)),
      floatInfo: (name) => inMain(`__hgr.floatInfo(${JSON.stringify(name)})`),
      floatBind: (name) => { inMain(`__hgr.floatBind(${JSON.stringify(name)})`); },
      floatUnbind: () => { inMain('__hgr.floatUnbind()'); },
      // measurement only: the cost of also sending the frame to the main process over IPC
      probe: (buf) => ipcRenderer.invoke('hgr:probe', buf),
      progress: (done, of) => ipcRenderer.send('hgr:progress', { done, of }),
    });
  } finally {
    // closing also checks that every frame is on disk in full; a failed check fails the run
    if (sinkMade) { const sink = await sinkMade.catch(() => null); if (sink) await sink.close(); }
  }
  summary.backend = 'electron';
  summary.chromium = process.versions.chrome;
  summary.electron = process.versions.electron;
  fs.mkdirSync(cfg.out, { recursive: true });
  fs.writeFileSync(path.join(cfg.out, 'render.json'), JSON.stringify(summary, null, 2));
  return summary;
}

// main.cjs says when the page is loaded; the answer goes back the same way
ipcRenderer.on('hgr:start', (_event, cfg) => {
  ipcRenderer.send('hgr:started');
  run(cfg).then(
    (summary) => ipcRenderer.send('hgr:done', summary),
    (err) => ipcRenderer.send('hgr:fail', String((err && err.message) || err)),
  );
});
