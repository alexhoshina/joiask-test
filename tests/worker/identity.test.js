import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createTLSServer, createSecureContext, TLSSocket } from 'node:tls';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hashPassword } from '../../worker/password.ts';
import { encryptSecret } from '../../worker/common.ts';
import { localCertificates } from './smtp-certificates.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const domain = 'https://ask.example';
const password = 'local-test-credential';
const profileAPI = 'https://api.bilibili.com/x/web-interface/card';
const customProfileAPI = 'https://profiles.example/native/card/?lang=zh&mid=111&mid=222';
const avatarURL = 'https://i0.hdslb.com/test.png';
let runtime, env, certificates, smtp, implicitTLS, startTLS, capturedMail;
let currentSignature = '';
let profileResponse, avatarResponse;
const outboundRequests = [];
const smtpCommands = [];
const encryptedEnvelopes = [];

function mailboxServer(mode, tlsOptions) {
  function serve(socket, greet = true) {
    let input = '', message = '', data = false, authenticated = false;
    if (greet) socket.write('220 local.test ESMTP\r\n');
    socket.on('error', () => {});
    const onData = chunk => {
      input += chunk.toString('utf8');
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (!data) smtpCommands.push(line.split(' ')[0].toUpperCase());
        if (data) {
          if (line !== '.') { message += line + '\r\n'; continue; }
          capturedMail = message; data = false;
        } else if (line.startsWith('EHLO')) {
          const extension = socket.encrypted ? '250-AUTH PLAIN\r\n' : mode === 'starttls' ? '250-STARTTLS\r\n' : '';
          socket.write('250-local.test\r\n' + extension + '250 8BITMIME\r\n');
          continue;
        } else if (line === 'STARTTLS') {
          if (mode !== 'starttls' || socket.encrypted) {
            socket.write('502 TLS unavailable\r\n');
            continue;
          }
          socket.off('data', onData);
          socket.write('220 Ready for TLS\r\n', () => {
            const secured = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(tlsOptions) });
            secured.on('error', () => {});
            secured.once('secure', () => serve(secured, false));
          });
          return;
        } else if (line.startsWith('AUTH PLAIN ')) {
          const credentials = Buffer.from(line.slice(11),'base64').toString('utf8');
          authenticated = socket.encrypted && credentials === '\0fixture\0local-smtp-fixture';
          socket.write(authenticated ? '235 authenticated\r\n' : '535 authentication failed\r\n');
          continue;
        } else if (line.startsWith('MAIL FROM:')) {
          if (!authenticated) {
            socket.write('530 authentication required\r\n');
            continue;
          }
          encryptedEnvelopes.push({mode,protocol:socket.encrypted ? socket.getProtocol() : null});
        }
        else if (line === 'DATA') { data = true; message = ''; socket.write('354 send message\r\n'); continue; }
        else if (line === 'QUIT') { socket.end('221 closing\r\n'); continue; }
        socket.write('250 OK\r\n');
      }
    };
    socket.on('data',onData);
  }
  return mode === 'tls' ? createTLSServer(tlsOptions,serve) : createServer(serve);
}

function userInfoResponse(mid, options) {
  return Response.json({ code: 0, data: { card: { mid, name: '测试用户', face: 'http://i0.hdslb.com/test.png', sign: currentSignature } } }, options);
}

async function upstream(request) {
  const url = new URL(request.url);
  outboundRequests.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), hasBody: request.body !== null });
  const path = url.origin + url.pathname;
  if ((path === profileAPI || path === customProfileAPI.split('?')[0]) && url.searchParams.has('mid')) {
    return (profileResponse ?? userInfoResponse)(url.searchParams.get('mid'));
  }
  if (url.href === avatarURL) {
    if (avatarResponse) await avatarResponse();
    return new Response(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
  }
  return new Response('Unrecognized test upstream', { status: 404 });
}

function assertProfileRequest(request, uid, challenge, endpoint = profileAPI) {
  const expected = new URL(endpoint);
  expected.searchParams.set('mid', uid);
  assert.equal(request.url, expected.href);
  assert.equal(request.method, 'GET');
  assert.equal(request.hasBody, false);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.authorization, undefined);
  if (challenge) {
    assert.ok(!Object.values(request.headers).some(value => value.includes(challenge)), 'challenge must stay local');
  }
}

