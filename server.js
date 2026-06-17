#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Persist registered roots in the user's config dir, not inside the package —
// when run via `npx`, the package dir is ephemeral and often read-only.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'pocketspec')
  : path.join(os.homedir(), '.config', 'pocketspec');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// Older versions wrote config.json next to server.js; read it as a fallback.
const LEGACY_CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

// Shared-daemon coordination files. `pocketspec` with no folder args is the
// single shared instance every agent/window converges on; these two files let
// other processes discover it and feed it folders without spawning a new server.
//   instance.json  — { pid, port, local, network[], startedAt }, written on
//                     listen and removed on exit. The discovery record.
//   live-roots.json — ad-hoc folders attached at runtime. Served alongside the
//                     persisted config roots, read live per request, and wiped
//                     when the shared daemon exits (ephemeral by design).
const INSTANCE_PATH = path.join(CONFIG_DIR, 'instance.json');
const LIVE_ROOTS_PATH = path.join(CONFIG_DIR, 'live-roots.json');

// ---------- config (persisted roots, used by the `add`/`list` subcommands) ----------

function loadConfig() {
  const src = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH
    : fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH
    : null;
  if (!src) return { roots: [] };
  try {
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    return { roots: Array.isArray(data.roots) ? data.roots : [] };
  } catch {
    return { roots: [] };
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------- shared-daemon state (live roots + instance record) ----------

function loadLiveRoots() {
  if (!fs.existsSync(LIVE_ROOTS_PATH)) return { roots: [] };
  try {
    const data = JSON.parse(fs.readFileSync(LIVE_ROOTS_PATH, 'utf8'));
    return { roots: Array.isArray(data.roots) ? data.roots : [] };
  } catch {
    return { roots: [] };
  }
}

function saveLiveRoots(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Write-then-rename so a concurrent reader never sees a half-written file
  // (two windows may attach at once).
  const tmp = `${LIVE_ROOTS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, LIVE_ROOTS_PATH);
}

// Best-effort realpath; falls back to a plain resolve for not-yet-existing paths
// so dedup/lookup still work on a stable key.
function rootKey(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Returns the live instance record, or null. Clears a stale file (dead pid).
function readInstance() {
  if (!fs.existsSync(INSTANCE_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8'));
    if (data && isPidAlive(data.pid)) return data;
  } catch { /* fall through to clear */ }
  try { fs.unlinkSync(INSTANCE_PATH); } catch {}
  return null;
}

function writeInstance(info) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(INSTANCE_PATH, JSON.stringify(info, null, 2) + '\n');
}

// ---------- CLI parsing ----------
// Usage:
//   pocketspec [folder ...] [--port N] [--read-only]   serve folders (ephemeral)
//   pocketspec add <path> [name]                       register a persistent folder
//   pocketspec list                                    list persisted folders
//
// Folder arguments are served as ephemeral roots (not written to config.json).
// With no folder arguments, falls back to roots saved via `add`.

function printHelp() {
  console.log(`pocketspec — read your markdown docs on your phone, comment, let your agent read back

Usage:
  pocketspec [folder ...] [--port N] [--read-only]
  pocketspec                         run the shared instance (serves attached + saved folders)
  pocketspec attach <folder|file>    add a folder to the running shared instance, print its phone URL
  pocketspec detach <folder|file>    remove a folder from the shared instance
  pocketspec status [--json]         show the running shared instance (URL/port), if any
  pocketspec add <folder> [name]     register a persistent folder
  pocketspec list                    list registered folders

With folder arguments, runs a private, independent instance on its own port.
With none, runs the single shared instance: serves the folders saved via 'add'
plus any attached at runtime, and every 'pocketspec' / 'attach' converges on it.
Teach your agent the phone-review loop: npx skills add lucassmatos/pocketspec
  --port N        starting port (default 4321; tries the next free one if taken)
  --read-only     disable editing and comments (read-only)
  --password P    require a password (HTTP Basic Auth)
                  safer: set POCKETSPEC_PASSWORD instead of passing it on the CLI
  --host H        allow an extra Host header (repeatable) on top of the built-in
                  loopback/LAN/Tailscale allowlist; use for a custom hostname.
                  Also: POCKETSPEC_HOST=h1,h2`);
}

const argv = process.argv.slice(2);
const options = { port: undefined, readOnly: false, password: undefined, hosts: [] };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--read-only') options.readOnly = true;
  else if (arg === '--password') options.password = argv[++i];
  else if (arg.startsWith('--password=')) options.password = arg.slice('--password='.length);
  else if (arg === '--host') options.hosts.push(argv[++i]);
  else if (arg.startsWith('--host=')) options.hosts.push(arg.slice('--host='.length));
  else if (arg === '--port') options.port = Number(argv[++i]);
  else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
  else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  else if (arg === 'serve') { /* legacy no-op subcommand */ }
  else positional.push(arg);
}

const PORT_PREFERRED = options.port || (process.env.PORT ? Number(process.env.PORT) : 4321);
const READ_ONLY = options.readOnly;
const PASSWORD = options.password != null ? String(options.password) : (process.env.POCKETSPEC_PASSWORD || null);
// Extra Host header values the user explicitly trusts (custom hostname / reverse proxy).
const EXTRA_HOSTS = new Set(
  [...options.hosts, ...((process.env.POCKETSPEC_HOST || '').split(','))]
    .map((h) => String(h).trim().toLowerCase())
    .filter(Boolean)
);
const command = positional[0];

if (command === 'add') {
  const target = positional[1];
  if (!target) {
    console.error('Usage: pocketspec add <folder> [name]');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`Folder does not exist: ${resolved}`);
    process.exit(1);
  }
  const config = loadConfig();
  if (config.roots.some((r) => r.path === resolved)) {
    console.error(`Folder already registered: ${resolved}`);
    process.exit(1);
  }
  config.roots.push({ name: positional[2] || path.basename(resolved), path: resolved });
  saveConfig(config);
  console.log(`Registered: ${resolved}`);
  process.exit(0);
} else if (command === 'list') {
  for (const [i, root] of loadConfig().roots.entries()) {
    console.log(`${i}  ${root.name}  ${root.path}`);
  }
  process.exit(0);
} else if (command === 'status') {
  // Discover the shared instance. Used by tooling to decide attach-vs-start.
  const inst = readInstance();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(inst || { running: false }));
    process.exit(inst ? 0 : 1);
  }
  if (!inst) {
    console.log('No shared pocketspec instance is running.');
    process.exit(1);
  }
  console.log(`pocketspec shared instance running (pid ${inst.pid})\n`);
  console.log(`  Local:    ${inst.local}`);
  for (const u of inst.network || []) console.log(`  Network:  ${u}   ← open this on your phone`);
  process.exit(0);
} else if (command === 'attach') {
  // Add a folder (or a file's folder) to the shared instance's live roots and
  // print the phone URL. The running daemon picks it up on the next request.
  const target = positional[1];
  if (!target) {
    console.error('Usage: pocketspec attach <folder|file> [name]');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }
  const isFile = fs.statSync(resolved).isFile();
  const rootPath = isFile ? path.dirname(resolved) : resolved;
  const fileRel = isFile ? path.basename(resolved) : null;
  const name = positional[2] || path.basename(rootPath);
  const key = rootKey(rootPath);

  const live = loadLiveRoots();
  if (!live.roots.some((r) => rootKey(r.path) === key)) {
    live.roots.push({ name, path: rootPath });
    saveLiveRoots(live);
  }

  const index = sharedRoots().findIndex((r) => rootKey(r.path) === key);
  const inst = readInstance();
  if (!inst) {
    console.log(`Added "${name}" to the shared roots.`);
    console.log('No shared instance is running yet — start one with:  pocketspec');
    process.exit(0);
  }
  const hash = fileRel ? `#/${index}/${encodeURIComponent(fileRel)}` : `#/${index}`;
  console.log(`Attached "${name}" to the shared instance.\n`);
  for (const u of inst.network || []) console.log(`  Network:  ${u}/${hash}   ← open this on your phone`);
  console.log(`  Local:    ${inst.local}/${hash}`);
  process.exit(0);
} else if (command === 'detach') {
  const target = positional[1];
  if (!target) {
    console.error('Usage: pocketspec detach <folder|file>');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  let rootPath = resolved;
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) rootPath = path.dirname(resolved);
  } catch {}
  const key = rootKey(rootPath);
  const live = loadLiveRoots();
  const before = live.roots.length;
  live.roots = live.roots.filter((r) => rootKey(r.path) !== key);
  saveLiveRoots(live);
  console.log(before === live.roots.length ? `Not attached: ${rootPath}` : `Detached: ${rootPath}`);
  process.exit(0);
}

// Ephemeral roots from folder arguments. If none given, fall back to config.
let RUNTIME_ROOTS = null;
if (positional.length) {
  RUNTIME_ROOTS = [];
  for (const p of positional) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      console.error(`Folder does not exist: ${resolved}`);
      process.exit(1);
    }
    RUNTIME_ROOTS.push({ name: path.basename(resolved), path: resolved });
  }
}

