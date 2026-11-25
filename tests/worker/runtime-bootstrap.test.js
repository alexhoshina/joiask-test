import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { hashPassword, verifyPassword } from '../../worker/password.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrations = path.join(root, 'migrations');
const owner = { username: 'runtime-owner', password: 'fixture-runtime-password-0192' };
const secrets = { JOIASK_INITIAL_ADMIN_USERNAME: owner.username, JOIASK_INITIAL_ADMIN_PASSWORD: owner.password };
const bootstrapMigration = '0008_runtime_initial_admin.sql';
let script;

before(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: root,
      contents: "import { identity } from './worker/identity'; import { settings } from './worker/settings'; " +
        "export default {async fetch(req,env){return await identity(req,env) ?? await settings(req,env);}}",
    },
    write: false, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'],
  });
  script = bundle.outputFiles[0].text;
});

async function fixture(t, bindings = secrets) {
  const directory = await mkdtemp(path.join(tmpdir(), 'joiask-runtime-admin-'));
  function options(extra) {
    return convertV4MiniflareOptions({
      modules: true, script, compatibilityDate: '2026-11-24', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'], d1Persist: directory,
      bindings: { SESSION_SECRET: 'fixture-session-key-for-runtime-bootstrap', ...extra },
    });
  }
  const runtime = new Miniflare(options(bindings));
  t.after(async () => {
    try { await runtime.dispose(); }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });
  let db = await runtime.getD1Database('DB');
  const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
  async function runSQL(sql) {
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  }
  async function migrate(names = files) {
    for (const name of names) await runSQL(await readFile(path.join(migrations, name), 'utf8'));
  }
  async function call(url, data, method = data ? 'POST' : 'GET', cookie = '') {
    const res = await runtime.dispatchFetch('https://site.example.test' + url, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: data ? JSON.stringify(data) : undefined,
    });
    const body = await res.json();
    return { body, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0], headers: Object.fromEntries(res.headers) };
  }
  return {
    files, migrate, runSQL, call,
    get db() { return db; },
    login: (account = owner) => call('/api/login', account),
    accounts: async () => (await db.prepare('SELECT * FROM admins ORDER BY id').all()).results,
    async rebind(extra) {
      await runtime.setOptions(options(extra));
      db = await runtime.getD1Database('DB');
    },
  };
}

function assertPrivate(response, credentials = owner) {
  const wire = JSON.stringify(response);
  for (const value of [...Object.keys(secrets), credentials.username, credentials.password]) {
    assert.ok(!wire.includes(value), 'public output contained an initial administrator credential');
  }
}

test('fresh Worker secrets create a real administrator session only on a matching login, including simultaneous requests', async t => {
  const app = await fixture(t);
  await app.migrate();
  const config = await app.call('/api/config');
  assert.equal(config.body.code, 200);
  assertPrivate(config);
  for (const invalid of [{ ...owner, username: 'other-user' }, { ...owner, password: 'wrong-password' }]) {
    const failed = await app.login(invalid);
    assert.equal(failed.body.code, 401);
    assert.equal(failed.cookie, '');
    assertPrivate(failed);
  }
  assert.deepEqual(await app.accounts(), []);
  const logins = await Promise.all(Array.from({ length: 4 }, () => app.login()));
  const accounts = await app.accounts();
  assert.equal(accounts.length, 1);
  const account = accounts[0];
  assert.equal(account.username, owner.username);
  assert.equal(account.role, 'super_admin');
  assert.equal(await verifyPassword(owner.password, account.password_hash), true);
  for (const response of logins) {
    assert.equal(response.body.code, 200);
    assert.match(response.cookie, /^joi_admin=[0-9a-f]{64}$/);
    assertPrivate(response);
    const info = (await app.call('/api/info', undefined, 'GET', response.cookie)).body;
    assert.equal(info.code, 200);
    assert.equal(info.data.username, owner.username);
    assert.equal(info.data.role, 'super_admin');
    assert.ok(!JSON.stringify(info).includes(owner.password));
  }

  const newPassword = 'fixture-changed-password-4351';
  const edit = await app.call('/api/user/' + account.id, { password: newPassword }, 'PUT', logins[0].cookie);
  assert.equal(edit.body.code, 200);
  assert.equal((await app.login()).body.code, 401);
  assert.equal((await app.login({ ...owner, password: newPassword })).body.code, 200);
  await app.db.prepare('DELETE FROM admins').run();
  assert.equal((await app.login()).body.code, 401);
  assert.deepEqual(await app.accounts(), []);
});