function setProfileEndpoint(endpoint) {
  return env.DB.prepare('UPDATE config SET bilibili_profile_url=? WHERE id=1').bind(endpoint).run();
}

before(async () => {
  certificates = await localCertificates();
  // Miniflare loads additional verified roots on first import. Limit the CA to
  // this isolated test process and keep the platform hostname/chain checks.
  const previousCA = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = certificates.caFile;
  let Miniflare, convertV4MiniflareOptions;
  try {
    ({ Miniflare, convertV4MiniflareOptions } = await import('miniflare'));
  } finally {
    if (previousCA === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousCA;
  }
  // Inject a D1 transport failure on either side of the account commit. These
  // controls exist only in this disposable test Worker.
  const entry = `
    import { identity } from './worker/identity';
    import { cleanupStaleAvatars } from './worker/avatars';
    import { serveUpload } from './worker/uploads';
    export default { async fetch(req, env) {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/upload-img/')) return serveUpload(req,env);
      if (path === '/test/cleanup') {
        await cleanupStaleAvatars(env);
        return new Response('ok');
      }
      const fault = req.headers.get('X-Test-Avatar-Fault');
      if (path === '/api/member' && req.method === 'POST' && fault) {
        const db = env.DB;
        const broken = { prepare:sql=>db.prepare(sql), batch:async statements=>{
          if (fault === 'after-commit') await db.batch(statements);
          throw new Error('simulated D1 connection loss');
        }};
        try { return await identity(req,{...env, DB:broken}); }
        catch { return Response.json({code:500}); }
      }
      return identity(req,env);
    }}`;
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root },
    write: false, bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], logLevel: 'silent'
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-24', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['FILES'],
    bindings: { SESSION_SECRET: 'a'.repeat(48), SETTINGS_KEY: 'b'.repeat(48) }, outboundService: upstream
  }));
  env = { DB: await runtime.getD1Database('DB'), FILES: await runtime.getR2Bucket('FILES') };
  for (const migration of ['0001_config.sql', '0002_identity.sql', '0004_avatar_uploads.sql', '0005_bilibili_profile_url.sql']) {
    const sql = await readFile(join(root, 'migrations', migration), 'utf8');
    await env.DB.batch(sql.split(';').map(part => part.trim()).filter(Boolean).map(part => env.DB.prepare(part)));
  }
  const serverTLS = {key:certificates.key,cert:certificates.cert,minVersion:'TLSv1.2'};
  smtp = mailboxServer('reject');
  implicitTLS = mailboxServer('tls', serverTLS);
  startTLS = mailboxServer('starttls', serverTLS);
  await Promise.all([smtp, implicitTLS, startTLS].map(async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }));
});

after(async () => {
  if (runtime) await runtime.dispose();
  await Promise.all([smtp, implicitTLS, startTLS].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))));
  if (certificates) await certificates.cleanup();
});

function browser(extraHeaders = {}) {
  const cookies = new Map();
  return async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
    const res = await runtime.dispatchFetch(domain + '/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: [...cookies.values()].join('; '), 'CF-Connecting-IP': '192.0.2.1', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.ok(res);
    for (const header of res.headers.getSetCookie()) {
      const raw = header.split(';')[0], key = raw.split('=')[0];
      if (raw.endsWith('=')) cookies.delete(key); else cookies.set(key, raw);
    }
    return res.json();
  };
}

async function seedMember(uid, username) {
  await env.DB.prepare('INSERT INTO users(bilibili_uid,username,password_hash,bilibili_name,bilibili_avatar,verified_at) VALUES(?,?,?,?,?,?)')
    .bind(uid, username, await hashPassword(password), username, '', new Date().toISOString()).run();
}

