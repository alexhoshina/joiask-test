import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wranglerBin = join(root, 'node_modules/wrangler/bin/wrangler.js');

test('explicit admin provisioning, recovery and promotion against a fresh local D1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'joiask-operator-test-'));
  const local = ['--local', '--persist-to', directory];
  function run(file, args, input) {
    return spawnSync(process.execPath, [file, ...args], {
      cwd: root, input, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });
  }
  function execute(sql) {
    const result = run(wranglerBin, ['d1', 'execute', 'DB', ...local, '--command', sql, '--json']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout)[0].results;
  }
  const username = "operator's account";
  function operator(command, input, name = username) {
    return run(join(root, 'cli/admin.ts'), [...local, command, name], input);
  }
  try {
    let result = run(wranglerBin, ['d1', 'migrations', 'apply', 'DB', ...local]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(execute('SELECT id FROM admins'), []);
    result = operator('create', 'local-owner-password\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(operator('create', 'different-password\n').status, 1);
    assert.equal(operator('reset-password', 'changed-password\n').status, 0);
    execute("UPDATE admins SET role='admin'");
    assert.equal(operator('promote').status, 0);
    assert.equal(operator('promote').status, 0);
    assert.equal(operator('reset-password', 'unused-password\n', 'absent-admin').status, 1);
    const [account] = execute('SELECT username,role,session_version FROM admins');
    assert.deepEqual(account, { username, role: 'super_admin', session_version: 2 });
    assert.equal(execute('SELECT count(*) AS n FROM emojis')[0].n, 15);
    execute('DELETE FROM emojis');
    assert.equal(run(wranglerBin, ['d1', 'migrations', 'apply', 'DB', ...local]).status, 0);
    assert.equal(execute('SELECT count(*) AS n FROM emojis')[0].n, 0);
    assert.deepEqual(execute('SELECT username FROM admins'), [{ username }]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
