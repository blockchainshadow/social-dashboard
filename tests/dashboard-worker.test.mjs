import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import worker from '../worker/dashboard-worker.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  const prepare = sql => ({
    bind(...args) {
      return {
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return db.prepare(sql).run(...args); },
      };
    },
  });
  return { db, prepare, async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

test('server sessions reject public hash replay, revoke on logout/password change, enforce owner', async t => {
  const auth = database();
  t.after(() => auth.db.close());
  auth.db.exec(await readFile(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const password = 'initial-secret-password';
  const hash = createHash('sha256').update(password).digest('hex');
  for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['admin', 'admin']]) auth.db.prepare('INSERT INTO users(username,role,password_hash) VALUES(?,?,?)').run(name, role, hash);
  auth.db.prepare('UPDATE users SET must_rotate=1 WHERE username=?').run('alice');
  const config = [{ platform: 'youtube', handle: '@alice', owner: 'alice' }, { platform: 'youtube', handle: '@bob', owner: 'bob' }];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ content: Buffer.from(JSON.stringify(config)).toString('base64'), sha: 'current' });
  t.after(() => { globalThis.fetch = previousFetch; });
  const env = { AUTH_DB: auth, GH_TOKEN: 'private-fixture', RUNNER_TOKEN: 'collector-only', DATA: { async get() { return null; }, async put() {} } };
  async function call(path, { method = 'GET', body, token, origin } = {}) {
    const response = await worker.fetch(new Request('https://relay.example' + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, body: await response.json() };
  }
  const replay = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: hash } });
  assert.equal(replay.status, 401);
  const login = await call('/auth/login', { method: 'POST', body: { username: 'alice', password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'member');
  assert.equal(login.body.user.mustChangePassword, true);
  assert.deepEqual(login.body.user.channels, ['youtube:@alice']);
  assert.equal('pass' in login.body.user, false);
  assert.ok(auth.db.prepare('SELECT salt FROM users WHERE username=?').get('alice').salt);
  const token = login.body.token;
  assert.equal((await call('/auth/session', { token })).status, 200);
  const mustRotate = await call('/', { method: 'POST', token, body: { action: 'refresh', handle: '@alice' } });
  assert.equal(mustRotate.status, 403);
  assert.equal(mustRotate.body.passwordChangeRequired, true);
  assert.equal((await call('/', { method: 'POST', token, body: { action: 'update', handle: '@bob', alias: 'takeover' } })).status, 403);
  assert.equal((await call('/', { method: 'POST', token, body: { action: 'members' } })).status, 403);
  assert.equal((await call('/auth/session', { token, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call('/auth/password', { method: 'POST', token, body: { currentPassword: 'wrong', newPassword: 'new-secret-password' } })).status, 403);
  assert.equal((await call('/auth/password', { method: 'POST', token, body: { currentPassword: password, newPassword: 'new-secret-password' } })).status, 200);
  assert.equal((await call('/auth/session', { token })).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: { username: 'alice', password } })).status, 401);
  const relogin = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'new-secret-password' } });
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.mustChangePassword, false);
  assert.equal((await call('/', { method: 'POST', token: relogin.body.token, body: { action: 'update', handle: '@bob', alias: 'takeover' } })).status, 403);
  assert.equal((await call('/auth/logout', { method: 'POST', token: relogin.body.token, body: {} })).status, 200);
  assert.equal((await call('/auth/session', { token: relogin.body.token })).status, 401);
  assert.equal((await call('/', { method: 'POST', body: { username: 'alice', pass: hash, action: 'delete', handle: '@alice' } })).status, 401);
  assert.equal((await call('/internal/requests', { token })).status, 401);
});

test('conflicting config edit re-reads intent instead of losing another channel', async t => {
  const auth = database(); t.after(() => auth.db.close());
  auth.db.exec(await readFile(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  auth.db.prepare('INSERT INTO users(username,role,password_hash,salt) VALUES(?,?,?,?)').run('admin', 'admin', 'unused', 'private');
  const token = 'a'.repeat(64), tokenHash = createHash('sha256').update(token).digest('hex');
  auth.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash, 'admin', 1, Date.now() + 60000);
  let config = [{ handle: '@original', owner: 'admin' }], revision = 1, conflicting = true;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (conflicting) { conflicting = false; config.push({ handle: '@concurrent', owner: 'admin' }); revision++; return new Response('', { status: 409 }); }
      assert.equal(body.sha, String(revision));
      config = JSON.parse(Buffer.from(body.content, 'base64').toString());
      return Response.json({ ok: true });
    }
    return Response.json({ content: Buffer.from(JSON.stringify(config)).toString('base64'), sha: String(revision) });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const env = { AUTH_DB: auth, GH_TOKEN: 'fixture', DATA: { async get() { return null; }, async put() {} } };
  const response = await worker.fetch(new Request('https://relay.example/', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'add', handle: '@新增账号', all: true }) }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(config.map(c => c.handle), ['@original', '@concurrent', '@新增账号']);
  assert.equal(auth.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
});

test('two concurrent password changes acknowledge only the winning password', async t => {
  const auth = database(); t.after(() => auth.db.close());
  auth.db.exec(await readFile(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const oldPassword = 'old-valid-password';
  auth.db.prepare('INSERT INTO users(username,role,password_hash) VALUES(?,?,?)').run('alice', 'member', createHash('sha256').update(oldPassword).digest('hex'));
  const token = 'b'.repeat(64);
  auth.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'alice', 1, Date.now() + 60000);
  const env = { AUTH_DB: auth };
  const passwords = ['new-password-first', 'new-password-second'];
  const responses = await Promise.all(passwords.map(newPassword => worker.fetch(new Request('https://relay.example/auth/password', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token },
    body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
  }), env)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(auth.db.prepare('SELECT version FROM users WHERE username=?').get('alice').version, 2);
  assert.equal(auth.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('collector token cannot publish private credentials or delete unrelated R2 data', async () => {
  const env = { RUNNER_TOKEN: 'collector-fixture' };
  for (const [method, path, body] of [
    ['PUT', '/internal/publication-object?key=users.json', 'not-written'],
    ['POST', '/internal/backup-delete', JSON.stringify({ key: 'data/channels/known.json' })],
    ['PUT', '/internal/backup-object?key=backups/../../users.json', 'not-written'],
  ]) {
    const response = await worker.fetch(new Request('https://relay.example' + path, {
      method, headers: { Authorization: 'Bearer collector-fixture' }, body,
    }), env);
    assert.equal(response.status, 400);
  }
});