test('signature belongs to its browser and UID, expires, and is consumed by exactly one registration', async (t) => {
  t.after(() => { profileResponse = undefined; currentSignature = ''; });
  const call = browser(), stranger = browser(), uid = '9007199254740995';
  const initialRequests = outboundRequests.length;
  const start = await call('account/verification', { bilibili_uid: uid });
  assert.equal(start.code, 200);
  assert.equal((await call('account/verification')).data.challenge_code, start.data.challenge_code);
  assert.equal((await stranger('account/verification/check', {})).code, 404);
  assert.equal(outboundRequests.length, initialRequests);
  assert.equal((await call('account/verification/check', {})).code, 409);
  assert.equal((await call('account/verification/check', {})).code, 429);
  assert.equal(outboundRequests.length, initialRequests + 1);
  assertProfileRequest(outboundRequests.at(-1), uid, start.data.challenge_code);
  await env.DB.prepare('UPDATE signature_challenges SET next_check=0 WHERE bilibili_uid=?').bind(uid).run();
  currentSignature = start.data.challenge_code;
  profileResponse = () => userInfoResponse('123');
  assert.equal((await call('account/verification/check', {})).code, 502);
  assert.equal((await call('account/verification')).data.challenge_code, start.data.challenge_code);
  profileResponse = undefined;
  for (const invalid of ['前缀' + start.data.challenge_code, start.data.challenge_code + ' 后缀', ' ' + start.data.challenge_code]) {
    currentSignature = invalid;
    await env.DB.prepare('UPDATE signature_challenges SET next_check=0 WHERE bilibili_uid=?').bind(uid).run();
    assert.equal((await call('account/verification/check', {})).code, 409);
  }
  currentSignature = start.data.challenge_code;
  // Also accept an exact integer literal even when its UID exceeds Number.MAX_SAFE_INTEGER.
  profileResponse = uid => userInfoResponse(JSON.rawJSON(uid));
  await env.DB.prepare('UPDATE signature_challenges SET next_check=0 WHERE bilibili_uid=?').bind(uid).run();
  assert.equal((await call('account/verification/check', {})).data.status, 'verified');
  const firstDownload = outboundRequests.length;
  const register = () => call('account/register', { username: 'alice', password });
  const results = await Promise.all([register(), register()]);
  assert.equal(results.filter(r => r.code === 200).length, 1);
  const avatarRequests = outboundRequests.slice(firstDownload);
  assert.ok(avatarRequests.length > 0);
  for (const request of avatarRequests) {
    assert.equal(request.url, avatarURL, 'download the HTTP profile avatar only over HTTPS');
    assert.equal(request.headers.cookie, undefined);
  }
  const member = (await call('account/info')).data;
  assert.equal(member.bilibili_uid, uid);
  assert.ok(await env.FILES.get(member.bilibili_avatar.replace('/upload-img/', '')));
  assert.equal((await runtime.dispatchFetch(domain + member.bilibili_avatar)).status, 200);
  assert.equal((await env.FILES.list({ prefix: 'member-avatar-' })).objects.length, 1);
  assert.equal(member.password_hash, undefined);
  const other = await stranger('account/verification', { bilibili_uid: '234' });
  assert.equal(other.code, 200);
  await env.DB.prepare('UPDATE signature_challenges SET expires_at=0 WHERE bilibili_uid=?').bind('234').run();
  assert.equal((await stranger('account/verification/check', {})).code, 410);
});