test('missing or invalid Worker secrets cannot create an account or consume a fresh site’s one opportunity', async t => {
  const app = await fixture(t, {});
  await app.migrate();
  const missing = await app.login();
  assert.equal(missing.body.code, 401);
  assertPrivate(missing);
  const incomplete = [
    { JOIASK_INITIAL_ADMIN_USERNAME: owner.username },
    { JOIASK_INITIAL_ADMIN_PASSWORD: owner.password },
    { ...secrets, JOIASK_INITIAL_ADMIN_USERNAME: '   ' },
    { ...secrets, JOIASK_INITIAL_ADMIN_PASSWORD: 'invalid\npassword' },
  ];
  for (const binding of incomplete) {
    await app.rebind(binding);
    const failed = await app.login({
      username: binding.JOIASK_INITIAL_ADMIN_USERNAME || owner.username,
      password: binding.JOIASK_INITIAL_ADMIN_PASSWORD || owner.password,
    });
    assert.equal(failed.body.code, 401);
    assertPrivate(failed);
    assert.deepEqual(await app.accounts(), []);
  }
  await app.rebind(secrets);
  assert.equal((await app.login()).body.code, 200);
  assert.equal((await app.accounts()).length, 1);
  await app.rebind({});
  assert.equal((await app.login()).body.code, 200, 'removing the initial bindings must preserve password login');
});

test('an operator-created administrator prevents runtime recovery after deletion without any intervening login', async t => {
  const app = await fixture(t);
  await app.migrate();
  await app.db.prepare("INSERT INTO admins(username,password_hash,role) VALUES(?,?,'super_admin')")
    .bind('manual-owner', await hashPassword('fixture-operator-password')).run();
  await app.db.prepare('DELETE FROM admins').run();
  assert.equal((await app.login()).body.code, 401);
  assert.deepEqual(await app.accounts(), []);
});

test('an account created and deleted before migration 0008 closes a fresh site’s remaining eligibility', async t => {
  const app = await fixture(t);
  await app.migrate(app.files.filter(name => name < bootstrapMigration));
  await app.db.prepare("INSERT INTO admins(username,password_hash,role) VALUES(?,?,'super_admin')")
    .bind('removed-before-upgrade', await hashPassword('fixture-deleted-password')).run();
  await app.db.prepare('DELETE FROM admins').run();
  await app.migrate(app.files.filter(name => name >= bootstrapMigration));
  assert.equal((await app.login()).body.code, 401);
  assert.deepEqual(await app.accounts(), []);
});

test('upgrading an existing site never enables runtime seeding, including sites without remaining administrators', async t => {
  for (const scenario of ['never created', 'deleted', 'retained']) {
    await t.test(scenario, async t => {
      const app = await fixture(t);
      // Reproduce the released site schema through 0007. The original 0001
      // ended immediately after inserting the site’s singleton config row.
      const configSQL = await readFile(path.join(migrations, '0001_config.sql'), 'utf8');
      const end = 'INSERT INTO config (id) VALUES (1);';
      assert.ok(configSQL.includes(end));
      await app.runSQL(configSQL.slice(0, configSQL.indexOf(end) + end.length));
      await app.migrate(app.files.filter(name => name > '0001_config.sql' && name < bootstrapMigration));
      if (scenario !== 'never created') {
        await app.db.prepare("INSERT INTO admins(username,password_hash,role) VALUES(?,?,'admin')")
          .bind(owner.username, await hashPassword('legacy-password')).run();
        if (scenario === 'deleted') await app.db.prepare('DELETE FROM admins').run();
      }
      const original = await app.accounts();
      await app.migrate(app.files.filter(name => name >= bootstrapMigration));
      const failed = await app.login();
      assert.equal(failed.body.code, 401);
      assertPrivate(failed);
      assert.deepEqual(await app.accounts(), original);
      if (scenario === 'retained') assert.equal((await app.login({ ...owner, password: 'legacy-password' })).body.code, 200);
    });
  }
});
