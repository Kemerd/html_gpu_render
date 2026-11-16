/**
 * probe_electron.cjs: the Electron side of tools/probe.mjs. Loads probe_page.html in a hidden window under the
 * switches named in HGR_PROBE_SWITCHES (';' separated, "--name" or "--name=value") and prints "PROBE {json}".
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

for (const s of (process.env.HGR_PROBE_SWITCHES || '').split(';').filter(Boolean)) {
  const text = s.replace(/^--/, ''), i = text.indexOf('=');
  if (i < 0) app.commandLine.appendSwitch(text); else app.commandLine.appendSwitch(text.slice(0, i), text.slice(i + 1));
}

// a profile folder of this run's own
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'html_gpu_render-probe-'));
app.setPath('userData', profile);
app.on('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the system */ } });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'probe_page.html'));
    const r = await win.webContents.executeJavaScript('window.__probe()');
    r.chrome = process.versions.chrome;
    r.electron = process.versions.electron;
    console.log('PROBE ' + JSON.stringify(r));
  } catch (e) {
    console.log('PROBE_ERR ' + String((e && e.message) || e));
  }
  app.exit(0);
});