// No folder args → this is the shared daemon (writes instance.json, serves live
// roots, enforced as a singleton). Folder args → a private, independent instance
// that ignores all of that.
const SHARED = RUNTIME_ROOTS === null;

// The shared daemon (no folder args) serves the persisted config roots plus any
// folders attached at runtime, deduped by realpath. Read live per request, so a
// `pocketspec attach` shows up without a restart.
function sharedRoots() {
  const seen = new Set();
  const out = [];
  for (const r of [...loadConfig().roots, ...loadLiveRoots().roots]) {
    const key = rootKey(r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Active roots: ephemeral CLI folders if given (a private instance), else the
// shared config + live roots.
function currentRoots() {
  return RUNTIME_ROOTS || sharedRoots();
}

// ---------- helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(res, data) {
  send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
}

// Anti-DNS-rebinding guard. A malicious website can rebind its DNS to a
// loopback/LAN IP and make same-origin requests to this server; the one thing
// it can't forge is the Host header (the browser sends the name in the URL bar).
// So we only answer requests whose Host is a loopback/LAN/Tailscale address, or
// one the user explicitly trusted via --host / POCKETSPEC_HOST.
function hostAllowed(req) {
  const raw = (req.headers.host || '').trim().toLowerCase();
  if (!raw) return false;
  // Strip the port (handle bare IPv6 like [::1]:4321 too).
  const host = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']'))
    : raw.replace(/:\d+$/, '');
  if (EXTRA_HOSTS.has(host) || EXTRA_HOSTS.has(raw)) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.localhost')) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // Tailscale: CGNAT range 100.64.0.0/10 and MagicDNS names.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.ts.net')) return true;
  return false;
}

