import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { encryptSecret } from '../../worker/common.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('an image submission traverses R2 and the vision queue before it becomes public', { timeout: 35000 }, async t => {
  const { workerOptions } = unstable_getMiniflareWorkerOptions(join(root, 'wrangler.jsonc'));
  const compiled = await build({
    entryPoints: [join(root, 'worker/index.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
    plugins: [{
      name: 'omit-vite-ssr',
      setup(plugin) {
        // Only the frontend SSR entry depends on Vite's virtual modules.
        plugin.onResolve({ filter: /^\.\/ssr$/ }, () => ({ path: 'ssr', namespace: 'test' }));
        plugin.onLoad({ filter: /^ssr$/, namespace: 'test' }, () => ({
          contents: "export default {fetch(){ throw new Error('Unexpected SSR request'); }}",
        }));
      },
    }],
  });
  const settingsKey = 'isolated-settings-key-for-queue-test';
  const content = 'A test submission for the moderation queue';
  const rejected = 'A rejected submission';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yhBkAAAAASUVORK5CYII=', 'base64');
  const model = Promise.withResolvers();
  let modelRequest, socket;
  const { compatibilityDate, compatibilityFlags, d1Databases, r2Buckets, durableObjects, queueProducers, queueConsumers } = workerOptions;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate, compatibilityFlags, d1Databases, r2Buckets, durableObjects, queueProducers, queueConsumers,
    bindings: { SETTINGS_KEY: settingsKey, SESSION_SECRET: 'test-only-session-key-for-queue-dispatch' },
    async outboundService(request) {
      modelRequest = { url: request.url, method: request.method,
        authorization: request.headers.get('Authorization'), body: await request.json() };
      await model.promise;
      const user = modelRequest.body.messages.find(message => message.role === 'user').content;
      const isSpam = typeof user === 'string' && JSON.parse(user).content === rejected;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ is_spam: isSpam }) } }] });
    },
  }));
  try {
    const db = await runtime.getD1Database('DB');
    const migrations = join(root, 'migrations');
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join(migrations, file), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await db.prepare('UPDATE config SET ai_api_key=?, ai_base_url=?, ai_model=?, ai_auto_publish=1, ai_supports_vision=1 WHERE id=1')
      .bind(await encryptSecret('test-api-key', settingsKey), 'https://model.example.test/v1', 'queue-test-model').run();

    const upgrade = await runtime.dispatchFetch('https://ask.example.test/api/ws', { headers: { Upgrade: 'websocket' } });
    assert.equal(upgrade.status, 101);
    socket = upgrade.webSocket;
    const frames = [];
    socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
    socket.accept();
    const form = new FormData();
    form.set('tag_id', '1');
    form.set('content', content);
    form.append('files[]', new Blob([image], { type: 'image/png' }), 'question.png');
    const encoded = new Response(form);
    const response = await runtime.dispatchFetch('https://ask.example.test/api/question', {
      method: 'POST', headers: { 'Content-Type': encoded.headers.get('Content-Type') }, body: await encoded.arrayBuffer(),
    });
    assert.equal(response.status, 200);
    const submission = await response.json();
    assert.equal(submission.code, 200, submission.message);
    const lookup = db.prepare('SELECT q.id,q.is_spam,q.is_publish,o.question_id AS pending FROM questions q ' +
      'LEFT JOIN moderation_outbox o ON o.question_id=q.id WHERE q.content=?');
    const status = lookup.bind(content);
    await t.waitFor(() => assert.ok(modelRequest, 'consumer should call the mock model'), { timeout: 18000 });
    const pending = await status.first();
    assert.equal(pending.is_spam, 0);
    assert.equal(pending.is_publish, 0);
    assert.equal(pending.pending, pending.id);
    assert.equal(modelRequest.url, 'https://model.example.test/v1/chat/completions');
    assert.equal(modelRequest.method, 'POST');
    assert.equal(modelRequest.authorization, 'Bearer test-api-key');
    assert.equal(modelRequest.body.model, 'queue-test-model');
    const parts = modelRequest.body.messages.find(message => message.role === 'user').content;
    assert.deepEqual(JSON.parse(parts.find(part => part.type === 'text').text), { content, images_num: 1 });
    assert.equal(parts.find(part => part.type === 'image_url').image_url.url, 'data:image/png;base64,' + image.toString('base64'));

    model.resolve();
    await t.waitFor(async () => {
      assert.deepEqual(await status.first(), { id: pending.id, is_spam: 0, is_publish: 1, pending: null });
    }, { timeout: 5000 });
    const list = await runtime.dispatchFetch('https://ask.example.test/api/question').then(response => response.json());
    assert.equal(list.data.questions[0].id, pending.id);
    await t.waitFor(() => assert.deepEqual(frames.filter(frame => frame.Type === 2), [{ Type: 2, Data: pending.id }]));

    const spam = await runtime.dispatchFetch('https://ask.example.test/api/question', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tag_id: '1', content: rejected }).toString(),
    }).then(response => response.json());
    assert.equal(spam.code, 200);
    await t.waitFor(async () => {
      const refused = await lookup.bind(rejected).first();
      assert.equal(refused.is_spam, 1);
      assert.equal(refused.is_publish, 0);
      assert.equal(refused.pending, null);
    }, { timeout: 18000 });
    assert.equal(frames.filter(frame => frame.Type === 2).length, 1);
  } finally {
    model.resolve();
    socket?.close(1000, 'test complete');
    await runtime.dispose();
  }
});
