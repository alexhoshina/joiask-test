import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const defaultURL = 'https://api.bilibili.com/x/web-interface/card';
const customURL = 'https://profiles.example.org/Bili/Card?source=site';
const uid = '9007199254740993';
const probe = '/api/settings/bilibili/test';
const requests = [];
const modelRequests = [];
const cookies = {};
let runtime;

// Decode the actual pixels sent to the candidate model; use no Worker challenge internals.
function readBands(dataURL) {
  assert.match(dataURL, /^data:image\/png;base64,/);
  const bytes = Buffer.from(dataURL.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = {};
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 8 + size;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.equal(crc32(bytes.subarray(offset + 4, end)), bytes.readUInt32BE(end));
    chunks[type] = bytes.subarray(offset + 8, end);
    offset = end + 4;
  }
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  assert.equal(chunks.IHDR[9], 3);
  const pixels = inflateSync(chunks.IDAT);
  assert.equal(pixels.length, height * (1 + width));
  const colors = { ff0000: 'red', '00ff00': 'green', '0000ff': 'blue', ffff00: 'yellow',
    '00ffff': 'cyan', ff00ff: 'magenta', '000000': 'black', ffffff: 'white' };
  const row = Math.floor(height / 2) * (width + 1);
  assert.equal(pixels[row], 0);
  return [0, 1, 2, 3].map(i => {
    const index = pixels[row + 1 + Math.floor((i + 0.5) * width / 4)];
    return colors[chunks.PLTE.toString('hex', 3 * index, 3 * index + 3)];
  });
}

async function call(path, role, method = 'GET', body) {
  const headers = new Headers();
  if (role) headers.set('Cookie', cookies[role]);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await runtime.dispatchFetch('https://ask.example.org' + path, {
    headers, method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

before(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: root, contents: "import { settings } from './worker/settings'; export default {fetch: settings};" },
    write: false, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'],
  });
  const secret = 'profile-settings-test-only-session-secret';
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-24',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { SESSION_SECRET: secret, SETTINGS_KEY: 'settings-test-only-encryption-key-value' },
    async outboundService(request) {
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname.endsWith('/chat/completions')) {
        const body = await request.json();
        const [text, image] = body.messages[0].content;
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].content.length, 2);
        assert.equal(text.type, 'text');
        assert.equal(image.type, 'image_url');
        const colors = readBands(image.image_url.url);
        modelRequests.push({ model: body.model, url: url.href, key: request.headers.get('Authorization') });
        if (body.model === 'slow-vision') await delay(1750);
        const reply = body.model === 'text-only' ? ['black', 'black', 'black', 'black'] : colors;
        return Response.json({ choices: [{ message: { content: JSON.stringify({ colors: reply }) } }] });
      }
      if (url.pathname === '/restricted') return Response.json({ code: -412, message: 'upstream details' });
      const card = { mid: url.pathname === '/wrong-uid' ? '1' : uid, name: '资料接口测试', sign: '公开签名', face: 'https://i0.hdslb.com/example.jpg' };
      return Response.json({ code: 0, data: { card } });
    },
  }));
  const db = await runtime.getD1Database('DB');
  const migrate = async name => {
    const sql = await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  };
  await migrate('0001_config.sql');
  await migrate('0002_identity.sql');
  await db.prepare("UPDATE config SET site_name='existing site' WHERE id=1").run();
  await migrate('0005_bilibili_profile_url.sql');
  await migrate('0006_ai_auto_publish.sql');
  await migrate('0007_ai_vision_test_timeout.sql');
  for (const role of ['admin', 'super_admin']) {
    const token = randomBytes(32).toString('hex');
    const digest = createHmac('sha256', secret).update('joi_admin:' + token).digest('hex');
    await db.batch([
      db.prepare("INSERT INTO admins(username,role,password_hash) VALUES(?,?,'unused')").bind(role, role),
      db.prepare('INSERT INTO identity_sessions(digest,admin_id,version,expires_at) SELECT ?,id,0,? FROM admins WHERE role=?')
        .bind(digest, Date.now() + 60000, role),
    ]);
    cookies[role] = 'joi_admin=' + token;
  }
});

