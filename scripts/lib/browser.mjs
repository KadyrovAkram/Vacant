// Find Chrome, drive it over CDP, and serve this repo the way Pages does.
//
// Lifted whole out of scripts/shoot.mjs when scripts/launch-desktop.mjs needed
// the same three things. Everything here is about the browser and the wire;
// nothing here knows what Vacant is. The comments are the originals, because
// each one is a bug somebody already paid for.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// ------------------------------------------------------------------ browser

function chromePaths() {
  const env = process.env.CHROME || process.env.CHROME_PATH;
  if (env) return [env];
  const pf = process.env['ProgramFiles'] || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  if (process.platform === 'win32') {
    return [
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Google/Chrome/Application/chrome.exe`,
      `${local}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Chromium/Application/chrome.exe`,
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // Containers often have no Chrome on PATH but do have the one Playwright
    // downloaded, under PLAYWRIGHT_BROWSERS_PATH or its default cache. The
    // list above missed it and this repo was twice told the machine had no
    // browser, while /opt/pw-browsers/chromium-1194 (Chromium 141) sat there
    // and drove the shoot fine. Newest build first: the dirs are versioned.
    ...playwrightChromiums(),
  ];
}

// chromium-<build>/chrome-linux/chrome under each Playwright browsers root.
// Only the directory listing is done here; findChrome still checks the file.
function playwrightChromiums() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')];
  const found = [];
  for (const root of roots) {
    if (!root) continue;
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // no such root on this machine
    }
    const builds = entries
      .filter((e) => /^chromium-\d+$/.test(e))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const b of builds) found.push(path.join(root, b, 'chrome-linux', 'chrome'));
  }
  return found;
}

function findChrome() {
  for (const p of chromePaths()) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    'no Chrome found. Set CHROME to the binary, for example\n' +
      '  CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/shoot.mjs',
  );
}

// Chrome writes the port it actually took into DevToolsActivePort, which is
// the only reliable way to read it back when you ask for port 0.
export async function launch() {
  const bin = findChrome();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'vacant-shoot-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      // Chromium's sandbox needs a non-root user to drop privileges to, and
      // refuses to start at all without one: as root it exits 1 before it ever
      // writes DevToolsActivePort, which surfaced here as "chrome exited with
      // 1" and got read as "no browser on this machine". CI and container runs
      // are root, so the flag is added there and only there — on a normal
      // desktop account the sandbox stays on, which is the point of asking.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // Kept, not dropped. This line used to be `child.stderr.resume()`, which threw
  // the browser's own explanation away and left a bare "chrome exited with 1" --
  // and two people concluded from that message that no browser existed here,
  // when the real text named the sandbox and the fix was one flag. The tail is
  // bounded because a failing Chromium can be chatty.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.lastStderr = () => stderr.trim();

  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (child.exitCode !== null) {
      const said = child.lastStderr();
      throw new Error(`chrome exited with ${child.exitCode}${said ? `\n${said}` : ''}`);
    }
    try {
      const [port] = (await fsp.readFile(portFile, 'utf8')).split('\n');
      if (port) return { child, profile, port: Number(port) };
    } catch {
      /* not written yet */
    }
    await sleep(60);
  }
  throw new Error('chrome never published a debugging port');
}

// A DevTools client small enough to read. Node 22 ships the WebSocket, so this
// costs the project nothing, which is the rule the rest of the repo follows.
export class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const pending = this.waiting.get(msg.id);
        if (!pending) return;
        this.waiting.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
        else pending.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await once(ws, 'open');
    return new Devtools(ws);
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// ------------------------------------------------------------------- server

export async function serve(rootPath, preferredPort) {
  const root = path.resolve(rootPath);
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/Vacant/')) p = p.slice(7);
    else if (p === '/Vacant') p = '/';
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(root, `.${p}`);
    // path.relative, not startsWith. A string prefix test lets a SIBLING of the
    // root through whenever its name begins with the root's: `%2f` survives the
    // URL's own dot-segment removal, so GET /Vacant/..%2fVacant-notes/s.txt
    // decoded to /../Vacant-notes/s.txt, joined to <parent>/Vacant-notes/s.txt,
    // and "starts with <parent>/Vacant" is true of it.
    const inside = path.relative(root, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('404 ' + p);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
  for (const port of [preferredPort, 0]) {
    try {
      server.listen(port);
      await once(server, 'listening');
      return server;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('could not bind a port');
}