test('the configured native card endpoint preserves a challenge on blocked, invalid or stale responses', async (t) => {
  t.after(() => { profileResponse = undefined; currentSignature = ''; });
  const call = browser();
  const uid = '9007199254740993';
  const start = await call('account/verification', { bilibili_uid: uid });
  assert.equal(start.code, 200);
  await setProfileEndpoint(customProfileAPI);
  t.after(() => setProfileEndpoint(profileAPI));
  currentSignature = start.data.challenge_code;
  for (const [label, response] of [
    ['HTTP 412', () => new Response('blocked', { status: 412 })],
    ['HTTP 429', () => Response.json({ message: 'rate limited' }, { status: 429 })],
    ['HTTP 503', () => new Response('service unavailable', { status: 503 })],
    ['redirect', () => new Response(null, { status: 302, headers: { Location: profileAPI } })],
    ['blocked code -412', () => Response.json({ code: -412, message: 'rejected' })],
    ['blocked code -352', () => Response.json({ code: -352, message: 'rejected' })],
    ['unexpected business code', () => Response.json({ code: -404 })],
    ['invalid business code', () => Response.json({ code: '0' })],
    ['flat profile', () => Response.json({ mid: uid, name: '测试用户', face: avatarURL, sign: currentSignature })],
    ['malformed JSON', () => new Response('<html>unexpected response</html>')],
    ['malformed UID', () => userInfoResponse('invalid')],
    ['different UID', () => userInfoResponse(JSON.rawJSON('9007199254740992'))],
    ['missing signature', () => Response.json({ code: 0, data: { card: { mid: uid, name: '测试用户', face: avatarURL } } })],
    ['response predates the challenge', () => userInfoResponse(uid, { headers: { Age: '86400' } })],
  ]) {
    profileResponse = response;
    await env.DB.prepare('UPDATE signature_challenges SET next_check=0 WHERE bilibili_uid=?').bind(uid).run();
    const firstRequest = outboundRequests.length;
    const result = await call('account/verification/check', {});
    assert.equal(result.code, 502, label);
    if (/412|429|blocked/.test(label)) assert.match(result.message, /限制/, label);
    const recovered = await call('account/verification');
    assert.equal(recovered.data.status, 'pending', label);
    assert.equal(recovered.data.challenge_code, start.data.challenge_code, label);
    assert.equal(outboundRequests.length, firstRequest + 1, label);
    assertProfileRequest(outboundRequests[firstRequest], uid, start.data.challenge_code, customProfileAPI);
  }
  profileResponse = uid => userInfoResponse(uid, { headers: { Age: '0' } });
  await env.DB.prepare('UPDATE signature_challenges SET next_check=0 WHERE bilibili_uid=?').bind(uid).run();
  const verified = await call('account/verification/check', {});
  assert.equal(verified.data.status, 'verified');
  assert.equal(verified.data.bilibili_uid, uid);
});

test('only the owning browser can cancel and failed UID changes preserve its previous challenge', async () => {
  const owner = browser({ 'CF-Connecting-IP': '192.0.2.61' });
  const stranger = browser({ 'CF-Connecting-IP': '192.0.2.62' });
  const start = (call, uid) => call('account/verification', { bilibili_uid: uid });
  const cancel = call => call('account/verification', undefined, 'DELETE');
  const original = await start(owner, '610');
  assert.equal(original.code, 200);
  const outsider = await start(stranger, '611');
  assert.equal(outsider.code, 200);

  const forged = browser({ Cookie: 'joi_challenge=' + original.data.challenge_code });
  assert.equal((await forged('account/verification?uid=610', original.data, 'DELETE')).code, 200);
  const occupied = await start(owner, '611');
  assert.equal(occupied.code, 409);
  assert.match(occupied.message, /正在验证/);
  assert.equal((await start(owner, 'invalid')).code, 400);
  assert.deepEqual((await owner('account/verification')).data, original.data);
  assert.deepEqual((await stranger('account/verification')).data, outsider.data);

  const replacement = await start(owner, '612');
  assert.equal(replacement.data.bilibili_uid, '612');
  assert.notEqual(replacement.data.challenge_code, original.data.challenge_code);
  assert.equal((await owner('account/verification?bilibili_uid=610', undefined, 'DELETE')).code, 409);
  assert.equal((await start(stranger, '610')).code, 200);
  assert.equal((await owner('account/verification?bilibili_uid=612', undefined, 'DELETE')).code, 200);
  assert.equal((await cancel(owner)).code, 200);
  assert.equal((await owner('account/verification')).code, 404);
  assert.equal((await stranger('account/verification')).data.bilibili_uid, '610');

  const changes = await Promise.all([start(owner, '613'), start(owner, '614')]);
  assert.ok(changes.some(change => change.code === 200));
  const active = await owner('account/verification');
  assert.ok(['613', '614'].includes(active.data.bilibili_uid));
  const rows = await env.DB.prepare("SELECT bilibili_uid FROM signature_challenges WHERE bilibili_uid IN ('613','614')").all();
  assert.deepEqual(rows.results, [{ bilibili_uid: active.data.bilibili_uid }]);
});