after(async () => { if (runtime) await runtime.dispose(); });

test('migration preserves the existing site and exposes the profile URL only in administrator settings', async () => {
  const site = await call('/api/config');
  assert.equal(site.data.site_name, 'existing site');
  assert.equal(Object.hasOwn(site.data, 'bilibili_profile_url'), false);
  assert.equal((await call('/api/settings')).code, 408);
  assert.equal((await call('/api/settings', 'admin')).data.bilibili_profile_url, defaultURL);
});

test('only a super administrator can change the endpoint, while regular settings edits still work', async () => {
  assert.equal((await call('/api/settings', 'admin', 'PUT', { bilibili_profile_url: customURL, ai_model: 'rejected' })).code, 403);
  const saved = await call('/api/settings', 'super_admin', 'PUT', { bilibili_profile_url: customURL });
  assert.equal(saved.code, 200);
  assert.equal(saved.data.bilibili_profile_url, customURL);
  assert.notEqual(saved.data.ai_model, 'rejected');
  const unchanged = await call('/api/settings', 'admin', 'PUT', { bilibili_profile_url: customURL, ai_model: 'new model' });
  assert.equal(unchanged.code, 200);
  assert.equal(unchanged.data.ai_model, 'new model');
  const omitted = await call('/api/settings', 'admin', 'PUT', { spam_prompt: 'new prompt' });
  assert.equal(omitted.code, 200);
  assert.equal(omitted.data.spam_prompt, 'new prompt');
  assert.equal(omitted.data.bilibili_profile_url, customURL);
});

test('administrators can opt into automatic publishing and older settings clients preserve that choice', async () => {
  const path = '/api/settings';
  assert.equal((await call(path, 'admin')).data.ai_auto_publish, false);
  assert.equal((await call(path, null, 'PUT', { ai_auto_publish: true })).code, 408);
  const enabled = await call(path, 'admin', 'PUT', { ai_auto_publish: true });
  assert.equal(enabled.code, 200);
  assert.equal(enabled.data.ai_auto_publish, true);
  assert.equal((await call(path, 'super_admin')).data.ai_auto_publish, true);
  assert.equal(Object.hasOwn((await call('/api/config')).data, 'ai_auto_publish'), false);
  const legacy = await call(path, 'admin', 'PUT', { ai_model: 'updated model' });
  assert.equal(legacy.data.ai_model, 'updated model');
  assert.equal(legacy.data.ai_auto_publish, true);
  for (const value of [null, 'false', 0]) {
    assert.equal((await call(path, 'admin', 'PUT', { ai_auto_publish: value })).code, 400);
  }
  assert.equal((await call(path, 'admin')).data.ai_auto_publish, true);
  const disabled = await call(path, 'super_admin', 'PUT', { ai_auto_publish: false });
  assert.equal(disabled.code, 200);
  assert.equal((await call(path, 'admin')).data.ai_auto_publish, false);
});

