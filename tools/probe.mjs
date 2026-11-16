/**
 * probe.mjs: does a given runtime expose the HTML-in-Canvas API, and under which switch?
 *
 *   node tools/probe.mjs                                  the Electron in ELECTRON_BIN
 *   node tools/probe.mjs --electron <path>                an Electron binary
 *   node tools/probe.mjs --browser <path>                 Chrome / Edge / Chromium, headless
 *
 * Each runtime is started once per switch set (hidden, a few seconds each) and one line is printed per start:
 * the Chromium version and whether each entry point is there.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../src/cdp.mjs';
import { findElectron } from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// the switch sets worth trying; the first is the control
const SETS = [
  [],
  ['--enable-blink-features=CanvasDrawElement'],
  ['--enable-features=CanvasDrawElement'],
  ['--enable-experimental-web-platform-features'],
];

const line = (r, switches) => {
  const yes = (v) => (v ? 'yes' : 'no ');
  // which spelling of the API this build has: see README, "API dialects"
  const dialect = r.gpuQueue ? 'chromium-150 (layoutsubtree, copyElementImageToTexture)' : r.gpuQueueDraw ? 'chromium-157 (content="drawable", drawElementImageToTexture)' : 'none';
  return `${(switches.join(' ') || '(no switch)').padEnd(46)} dialect: ${dialect} | 2d.drawElementImage ${yes(r.draw2d)} gl.texElementImage2D ${yes(r.gl2)} gl.texElementSubImage2D ${yes(r.glSub)} GPUQueue.copyElementImageToTexture ${yes(r.gpuQueue)} GPUQueue.drawElementImageToTexture ${yes(r.gpuQueueDraw)} webgpu ${yes(r.hasGPU)}${r.adapter ? ' [' + r.adapter.trim() + ']' : ''}`;
};

if (opt('--browser')) {
  const exe = opt('--browser');
  for (const switches of SETS) {
    let browser = null;
    try {
      browser = await launch(exe, ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files', ...switches]);
      const version = await browser.version();
      const page = await browser.newPage();
      await page.send('Page.enable');
      const loaded = new Promise((r) => page.on('Page.loadEventFired', r));
      await page.send('Page.navigate', { url: pathToFileURL(resolve(HERE, 'probe_page.html')).href });
      await loaded;
      const r = await page.evaluate('window.__probe()');
      console.log(`${version.product}  ${line(r, switches)}`);
    } catch (e) {
      console.log(`${(switches.join(' ') || '(no switch)').padEnd(46)} FAILED: ${e.message}`);
    } finally {
      if (browser) await browser.close();
    }
  }
} else {
  const electron = findElectron(opt('--electron'));
  for (const switches of SETS) {
    // probe_electron.cjs prints one line "PROBE {json}"
    const out = await new Promise((res) => {
      const env = { ...process.env, HGR_PROBE_SWITCHES: switches.join(';') };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [resolve(HERE, 'probe_electron.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60000);
      child.on('exit', () => { clearTimeout(timer); res(text); });
    });
    const m = /PROBE (\{.*\})/.exec(out);
    if (!m) { console.log(`${(switches.join(' ') || '(no switch)').padEnd(46)} FAILED: ${(/PROBE_ERR (.*)/.exec(out) || [0, 'no answer from Electron'])[1]}`); continue; }
    const r = JSON.parse(m[1]);
    console.log(`Electron/${r.electron} Chrome/${r.chrome}  ${line(r, switches)}`);
  }
}
