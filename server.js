#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// ---------- config (persisted roots, used by the `add`/`list` subcommands) ----------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { roots: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
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
  console.log(`pocketspec — leia seus docs markdown no celular, comente, deixe o agente ler de volta

Uso:
  pocketspec [pasta ...] [--port N] [--read-only]
  pocketspec add <pasta> [nome]    cadastra uma pasta persistente
  pocketspec list                   lista as pastas cadastradas

Sem pasta nos argumentos, usa as pastas salvas via 'add'.
  --port N        porta inicial (padrão 4321; tenta a próxima livre se ocupada)
  --read-only     desliga edição e comentários (só leitura)`);
}

const argv = process.argv.slice(2);
const options = { port: undefined, readOnly: false };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--read-only') options.readOnly = true;
  else if (arg === '--port') options.port = Number(argv[++i]);
  else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
  else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  else if (arg === 'serve') { /* legacy no-op subcommand */ }
  else positional.push(arg);
}

const PORT_PREFERRED = options.port || (process.env.PORT ? Number(process.env.PORT) : 4321);
const READ_ONLY = options.readOnly;
const command = positional[0];

if (command === 'add') {
  const target = positional[1];
  if (!target) {
    console.error('Uso: pocketspec add <pasta> [nome]');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`Pasta não existe: ${resolved}`);
    process.exit(1);
  }
  const config = loadConfig();
  if (config.roots.some((r) => r.path === resolved)) {
    console.error(`Pasta já cadastrada: ${resolved}`);
    process.exit(1);
  }
  config.roots.push({ name: positional[2] || path.basename(resolved), path: resolved });
  saveConfig(config);
  console.log(`Cadastrada: ${resolved}`);
  process.exit(0);
} else if (command === 'list') {
  for (const [i, root] of loadConfig().roots.entries()) {
    console.log(`${i}  ${root.name}  ${root.path}`);
  }
  process.exit(0);
}

// Ephemeral roots from folder arguments. If none given, fall back to config.
let RUNTIME_ROOTS = null;
if (positional.length) {
  RUNTIME_ROOTS = [];
  for (const p of positional) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      console.error(`Pasta não existe: ${resolved}`);
      process.exit(1);
    }
    RUNTIME_ROOTS.push({ name: path.basename(resolved), path: resolved });
  }
}

// Active roots: ephemeral CLI folders if given, else the persisted config.
function currentRoots() {
  return RUNTIME_ROOTS || loadConfig().roots;
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
        reject(new Error('payload muito grande'));
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
    if (pathname === '/api/roots') {
      return sendJson(res, currentRoots().map((r, i) => ({ id: i, name: r.name, path: r.path })));
    }

    if (pathname === '/api/meta') {
      return sendJson(res, { readOnly: READ_ONLY });
    }

    if (pathname === '/api/comments' || pathname === '/api/save') {
      const rootIndex = Number(url.searchParams.get('root'));
      const relPath = url.searchParams.get('path') || '';
      if (!Number.isInteger(rootIndex)) return send(res, 400, 'root inválido');
      const abs = resolveInRoot(rootIndex, relPath);
      if (!abs || !abs.toLowerCase().endsWith('.md') || !fs.statSync(abs).isFile()) {
        return send(res, 404, 'documento não encontrado');
      }

      if (READ_ONLY && req.method !== 'GET') {
        return send(res, 403, 'modo somente leitura (--read-only)');
      }

      if (pathname === '/api/save') {
        if (req.method !== 'POST') return send(res, 405, 'use POST');
        const body = JSON.parse(await readBody(req));
        if (typeof body.content !== 'string') return send(res, 400, 'content ausente');
        fs.writeFileSync(abs, body.content);
        return sendJson(res, { ok: true });
      }

      if (req.method === 'GET') return sendJson(res, loadComments(abs));
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return send(res, 400, 'comentário vazio');
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
        if (data.comments.length === before) return send(res, 404, 'comentário não encontrado');
        saveComments(abs, data);
        return sendJson(res, { ok: true });
      }
      return send(res, 405, 'método não suportado');
    }

    if (pathname === '/api/list' || pathname === '/api/doc' || pathname === '/api/raw') {
      const rootIndex = Number(url.searchParams.get('root'));
      const relPath = url.searchParams.get('path') || '';
      if (!Number.isInteger(rootIndex)) return send(res, 400, 'root inválido');
      const abs = resolveInRoot(rootIndex, relPath);
      if (!abs) return send(res, 404, 'não encontrado');

      if (pathname === '/api/list') {
        if (!fs.statSync(abs).isDirectory()) return send(res, 400, 'não é uma pasta');
        return sendJson(res, listDir(abs));
      }
      if (pathname === '/api/doc') {
        if (!abs.toLowerCase().endsWith('.md')) return send(res, 400, 'só arquivos .md');
        return send(res, 200, fs.readFileSync(abs, 'utf8'), MIME['.md']);
      }
      // /api/raw — images and other assets referenced by docs
      if (!fs.statSync(abs).isFile()) return send(res, 400, 'não é um arquivo');
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
    return send(res, 500, 'erro interno');
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
  console.log(`pocketspec rodando!${READ_ONLY ? '  (somente leitura)' : ''}\n`);
  console.log(`  Local:  http://localhost:${port}`);
  for (const addr of lanAddresses()) {
    console.log(`  Rede:   http://${addr}:${port}   ← use este no celular`);
  }
  if (!roots.length) {
    console.log('\nNenhuma pasta. Passe uma pasta: pocketspec <pasta>  (ou cadastre com: pocketspec add <pasta>)');
  } else {
    console.log('\nPastas:');
    for (const root of roots) console.log(`  - ${root.name}: ${root.path}`);
  }
});

function startListening(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  porta ${port} ocupada, tentando ${port + 1}…`);
      startListening(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0');
}

startListening(PORT_PREFERRED, 10);