test('a stale registration form cannot create the newly verified UID from another tab', async (t) => {
  const owner = browser({ 'CF-Connecting-IP': '192.0.2.65' });
  t.after(() => { currentSignature = ''; });
  for (const uid of ['650', '651']) {
    const start = await owner('account/verification', { bilibili_uid: uid });
    currentSignature = start.data.challenge_code;
    assert.equal((await owner('account/verification/check', {})).data.status, 'verified');
  }
  const account = { username: 'current-tab', password };
  const stale = await owner('account/register', { ...account, bilibili_uid: '650' });
  assert.equal(stale.code, 409);
  assert.match(stale.message, /验证已变更/);
  assert.equal((await owner('account/verification')).data.bilibili_uid, '651');
  const created = await owner('account/register', { ...account, bilibili_uid: '651' });
  assert.equal(created.data.bilibili_uid, '651');
});

test('a slow signature check cannot verify a replacement challenge', async (t) => {
  const owner = browser({ 'CF-Connecting-IP': '192.0.2.63' });
  const original = await owner('account/verification', { bilibili_uid: '630' });
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  profileResponse = async uid => {
    waiting.resolve();
    await release.promise;
    return Response.json({ code: 0, data: { card: { mid: uid, name: '测试用户', face: avatarURL, sign: original.data.challenge_code } } });
  };
  t.after(() => { release.resolve(); profileResponse = undefined; });
  const checking = owner('account/verification/check', {});
  await waiting.promise;
  const replacement = await owner('account/verification', { bilibili_uid: '631' });
  assert.equal(replacement.code, 200);
  release.resolve();
  assert.equal((await checking).code, 410);
  assert.deepEqual((await owner('account/verification')).data, replacement.data);
});

test('canceling a verified generation invalidates its in-flight registration even after the same UID re-verifies', async (t) => {
  const owner = browser({ 'CF-Connecting-IP': '192.0.2.64' });
  const uid = '640';
  const verify = async () => {
    const started = await owner('account/verification', { bilibili_uid: uid });
    currentSignature = started.data.challenge_code;
    assert.equal((await owner('account/verification/check', {})).data.status, 'verified');
    return started.data.challenge_code;
  };
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => { release.resolve(); avatarResponse = undefined; currentSignature = ''; });
  const firstCode = await verify();
  avatarResponse = async () => { waiting.resolve(); await release.promise; };
  const registering = owner('account/register', { username: 'discarded-registration', password });
  await waiting.promise;
  assert.equal((await owner('account/verification', undefined, 'DELETE')).code, 200);
  assert.equal((await owner('account/verification')).code, 404);
  assert.notEqual(await verify(), firstCode);
  release.resolve();
  assert.equal((await registering).code, 410);
  assert.equal((await owner('account/verification')).data.status, 'verified');
  assert.equal(await env.DB.prepare('SELECT 1 FROM users WHERE bilibili_uid=?').bind(uid).first(), null);
});

test('administrator authorization checks roles and revokes obsolete sessions independently of member login', async () => {
  await seedMember('444', 'dual-login');
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO admins(username,password_hash,role) VALUES ('root',?,'super_admin')").bind(hash).run();
  const root = browser(), second = browser(), regular = browser();
  assert.equal((await root('login', { username: 'root', password })).code, 200);
  const rootID = (await root('info')).data.id;
  assert.equal((await root('user/' + rootID, { role: 'admin' }, 'PUT')).code, 403);
  assert.equal((await root('user/' + rootID, undefined, 'DELETE')).code, 403);
  const add = await root('user', { username: 'second', password, role: 'super_admin' });
  assert.equal(add.code, 200);
  assert.equal((await second('login', { username: 'second', password })).code, 200);
  await root('user', { username: 'regular', password, role: 'admin' });
  await regular('login', { username: 'regular', password });
  assert.equal((await regular('user')).code, 403);
  const demotions = await Promise.all([root('user/' + rootID, { role: 'admin' }, 'PUT'), second('user/' + add.data.id, { role: 'admin' }, 'PUT')]);
  assert.deepEqual(demotions.map(r => r.code).sort(), [200, 403]);
  const demoted = demotions[0].code === 200 ? root : second;
  assert.equal((await demoted('info')).code, 408);
  assert.equal((await regular('account/login', { username: 'dual-login', password })).code, 200);
  assert.equal((await regular('logout')).code, 200);
  assert.equal((await regular('account/info')).code, 200);
});