// HTTP Basic Auth gate. Returns true when no password is set, or when the
// request carries the right one (constant-time compare). Username is ignored.
function checkAuth(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  const m = /^Basic (.+)$/.exec(header);
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Resolves a relative path inside a registered root, rejecting traversal.
function resolveInRoot(rootIndex, relPath) {
  const root = currentRoots()[rootIndex];
  if (!root) return null;
  const rootReal = fs.realpathSync(root.path);
  const resolved = path.resolve(rootReal, relPath || '.');
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  const real = fs.realpathSync(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  return real;
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function commentsPathFor(absMd) {
  return absMd + '.comments';
}

function loadComments(absMd) {
  const file = commentsPathFor(absMd);
  if (!fs.existsSync(file)) return { comments: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { comments: Array.isArray(data.comments) ? data.comments : [] };
  } catch {
    return { comments: [] };
  }
}

function saveComments(absMd, data) {
  fs.writeFileSync(commentsPathFor(absMd), JSON.stringify(data, null, 2) + '\n');
}

function listDir(absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const stat = fs.statSync(path.join(absDir, entry.name));
      files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    // Defense against DNS rebinding — must run before anything reads the body
    // or touches the filesystem.
    if (!hostAllowed(req)) {
      return send(res, 403, 'forbidden host (DNS rebinding protection); use --host to allow it');
    }

    // Don't let a browser MIME-sniff a doc/asset into executable content.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!checkAuth(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="pocketspec", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('authentication required');
      return;
    }

    if (pathname === '/api/roots') {
      return sendJson(res, currentRoots().map((r, i) => ({ id: i, name: r.name, path: r.path })));
    }

    if (pathname === '/api/meta') {
      return sendJson(res, { readOnly: READ_ONLY });
    }

    if (pathname === '/api/comments' || pathname === '/api/save') {
      const rootIndex = Number(url.searchParams.get('root'));
      const relPath = url.searchParams.get('path') || '';
      if (!Number.isInteger(rootIndex)) return send(res, 400, 'invalid root');
      const abs = resolveInRoot(rootIndex, relPath);
      if (!abs || !abs.toLowerCase().endsWith('.md') || !fs.statSync(abs).isFile()) {
        return send(res, 404, 'document not found');
      }

      if (READ_ONLY && req.method !== 'GET') {
        return send(res, 403, 'read-only mode (--read-only)');
      }

      if (pathname === '/api/save') {
        if (req.method !== 'POST') return send(res, 405, 'use POST');
        const body = JSON.parse(await readBody(req));
        if (typeof body.content !== 'string') return send(res, 400, 'missing content');
        fs.writeFileSync(abs, body.content);
        return sendJson(res, { ok: true });
      }

      if (req.method === 'GET') return sendJson(res, loadComments(abs));
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, 'empty comment');
        const data = loadComments(abs);
        const comment = {
          id: crypto.randomUUID(),
          text,
          anchor: body.anchor && typeof body.anchor === 'object'
            ? { index: Number(body.anchor.index), snippet: String(body.anchor.snippet || '') }
            : null,
          ts: Date.now(),
        };
        data.comments.push(comment);
        saveComments(abs, data);
        return sendJson(res, comment);
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        const data = loadComments(abs);
        const before = data.comments.length;
        data.comments = data.comments.filter((c) => c.id !== id);
        if (data.comments.length === before) return send(res, 404, 'comment not found');
        saveComments(abs, data);
        return sendJson(res, { ok: true });
      }
      return send(res, 405, 'method not supported');
    }

    if (pathname === '/api/list' || pathname === '/api/doc' || pathname === '/api/raw') {
      const rootIndex = Number(url.searchParams.get('root'));
      const relPath = url.searchParams.get('path') || '';
      if (!Number.isInteger(rootIndex)) return send(res, 400, 'invalid root');
      const abs = resolveInRoot(rootIndex, relPath);
      if (!abs) return send(res, 404, 'not found');

      if (pathname === '/api/list') {
        if (!fs.statSync(abs).isDirectory()) return send(res, 400, 'not a folder');
        return sendJson(res, listDir(abs));
      }
      if (pathname === '/api/doc') {
        if (!abs.toLowerCase().endsWith('.md')) return send(res, 400, '.md files only');
        return send(res, 200, fs.readFileSync(abs, 'utf8'), MIME['.md']);
      }
      // /api/raw — images and other assets referenced by docs
      if (!fs.statSync(abs).isFile()) return send(res, 400, 'not a file');
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      return send(res, 200, fs.readFileSync(abs), type);
    }

    // static UI
    const staticPath = pathname === '/' ? '/index.html' : pathname;
    const abs = path.resolve(PUBLIC_DIR, '.' + staticPath);
    if (abs.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      return send(res, 200, fs.readFileSync(abs), type);
    }

    // SPA fallback: any other route renders the app
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), MIME['.html']);
  } catch (err) {
    console.error(err);
    return send(res, 500, 'internal error');
  }
});

