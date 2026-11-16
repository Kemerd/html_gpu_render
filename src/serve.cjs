/**
 * serve.cjs: a small static file server on 127.0.0.1, used when the page to render is a local file.
 *
 * A page opened as file:// has an opaque origin: module scripts, fetch() and fonts from sibling files are refused,
 * and the host document this tool wraps around the page could not be made same-origin with it. Serving the folder
 * over http on the loopback interface removes all of that. Nothing outside the root folder is ever sent.
 *
 *   const { url, close } = await serve(rootDir)       // url is 'http://127.0.0.1:<port>'
 *   await serve(rootDir, (req, res) => handledOrNot)   // a handler may answer requests of its own first
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// the content types a page normally asks for; anything else is sent as bytes
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
};

/**
 * Starts the server.
 * @param {string} rootDir   the folder that becomes '/'
 * @param {(req, res) => boolean} [handler]   called first for every request; returns true when it has answered
 * @returns {Promise<{ url: string, port: number, close: () => void }>}
 */
function serve(rootDir, handler) {
  const root = path.resolve(String(rootDir || '.'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return Promise.reject(new Error(`serve: not a folder: ${root}`));

  const server = http.createServer((req, res) => {
    if (typeof handler === 'function' && handler(req, res)) return;
    let rel;
    try { rel = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]); }
    catch { res.writeHead(400); res.end('bad request'); return; }
    // resolve inside the root and refuse anything that climbs out of it
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) file = path.join(file, 'index.html');
      fs.stat(file, (err2, st2) => {
        if (err2 || !st2.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
        const head = { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
        // byte ranges, which <video> asks for
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (m && (m[1] || m[2])) {
          const start = m[1] ? Number(m[1]) : Math.max(0, st2.size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), st2.size - 1) : st2.size - 1;
          if (!(start <= end) || start >= st2.size) { res.writeHead(416, { 'content-range': `bytes */${st2.size}` }); res.end(); return; }
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st2.size}`, 'content-length': end - start + 1 });
          fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
          return;
        }
        res.writeHead(200, { ...head, 'content-length': st2.size });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.keepAliveTimeout = 600000;             // a page keeps its connections open between frames
    // port 0: the system picks a free one; loopback only, so nothing on the network can reach it
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); server.closeAllConnections && server.closeAllConnections(); } catch { /* already closed */ } } });
    });
  });
}

module.exports = { serve };