test('administrator creates a member from the configured native card endpoint', async (t) => {
  await setProfileEndpoint(customProfileAPI);
  t.after(() => setProfileEndpoint(profileAPI));
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO admins(username,password_hash,role) VALUES ('profile-admin',?,'admin')").bind(hash).run();
  const call = browser();
  assert.equal((await call('login', { username: 'profile-admin', password })).code, 200);
  const firstRequest = outboundRequests.length;
  const result = await call('member', { bilibili_uid: '783', username: 'manual-member', password });
  assert.equal(result.code, 200);
  const requests = outboundRequests.slice(firstRequest);
  assert.equal(requests.length, 2);
  assertProfileRequest(requests[0], '783', undefined, customProfileAPI);
  assert.equal(requests[1].url, avatarURL);
});

function tokenFromMail() {
  const [headers, ...parts] = capturedMail.split('\r\n\r\n');
  const text = parts.join('\r\n\r\n');
  const content = /content-transfer-encoding: base64/i.test(headers) ? Buffer.from(text, 'base64').toString('utf8') :
    text.replace(/=\r\n/g, '').replace(/=([a-f0-9]{2})/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));
  const match = content.match(/token=([0-9a-f]{64})/);
  assert.ok(match, 'SMTP message should contain a fragment credential'); return match[1];
}

test('SMTP delivery, same-account binding, normalized email login and one-time reset', async () => {
  await seedMember('555', 'mail-user');
  const call = browser(), stranger = browser(), recipient = 'alice@example.test';
  const smtpPassword = await encryptSecret('local-smtp-fixture','b'.repeat(48));
  await env.DB.prepare(`UPDATE config SET email_enabled=1,smtp_host='127.0.0.1',smtp_port=?,
    smtp_security='tls',smtp_username='fixture',smtp_password=?,smtp_from_email='sender@example.test',email_site_url=?`)
    .bind(implicitTLS.address().port, smtpPassword, domain).run();
  await call('account/login', { username: 'mail-user', password });
  assert.equal((await call('account/email', { email: recipient, password })).code, 200);
  assert.equal(encryptedEnvelopes.at(-1).mode,'tls');
  assert.match(encryptedEnvelopes.at(-1).protocol,/^TLSv1\.[23]$/);
  const binding = tokenFromMail();
  assert.equal((await stranger('account/email/confirm', { token: binding })).code, 408);
  assert.equal((await call('account/email/confirm', { token: binding })).data.email, recipient);
  assert.equal((await call('account/email/confirm', { token: binding })).code, 400);
  assert.equal((await stranger('account/login', { username: 'ALICE@EXAMPLE.TEST', password })).code, 200);
  assert.equal((await stranger('account/password-reset', { email: recipient })).code, 429);
  await env.DB.prepare('DELETE FROM identity_rate_limits').run();
  await env.DB.prepare("UPDATE config SET smtp_port=?,smtp_security='starttls'").bind(startTLS.address().port).run();
  assert.equal((await stranger('account/password-reset', { email: recipient })).code, 200);
  const reset = tokenFromMail();
  assert.equal(encryptedEnvelopes.at(-1).mode,'starttls');
  assert.match(encryptedEnvelopes.at(-1).protocol,/^TLSv1\.[23]$/);
  assert.notEqual(reset, binding);
  const change = () => stranger('account/password-reset/confirm', { token: reset, password: 'new-local-test-password' });
  assert.deepEqual((await Promise.all([change(), change()])).map(v => v.code).sort(), [200, 400]);
  assert.equal((await call('account/info')).code, 408);
  assert.equal((await stranger('account/login', { username: recipient, password: 'new-local-test-password' })).code, 200);
});

