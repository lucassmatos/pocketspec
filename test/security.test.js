'use strict';

// Zero-dependency security tests for the server. Run: node --test
// Spawns the real server against a temp docs dir and probes it over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 4787;
let child;
let docsDir;

// Minimal HTTP client that lets us forge the Host header.
function req(reqPath, host) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: reqPath, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

async function waitForBoot() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await req('/api/meta', 'localhost');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not boot');
}

before(async () => {
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketspec-test-'));
  fs.writeFileSync(path.join(docsDir, 'a.md'), '# hi\n');
  child = spawn('node', [SERVER, docsDir, '--port', String(PORT), '--host', 'my-box.example'], {
    env: { ...process.env, XDG_CONFIG_HOME: docsDir }, // isolate config writes
    stdio: 'ignore',
  });
  await waitForBoot();
});

after(() => {
  if (child) child.kill();
  if (docsDir) fs.rmSync(docsDir, { recursive: true, force: true });
});

test('allows loopback Host', async () => {
  assert.equal((await req('/api/meta', 'localhost')).status, 200);
  assert.equal((await req('/api/meta', '127.0.0.1:4787')).status, 200);
});

test('allows private LAN Host', async () => {
  assert.equal((await req('/api/meta', '192.168.1.50:4787')).status, 200);
  assert.equal((await req('/api/meta', '10.0.0.5')).status, 200);
  assert.equal((await req('/api/meta', '172.16.4.4')).status, 200);
});

test('allows Tailscale Host', async () => {
  assert.equal((await req('/api/meta', '100.101.102.103:4787')).status, 200);
  assert.equal((await req('/api/meta', 'my-laptop.tail1234.ts.net')).status, 200);
});

test('allows explicitly trusted --host', async () => {
  assert.equal((await req('/api/meta', 'my-box.example')).status, 200);
});

test('rejects rebinding / foreign Host (DNS rebinding)', async () => {
  assert.equal((await req('/api/meta', 'evil.com')).status, 403);
  assert.equal((await req('/api/meta', 'attacker.example:4787')).status, 403);
  // a public IP that is not in any private range
  assert.equal((await req('/api/meta', '8.8.8.8')).status, 403);
  // 172.32 is outside the 172.16/12 private block
  assert.equal((await req('/api/meta', '172.32.0.1')).status, 403);
});

test('sets X-Content-Type-Options: nosniff', async () => {
  const r = await req('/api/meta', 'localhost');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('path traversal still blocked', async () => {
  const r = await req('/api/doc?root=0&path=' + encodeURIComponent('../../../../etc/passwd'), 'localhost');
  assert.equal(r.status, 404);
});
