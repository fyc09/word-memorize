import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ensureSchema } from './schema.mjs';
import { createAuth } from './auth.mjs';

test('expired sessions and changed credentials invalidate existing sessions', () => {
  const db = new DatabaseSync(':memory:');
  const env = { WORDMEM_USER: 'tester', WORDMEM_PASS: 'test-password' };
  const auth = createAuth(db, { env });
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const req = { headers: { cookie: `wordmem_session=${token}` } };
  db.prepare('INSERT INTO auth_sessions VALUES (?, ?)').run(tokenHash, Date.now() - 1);
  assert.equal(auth.session(req), null);
  db.prepare('INSERT INTO auth_sessions VALUES (?, ?)').run(tokenHash, Date.now() + 60_000);
  assert.equal(auth.session(req).username, 'tester');
  createAuth(db, { env });
  assert.equal(auth.session(req).username, 'tester');
  createAuth(db, { env: { ...env, WORDMEM_PASS: 'new-password' } });
  assert.equal(auth.session(req), null);
  assert.throws(() => createAuth(db, { env: { WORDMEM_USER: 'tester' } }), /同时设置/);
  db.close();
});

test('HTTP login protects reading and writes, persists across restart, and supports logout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmem-auth-'));
  const dbFile = path.join(dir, 'app.db');
  const fixture = new DatabaseSync(dbFile);
  ensureSchema(fixture);
  fixture.close();
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  let child;
  let output = '';

  async function start() {
    output = '';
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd,
      env: { ...process.env, DB_FILE: dbFile, PORT: String(port), HOST: '127.0.0.1',
        NODE_ENV: 'production', APP_ORIGIN: origin, TRUST_PROXY: '0', COOKIE_SECURE: '1',
        WORDMEM_USER: 'tester', WORDMEM_PASS: 'test-password' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const res = await fetch(`${origin}/health`);
        if (res.ok) return;
      } catch { /* Wait for the listener. */ }
      await delay(50);
    }
    throw new Error(`Server did not start: ${output}`);
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();

  const request = (url, method = 'GET', body, cookie, requestOrigin = origin) => fetch(`${origin}${url}`, {
    method,
    headers: { Origin: requestOrigin, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const url of ['/api/state', '/api/words', '/api/texts', '/api/learn/current', '/api/fetch/status']) {
    assert.equal((await request(url)).status, 401, url);
  }
  assert.equal((await request('/api/settings', 'POST', { level: 6 })).status, 401);
  assert.equal((await request('/api/fetch/start', 'POST', { want: 1 })).status, 401);
  const credentials = { username: 'tester', password: 'test-password' };
  assert.equal((await request('/api/auth/login', 'POST', credentials, null, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);

  const login = await request('/api/auth/login', 'POST', credentials);
  assert.equal(login.status, 200);
  assert.equal((await login.json()).username, 'tester');
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.match(cookieHeader, /Secure/);
  assert.match(cookieHeader, /Max-Age=604800/);
  const cookie = cookieHeader.split(';')[0];
  const state = await (await request('/api/state', 'GET', null, cookie)).json();
  assert.equal(state.level, 3, 'unauthenticated writes must not change settings');
  await t.test('empty article library handles live refill without a missing-function error', async () => {
    // A category with no feeds exercises the refill branch without external network calls.
    const response = await request('/api/learn/next?category=__no_feed__', 'GET', null, cookie);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.payload, null);
    assert.deepEqual(result.fetched, { scanned: 0, ingested: 0, failed: 0 });
    assert.equal(typeof result.reason, 'string');
    const offline = await request('/api/learn/next?live=0', 'GET', null, cookie);
    assert.equal(offline.status, 200);
    assert.equal((await offline.json()).payload, null);
  });
  assert.equal((await request('/api/settings', 'POST', { level: 4 }, cookie, 'https://untrusted.example')).status, 403);
  assert.equal((await request('/api/settings', 'POST', { level: 4 }, cookie)).status, 200);
  assert.equal((await (await request('/api/state', 'GET', null, cookie)).json()).level, 4);

  await stop();
  await start();
  assert.equal((await request('/api/auth/session', 'GET', null, cookie)).status, 200);
  assert.equal((await request('/api/state', 'GET', null, cookie)).status, 200);
  assert.equal((await request('/api/auth/logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await request('/api/state', 'GET', null, cookie)).status, 401);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  }
  assert.equal((await request('/api/auth/login', 'POST', credentials)).status, 429);
});