test('interrupted avatar writes are swept and a lost D1 acknowledgement preserves the committed object', async () => {
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO admins(username,password_hash,role) VALUES ('avatar-admin',?,'admin')").bind(hash).run();
  const user = { bilibili_uid: '781', username: 'avatar-member', password };
  const beforeCommit = browser({ 'X-Test-Avatar-Fault': 'before-commit' });
  const afterCommit = browser({ 'X-Test-Avatar-Fault': 'after-commit' });
  const count = async () => (await env.FILES.list({ prefix: 'member-avatar-' })).objects.length;
  const initialCount = await count();

  for (const call of [beforeCommit, afterCommit]) {
    assert.equal((await call('login', { username: 'avatar-admin', password })).code, 200);
    assert.equal((await call('member', user)).code, 500);
    if (call === beforeCommit) {
      assert.equal(await count(), initialCount);
      assert.equal(await env.DB.prepare('SELECT 1 FROM users WHERE bilibili_uid=?').bind(user.bilibili_uid).first(), null);
    }
  }
  const member = await env.DB.prepare('SELECT bilibili_avatar FROM users WHERE bilibili_uid=?').bind(user.bilibili_uid).first();
  assert.equal((await runtime.dispatchFetch(domain + member.bilibili_avatar)).status, 200);
  assert.equal(await count(), initialCount + 1);

  // Simulate abrupt termination after the R2 write and before the D1 commit.
  const abandonedKey = 'member-avatar-abandoned.png';
  await env.DB.prepare('INSERT INTO avatar_uploads(object_key,created_at) VALUES (?,0)').bind(abandonedKey).run();
  await env.FILES.put(abandonedKey, 'unused fixture');
  assert.equal((await runtime.dispatchFetch(domain + '/upload-img/' + abandonedKey)).status, 404);
  assert.equal((await afterCommit('member/' + user.bilibili_uid, undefined, 'DELETE')).code, 200);
  assert.equal((await runtime.dispatchFetch(domain + '/test/cleanup')).status, 200);
  assert.equal(await env.FILES.get(abandonedKey), null);
  // Historical posts retain their original avatar URL when a member is deleted.
  assert.equal((await runtime.dispatchFetch(domain + member.bilibili_avatar)).status, 200);
});

test('administrator throttling includes the HTTP retry interval', async () => {
  await env.DB.prepare('DELETE FROM identity_rate_limits').run();
  const login = () => runtime.dispatchFetch(domain + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.83' },
    body: JSON.stringify({ username: 'absent', password }),
  });
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await login()).status, 200);
  const denied = await login();
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal((await denied.json()).code, 429);
});

test('mandatory STARTTLS failure issues no live link and never transmits SMTP credentials or a message', async () => {
  await seedMember('888', 'tls-test');
  const smtpPassword = await encryptSecret('local-smtp-fixture', 'b'.repeat(48));
  await env.DB.prepare(`UPDATE config SET email_enabled=1,smtp_host='127.0.0.1',smtp_port=?,
    smtp_security='starttls',smtp_username='fixture',smtp_password=?,smtp_from_email='sender@example.test',
    email_site_url=?`).bind(smtp.address().port, smtpPassword, domain).run();
  const call = browser();
  assert.equal((await call('account/login', { username: 'tls-test', password })).code, 200);
  const firstCommand = smtpCommands.length;
  const response = await call('account/email', { email: 'tls@example.test', password });
  assert.equal(response.code, 502);
  assert.equal(await env.DB.prepare('SELECT 1 FROM email_tokens WHERE bilibili_uid=?').bind('888').first(), null);
  const dialogue = smtpCommands.slice(firstCommand);
  assert.ok(dialogue.includes('STARTTLS'));
  assert.ok(!dialogue.some(command => ['AUTH', 'MAIL', 'RCPT', 'DATA'].includes(command)));
});

test('an untrusted SMTP certificate fails before authentication or delivery', async () => {
  const other = await localCertificates();
  const server = mailboxServer('tls', {key:other.key,cert:other.cert,minVersion:'TLSv1.2'});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    await seedMember('889','untrusted-mail');
    const smtpPassword = await encryptSecret('local-smtp-fixture','b'.repeat(48));
    await env.DB.prepare(`UPDATE config SET email_enabled=1,smtp_host='127.0.0.1',smtp_port=?,
      smtp_security='tls',smtp_username='fixture',smtp_password=?,smtp_from_email='sender@example.test',
      email_site_url=?`).bind(server.address().port,smtpPassword,domain).run();
    const call = browser();
    await call('account/login',{username:'untrusted-mail',password});
    const firstCommand = smtpCommands.length;
    assert.equal((await call('account/email',{email:'untrusted@example.test',password})).code,502);
    assert.equal(await env.DB.prepare('SELECT 1 FROM email_tokens WHERE bilibili_uid=?').bind('889').first(),null);
    assert.deepEqual(smtpCommands.slice(firstCommand),[]);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await other.cleanup();
  }
});