test('image transfer is opt-in for the selected model and endpoint', async () => {
  const path = '/api/settings';
  const update = body => call(path, 'admin', 'PUT', body);
  const current = (await call(path, 'admin')).data;
  assert.equal(current.ai_supports_vision, false);
  assert.equal((await call(path, null, 'PUT', { ai_supports_vision: true })).code, 408);
  const noKey = await update({ ai_supports_vision: true });
  assert.equal(noKey.code, 400);
  assert.match(noKey.message, /API Key.*图片审核/);
  assert.equal(modelRequests.length, 0);
  const rejected = await update({ ai_supports_vision: true, ai_model: 'text-only', ai_api_key: 'test-entry' });
  assert.equal(rejected.code, 400);
  assert.match(rejected.message, /测试图/);
  const afterFailure = (await call(path, 'admin')).data;
  assert.equal(afterFailure.ai_supports_vision, false);
  assert.equal(afterFailure.ai_api_key_configured, false);
  assert.equal(afterFailure.ai_model, current.ai_model);
  const enabled = await update({ ai_supports_vision: true, ai_api_key: 'test-entry' });
  assert.equal(enabled.code, 200);
  assert.deepEqual(modelRequests.at(-1), { model: current.ai_model, url: current.ai_base_url + '/chat/completions', key: 'Bearer test-entry' });
  assert.equal((await call(path, 'super_admin')).data.ai_supports_vision, true);
  assert.equal(Object.hasOwn((await call('/api/config')).data, 'ai_supports_vision'), false);

  const unchanged = await update({ ai_base_url: current.ai_base_url + '/', ai_model: current.ai_model, spam_prompt: 'legacy edit' });
  assert.equal(unchanged.data.ai_supports_vision, true);
  assert.equal((await update({ ai_supports_vision: true, spam_prompt: 'another edit' })).code, 200);
  assert.equal(modelRequests.length, 2);
  for (const value of [null, 'false', 1]) {
    assert.equal((await update({ ai_supports_vision: value })).code, 400);
  }
  assert.equal((await call(path, 'admin')).data.ai_supports_vision, true);
  const modelChange = await update({ ai_model: 'second model' });
  assert.equal(modelChange.data.ai_supports_vision, false);
  assert.equal(modelRequests.length, 2);
  const confirmed = await update({ ai_supports_vision: true, ai_model: 'third model' });
  assert.equal(confirmed.data.ai_supports_vision, true);
  assert.equal(modelRequests.length, 3);
  const endpointChange = await update({ ai_base_url: 'https://another-model.example.org/v1', ai_api_key: 'second key' });
  assert.equal(endpointChange.data.ai_supports_vision, false);
  assert.equal(modelRequests.length, 3);
  const explicit = await update({ ai_base_url: current.ai_base_url, ai_supports_vision: true, ai_api_key: 'third key' });
  assert.equal(explicit.data.ai_supports_vision, true);
  assert.equal(modelRequests.length, 4);
  const movedWithVision = await update({ ai_base_url: 'https://another-model.example.org/v1', ai_api_key: 'fourth key', ai_supports_vision: true });
  assert.equal(movedWithVision.data.ai_supports_vision, true);
  assert.deepEqual(modelRequests.at(-1), { url: 'https://another-model.example.org/v1/chat/completions', model: 'third model', key: 'Bearer fourth key' });
  assert.equal(modelRequests.length, 5);
  const cleared = await update({ ai_api_key: null, ai_supports_vision: true });
  assert.equal(cleared.data.ai_supports_vision, false);
  assert.equal(modelRequests.length, 5);
  // An older configuration may have kept the switch on before its first API key was entered.
  const db = await runtime.getD1Database('DB');
  await db.prepare('UPDATE config SET ai_supports_vision=1 WHERE id=1').run();
  assert.equal((await update({ ai_api_key: 'first key' })).data.ai_supports_vision, true);
  assert.equal(modelRequests.length, 6);
  assert.equal((await update({ ai_api_key: 'replacement key' })).data.ai_supports_vision, true);
  assert.equal(modelRequests.at(-1).key, 'Bearer replacement key');
  assert.equal(modelRequests.length, 7);
  assert.equal((await update({ ai_supports_vision: false })).data.ai_supports_vision, false);
  assert.equal(modelRequests.length, 7);
});