function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

// Fires once, when the server actually binds. Reads the real bound port from
// server.address() so a port-fallback retry can't print a stale port.
server.on('listening', () => {
  server.removeAllListeners('error');
  const port = server.address().port;
  const roots = currentRoots();
  console.log(`pocketspec running!${READ_ONLY ? '  (read-only)' : ''}${PASSWORD ? '  (password protected)' : ''}\n`);
  console.log(`  Local:    http://localhost:${port}`);
  for (const addr of lanAddresses()) {
    console.log(`  Network:  http://${addr}:${port}   ← open this on your phone`);
  }
  if (!roots.length) {
    console.log('\nNo folders yet. Attach one: pocketspec attach <folder>  (or register a persistent one: pocketspec add <folder>)');
  } else {
    console.log('\nFolders:');
    for (const root of roots) console.log(`  - ${root.name}: ${root.path}`);
  }
  // Publish the discovery record so other windows attach instead of spawning
  // their own server on a new port.
  if (SHARED) {
    const network = lanAddresses().map((addr) => `http://${addr}:${port}`);
    try {
      writeInstance({ pid: process.pid, port, local: `http://localhost:${port}`, network, startedAt: Date.now() });
    } catch (err) {
      console.error(`(could not write instance file: ${err.message})`);
    }
  }
});

function startListening(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  port ${port} is busy, trying ${port + 1}…`);
      startListening(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0');
}

// When the shared daemon exits, drop the discovery record and clear the live
// roots (they're ephemeral — nothing is left to serve them). Guard on pid so a
// later daemon's file is never clobbered by a stale process.
function cleanupShared() {
  if (!SHARED) return;
  let inst = null;
  try { inst = JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8')); } catch {}
  if (inst && inst.pid === process.pid) {
    try { fs.unlinkSync(INSTANCE_PATH); } catch {}
    try { saveLiveRoots({ roots: [] }); } catch {}
  }
}

if (SHARED) {
  // Singleton: if a live shared instance already exists, point at it and exit
  // rather than spawning a second server on a fallback port.
  const existing = readInstance();
  if (existing) {
    console.log(`A shared pocketspec instance is already running (pid ${existing.pid}).\n`);
    console.log(`  Local:    ${existing.local}`);
    for (const u of existing.network || []) console.log(`  Network:  ${u}   ← open this on your phone`);
    console.log('\nAttach a folder to it:  pocketspec attach <folder>');
    process.exit(0);
  }
  process.on('exit', cleanupShared);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

startListening(PORT_PREFERRED, 10);
