import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hashPassword } from '../worker/password.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: node cli/admin.ts (--local | --remote) [--persist-to PATH] (create | reset-password | promote) USERNAME';

async function readPassword() {
  if (process.stdin.isTTY) throw new Error('Supply the password on stdin through a protected prompt or password manager.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4098) throw new Error('Invalid password input.');
    chunks.push(chunk);
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!password || /[\r\n]/.test(password) || Buffer.byteLength(password) > 4096) throw new Error('Invalid password input.');
  return password;
}

function sqlText(value: string) {
  return "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)";
}

async function run() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { local: { type: 'boolean' }, remote: { type: 'boolean' }, 'persist-to': { type: 'string' } },
  });
  const [command, username] = positionals;
  if (!!values.local === !!values.remote || (values['persist-to'] && !values.local) || positionals.length !== 2 ||
    !['create', 'reset-password', 'promote'].includes(command) || !username.trim() || username.includes('\0')) {
    throw new Error(usage);
  }
  const account = sqlText(username);
  const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  let sql: string;
  if (command === 'promote') {
    sql = `UPDATE admins SET session_version=session_version+(role<>'super_admin'),
      updated_at=CASE WHEN role<>'super_admin' THEN ${timestamp} ELSE updated_at END,
      role='super_admin' WHERE username=${account};`;
  } else {
    const hash = sqlText(await hashPassword(await readPassword()));
    sql = command === 'create'
      ? `INSERT INTO admins(username,password_hash,role) VALUES (${account},${hash},'super_admin');`
      : `UPDATE admins SET password_hash=${hash},session_version=session_version+1,updated_at=${timestamp} WHERE username=${account};`;
  }
  // Make a missing account fail the atomic D1 import as well as the local command.
  sql += "\nSELECT json(CASE changes() WHEN 1 THEN 'true' ELSE 'account missing' END);\n";
  const directory = await mkdtemp(join(tmpdir(), 'joiask-admin-'));
  try {
    const file = join(directory, 'operation.sql');
    await writeFile(file, sql, { mode: 0o600, flag: 'wx' });
    const persistence = values['persist-to'] ? ['--persist-to', resolve(values['persist-to'])] : [];
    const result = spawnSync(process.execPath, [
      join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', values.local ? '--local' : '--remote',
      ...persistence, '--config', join(root, 'wrangler.jsonc'), '--file', file, '--json', '--yes',
    ], { cwd: root, stdio: 'ignore', windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Administrator update failed. Check the configured database, migrations, account name and Cloudflare access.');
    console.log('Administrator account updated.');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
