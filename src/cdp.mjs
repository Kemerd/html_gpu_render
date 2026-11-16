/**
 * cdp.mjs: starts a headless Chromium-family browser (Chrome, Edge, Chromium) and talks the DevTools protocol to it
 * over its WebSocket, with nothing but Node (22 or newer, for the built-in WebSocket). Used by the browser backend
 * (src/browser.mjs), the probe and the screenshot baseline.
 *
 *   const browser = await launch(exePath, ['--some-switch']);
 *   const page = await browser.newPage();                 // { send(method, params), on(event, fn) }
 *   await page.send('Page.navigate', { url });
 *   await browser.close();
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} exe        the browser executable
 * @param {string[]} switches extra command line switches
 */
export async function launch(exe, switches = []) {
  if (!exe || !existsSync(exe)) throw new Error(`the browser executable does not exist: ${exe}`);
  if (typeof WebSocket === 'undefined') throw new Error('this Node has no built-in WebSocket: Node 22 or newer is needed.');
  // a profile of its own, so the user's browser profile is never touched
  const profile = mkdtempSync(join(tmpdir(), 'html_gpu_render-browser-'));
  const child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', ...switches, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  // the browser prints the address of its DevTools socket on stderr
  const wsUrl = await new Promise((res, rej) => {
    let text = '';
    const timer = setTimeout(() => rej(new Error('the browser did not print a DevTools address within 30 s.')), 30000);
    child.stderr.on('data', (d) => {
      text += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`the browser exited (code ${code}) before it was ready.`)); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('could not connect to the DevTools socket.')), { once: true }); });

  // one socket, many sessions: answers are matched by id, events are handed to the session's listeners
  let nextId = 1;
  const waiting = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { res, rej, method } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`)); else res(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(`${msg.sessionId || ''}:${msg.method}`) || []) fn(msg.params);
    }
  });
  // a browser that dies must not leave its callers waiting for ever
  let gone = null;
  child.on('exit', (code) => {
    gone = new Error(`the browser process is gone (exit code ${code}).`);
    for (const { rej } of waiting.values()) rej(gone);
    waiting.clear();
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    if (gone) return rej(gone);
    const id = nextId++;
    waiting.set(id, { res, rej, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  return {
    pid: child.pid,
    /** The product and version line, e.g. "Chrome/150.0.0.0". */
    version: () => send('Browser.getVersion'),
    async newPage() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return {
        send: (method, params) => send(method, params, sessionId),
        on: (event, fn) => { const k = `${sessionId}:${event}`; listeners.set(k, [...(listeners.get(k) || []), fn]); },
        /** Evaluates an expression in the page and gives back its (awaited) value. */
        async evaluate(expression) {
          const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
          if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
          return r.result.value;
        },
      };
    },
    async close() {
      // ask the browser to leave; make sure of it by its own pid; then drop the profile
      try { await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* already gone */ }
      await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(() => { try { child.kill(); } catch { /* gone */ } r(); }, 3000); } });
      try { ws.close(); } catch { /* closed */ }
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the system's temp cleaning */ }
    },
  };
}
