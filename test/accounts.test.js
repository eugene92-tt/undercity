'use strict';
/**
 * Facilitator accounts: persistence across deploys, seeding, and the guards
 * that stop an admin locking everyone out of their own platform.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3225;
const BASE = `http://localhost:${PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAgent() {
  let cookie = null;
  return async function call(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${BASE}${url}`, {
      ...options, headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };
}

function boot(dataDir, env = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MODE: 'hosted', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitUp() {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not yet */ }
    await wait(250);
  }
  throw new Error('server never came up');
}

async function stop(server) {
  if (!server) return;
  server.kill();
  await wait(400);
}

test('the master admin is seeded on first boot and survives a redeploy', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-acct-'));
  const env = {
    ADMIN_EMAIL: 'eugene@thrivingtalents.com',
    ADMIN_NAME: 'Eugene Phuah',
    ADMIN_PASSWORD: 'first-password-123',
  };

  let server = boot(dataDir, env);
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  await waitUp();

  await t.test('the account exists after a first boot on an empty disk', async () => {
    assert.match(out, /created master admin eugene@thrivingtalents\.com \(Eugene Phuah\)/);
    const agent = makeAgent();
    const login = await agent('/api/auth/login', {
      method: 'POST', body: { email: 'eugene@thrivingtalents.com', password: 'first-password-123' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.is_admin, true, 'the seeded account is an admin');
  });

  await t.test('a password changed after seeding is NOT reset by a redeploy', async () => {
    // Change it the way a person would, then redeploy with the OLD env value.
    const agent = makeAgent();
    await agent('/api/auth/login', {
      method: 'POST', body: { email: 'eugene@thrivingtalents.com', password: 'first-password-123' },
    });
    const list = await agent('/api/admin/facilitators');
    const meRow = list.json.facilitators.find((f) => f.email === 'eugene@thrivingtalents.com');
    await agent(`/api/admin/facilitators/${meRow.id}/password`, {
      method: 'POST', body: { password: 'changed-by-hand-456' },
    });

    await stop(server);
    server = boot(dataDir, env);     // same ADMIN_PASSWORD as before
    await waitUp();

    const after = makeAgent();
    assert.equal((await after('/api/auth/login', {
      method: 'POST', body: { email: 'eugene@thrivingtalents.com', password: 'changed-by-hand-456' },
    })).status, 200, 'the hand-set password still works');

    assert.equal((await after('/api/auth/login', {
      method: 'POST', body: { email: 'eugene@thrivingtalents.com', password: 'first-password-123' },
    })).status, 401, 'the env password did NOT silently come back');
  });

  await t.test('seeding is idempotent — no duplicate account', async () => {
    const agent = makeAgent();
    await agent('/api/auth/login', {
      method: 'POST', body: { email: 'eugene@thrivingtalents.com', password: 'changed-by-hand-456' },
    });
    const list = await agent('/api/admin/facilitators');
    const matching = list.json.facilitators.filter((f) => f.email === 'eugene@thrivingtalents.com');
    assert.equal(matching.length, 1);
  });

  await stop(server);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('facilitator management is admin-only and cannot lock everyone out', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-acct2-'));
  const server = boot(dataDir, {
    ADMIN_EMAIL: 'boss@test.local', ADMIN_NAME: 'Boss', ADMIN_PASSWORD: 'boss-password-1',
  });
  await waitUp();

  const admin = makeAgent();
  await admin('/api/auth/login', {
    method: 'POST', body: { email: 'boss@test.local', password: 'boss-password-1' },
  });

  let plainId;
  let generated;

  await t.test('an admin can add a facilitator and gets the password once', async () => {
    const res = await admin('/api/admin/facilitators', {
      method: 'POST', body: { email: 'assoc@test.local', name: 'Associate Trainer' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.facilitator.is_admin, false);
    assert.ok(res.json.generated_password, 'a password is generated when none is supplied');
    plainId = res.json.facilitator.id;
    generated = res.json.generated_password;
  });

  await t.test('the new facilitator can sign in with it', async () => {
    const assoc = makeAgent();
    const login = await assoc('/api/auth/login', {
      method: 'POST', body: { email: 'assoc@test.local', password: generated },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.is_admin, false);
  });

  await t.test('a non-admin cannot manage accounts', async () => {
    const assoc = makeAgent();
    await assoc('/api/auth/login', {
      method: 'POST', body: { email: 'assoc@test.local', password: generated },
    });
    assert.equal((await assoc('/api/admin/facilitators')).status, 403);
    assert.equal((await assoc('/api/admin/facilitators', {
      method: 'POST', body: { email: 'x@test.local', name: 'X' },
    })).status, 403);
    assert.equal((await assoc(`/api/admin/facilitators/${plainId}`, { method: 'DELETE' })).status, 403);

    // But an ordinary facilitator can still do their actual job.
    assert.equal((await assoc('/api/admin/sessions')).status, 200);
    assert.equal((await assoc('/api/admin/kit')).status, 200);
  });

  await t.test('duplicate emails are refused', async () => {
    const res = await admin('/api/admin/facilitators', {
      method: 'POST', body: { email: 'assoc@test.local', name: 'Someone Else' },
    });
    assert.equal(res.status, 409);
  });

  await t.test('the last admin cannot demote themselves', async () => {
    const list = await admin('/api/admin/facilitators');
    const boss = list.json.facilitators.find((f) => f.email === 'boss@test.local');
    const res = await admin(`/api/admin/facilitators/${boss.id}/admin`, {
      method: 'POST', body: { is_admin: false },
    });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /last admin/);
  });

  await t.test('an admin cannot remove their own account', async () => {
    const list = await admin('/api/admin/facilitators');
    const boss = list.json.facilitators.find((f) => f.email === 'boss@test.local');
    const res = await admin(`/api/admin/facilitators/${boss.id}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /your own account/i);
  });

  await t.test('removal is refused while they still own sessions', async () => {
    const assoc = makeAgent();
    await assoc('/api/auth/login', {
      method: 'POST', body: { email: 'assoc@test.local', password: generated },
    });
    await assoc('/api/admin/sessions', { method: 'POST', body: { name: 'Their cohort' } });

    const res = await admin(`/api/admin/facilitators/${plainId}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /owns 1 session/,
      'run history must keep its author rather than being orphaned');
  });

  await t.test('promoting a second admin then demoting the first is allowed', async () => {
    await admin(`/api/admin/facilitators/${plainId}/admin`, {
      method: 'POST', body: { is_admin: true },
    });
    const list = await admin('/api/admin/facilitators');
    const boss = list.json.facilitators.find((f) => f.email === 'boss@test.local');
    const res = await admin(`/api/admin/facilitators/${boss.id}/admin`, {
      method: 'POST', body: { is_admin: false },
    });
    assert.equal(res.status, 200, 'with two admins, demoting one is fine');
  });

  await stop(server);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a first boot with no ADMIN_PASSWORD still yields a usable account', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-acct3-'));
  const server = boot(dataDir, { ADMIN_EMAIL: 'solo@test.local', ADMIN_NAME: 'Solo' });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  await waitUp();

  const match = /temporary password: (\S+)/.exec(out);
  assert.ok(match, 'a password is generated and printed so a deploy is never blocked');

  const agent = makeAgent();
  const login = await agent('/api/auth/login', {
    method: 'POST', body: { email: 'solo@test.local', password: match[1] },
  });
  assert.equal(login.status, 200);

  await stop(server);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
