import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function findBrowser() {
  for (const browser of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (root && existsSync(join(root, browser))) return join(root, browser);
    }
  }
  throw new Error('Install Chrome or Microsoft Edge to open the desktop window.');
}

export function openDesktop(port, secure = false) {
  if (process.platform !== 'win32') throw new Error('桌面小視窗需要 Windows。');
  const url = `${secure ? 'https' : 'http'}://localhost:${port}/?compact=1#today`;
  const browser = findBrowser();
  return new Promise((done, fail) => {
    const child = spawn(browser, [`--app=${url}`, '--window-size=365,460'], {
      detached: true, stdio: 'ignore', windowsHide: false
    });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      done();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.JOURNAL_PORT || 8776);
  const secure = Boolean(process.env.JOURNAL_CERT && process.env.JOURNAL_CERT_KEY);
  const health = `${secure ? 'https' : 'http'}://localhost:${port}/api/health`;
  const running = async () => {
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(700) });
      return response.ok && (await response.json()).service === 'bullet-journal';
    } catch {
      return false;
    }
  };
  if (!await running()) {
    const service = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    await new Promise((done, fail) => {
      service.once('spawn', done);
      service.once('error', fail);
    });
    service.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await running()) break;
      if (service.exitCode !== null) break;
      await delay(200);
    }
    if (!await running()) throw new Error('Could not start Bullet Journal. Check whether the port is already in use.');
  }
  await openDesktop(port, secure);
}