test('vision timeout validates seconds, governs the current save and never probes for a timeout-only edit', async () => {
  const path = '/api/settings';
  const update = body => call(path, 'admin', 'PUT', body);
  const initial = (await call(path, 'admin')).data;
  const start = modelRequests.length;
  assert.equal(initial.ai_vision_test_timeout_seconds, 20);
  assert.equal(Object.hasOwn((await call('/api/config')).data, 'ai_vision_test_timeout_seconds'), false);
  assert.equal((await call(path, null, 'PUT', { ai_vision_test_timeout_seconds: 1 })).code, 408);
  for (const invalid of [0, -1, 301, 1.5, '20', null, true]) {
    assert.equal((await update({ ai_vision_test_timeout_seconds: invalid })).code, 400);
  }
  assert.equal(modelRequests.length, start);

  const slow = { ai_model: 'slow-vision', ai_api_key: 'local-test-key', ai_supports_vision: true };
  const timedOut = await update({ ...slow, ai_vision_test_timeout_seconds: 1 });
  assert.equal(timedOut.code, 400);
  assert.equal(timedOut.message, '视觉测试在 1 秒内未完成，请增加测试超时后重试');
  assert.equal(modelRequests.length, start + 1);
  assert.deepEqual((await call(path, 'super_admin')).data, initial);
  const passed = await update({ ...slow, ai_vision_test_timeout_seconds: 10 });
  assert.equal(passed.code, 200);
  assert.equal(passed.data.ai_vision_test_timeout_seconds, 10);
  assert.equal(passed.data.ai_supports_vision, true);
  assert.equal(modelRequests.length, start + 2);

  const minimum = await update({ ai_vision_test_timeout_seconds: 1 });
  assert.equal(minimum.data.ai_vision_test_timeout_seconds, 1);
  const maximum = await call(path, 'super_admin', 'PUT', { ai_vision_test_timeout_seconds: 300 });
  assert.equal(maximum.data.ai_vision_test_timeout_seconds, 300);
  const legacy = await update({ spam_prompt: 'edited without timeout' });
  assert.equal(legacy.data.ai_vision_test_timeout_seconds, 300);
  assert.equal((await call(path, 'admin')).data.ai_vision_test_timeout_seconds, 300);
  assert.equal(modelRequests.length, start + 2);
});

test('the probe reads the candidate without saving it and rejects upstream errors and the wrong identity', async () => {
  const prev = (await call('/api/settings', 'super_admin')).data.bilibili_profile_url;
  const candidate = customURL + '&mid=42&mid=43';
  const start = requests.length;
  const input = { bilibili_uid: uid, bilibili_profile_url: candidate };
  assert.equal((await call(probe, null, 'POST', input)).code, 408);
  assert.equal((await call(probe, 'admin', 'POST', input)).code, 403);
  assert.equal((await call(probe, 'super_admin', 'POST', { ...input, bilibili_uid: 'invalid' })).code, 400);
  assert.equal(requests.length, start);
  const result = await call(probe, 'super_admin', 'POST', input);
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { uid, name: '资料接口测试', signature: '公开签名' });
  assert.equal(requests.length, start + 1);
  assert.equal(requests.at(-1).origin, 'https://profiles.example.org');
  assert.equal(requests.at(-1).pathname, '/Bili/Card');
  assert.equal(requests.at(-1).searchParams.get('source'), 'site');
  assert.deepEqual(requests.at(-1).searchParams.getAll('mid'), [uid]);
  for (const path of ['restricted', 'wrong-uid']) {
    const failed = await call(probe, 'super_admin', 'POST', { ...input, bilibili_profile_url: 'https://profiles.example.org/' + path });
    assert.equal(failed.code, 502);
    assert.equal(failed.data, null);
    assert.doesNotMatch(failed.message, /upstream details/);
  }
  assert.equal((await call('/api/settings', 'super_admin')).data.bilibili_profile_url, prev);
});

test('saving and probing use the same external HTTPS validation', async () => {
  const prev = (await call('/api/settings', 'super_admin')).data.bilibili_profile_url;
  const start = requests.length;
  for (const value of ['', 'http://example.org/card', 'https://user:pass@example.org/card',
    'https://example.org/card#section', 'https://localhost/card', 'https://127.0.0.1/card', 'https://[::1]/card']) {
    const body = { bilibili_profile_url: value };
    assert.equal((await call(probe, 'super_admin', 'POST', { ...body, bilibili_uid: uid })).code, 400, value);
    assert.equal((await call('/api/settings', 'super_admin', 'PUT', body)).code, 400, value);
  }
  assert.equal(requests.length, start);
  assert.equal((await call('/api/settings', 'super_admin')).data.bilibili_profile_url, prev);
});
