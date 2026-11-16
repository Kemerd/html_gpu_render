/**
 * host.cjs: the host document both backends wrap around the page, and how a local page gets a URL.
 *
 * The host document is served from the SAME ORIGIN as the page, at HOST_PATH (the request for it is answered
 * through the DevTools protocol and never reaches the network). Same origin matters: HTML-in-Canvas draws nothing
 * for a cross-origin frame, by design and without an error.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { serve } = require('./serve.cjs');

/** The path, on the page's own origin, that the host document is served from. */
const HOST_PATH = '/__html_gpu_render_host__';

/**
 * The host document: one canvas whose child is the page, both exactly the size of the frame. The canvas carries
 * the attributes of both API dialects: layoutsubtree (Chromium 150) and content="drawable" with a drawable child
 * (Chromium 157).
 */
function hostHtml(cfg, pageUrl) {
  const w = cfg.width, h = cfg.height, pw = Math.round(w * cfg.dpr), ph = Math.round(h * cfg.dpr);
  const scheme = cfg.colorScheme ? `<meta name="color-scheme" content="${String(cfg.colorScheme).replace(/[^a-z ]/gi, '')}">` : '';
  const src = String(pageUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8">${scheme}<title>html_gpu_render host</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  #hgr-canvas { position: fixed; left: 0; top: 0; width: ${w}px; height: ${h}px; }
  #hgr-frame { position: absolute; left: 0; top: 0; width: ${w}px; height: ${h}px; border: 0; background: transparent; }
</style></head><body>
<canvas id="hgr-canvas" layoutsubtree content="drawable" width="${pw}" height="${ph}"><iframe id="hgr-frame" drawable src="${src}"></iframe></canvas>
</body></html>`;
}

/**
 * Gives the page a URL: an http(s) page keeps its own; a local file gets its folder (or cfg.root) served on the
 * loopback interface.
 * @param {object} cfg
 * @param {(req, res) => boolean} [handler]   extra routes on the local server (see serve.cjs); unused for a remote page
 * @returns {Promise<{ pageUrl: string, origin: string, local: boolean, close: () => void }>}
 */
async function locate(cfg, handler) {
  let pageUrl = String(cfg.page || '');
  let close = () => {};
  let local = false;
  if (!/^https?:\/\//i.test(pageUrl)) {
    const file = path.resolve(pageUrl.replace(/^file:\/\/\/?/i, ''));
    if (!fs.existsSync(file)) throw new Error(`the page does not exist: ${file}`);
    const root = path.resolve(cfg.root || path.dirname(file));
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`the page ${file} is not inside --root ${root}`);
    const server = await serve(root, handler);
    close = server.close;
    local = true;
    const query = cfg.query ? (String(cfg.query).startsWith('?') ? cfg.query : '?' + cfg.query) : '';
    pageUrl = `${server.url}/${rel.split(path.sep).map(encodeURIComponent).join('/')}${query}`;
  }
  return { pageUrl, origin: new URL(pageUrl).origin, local, close };
}

/** Runs in the host document: resolves 'ok' when the page inside the frame has loaded, or says what is wrong. */
const WAIT_FOR_FRAME = `new Promise((resolve) => {
  const frame = document.getElementById('hgr-frame');
  if (!frame) return resolve('no-host');
  const check = () => {
    let doc = null;
    try { doc = frame.contentDocument; } catch (e) { return resolve('cross-origin'); }
    if (!doc) return resolve('cross-origin');
    if (doc.readyState === 'complete' && doc.location.href !== 'about:blank') return resolve('ok');
    return false;
  };
  if (check() === false) frame.addEventListener('load', () => { if (check() === false) resolve('not-loaded'); });
})`;

/** The plain message for each answer of WAIT_FOR_FRAME other than 'ok'. */
function frameProblem(state, pageUrl, origin) {
  if (state === 'no-host') return 'the host document was not loaded (the request for it was not intercepted).';
  if (state === 'cross-origin') return `the page ended up on another origin than ${origin} (a redirect?). HTML-in-Canvas draws nothing for a cross-origin frame. Give the final URL of the page.`;
  return `the page did not load inside the frame: ${pageUrl}`;
}

module.exports = { HOST_PATH, hostHtml, locate, WAIT_FOR_FRAME, frameProblem };
