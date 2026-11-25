import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { classify, moderate, recoverModeration } from '../../worker/moderation.ts';
import { encryptSecret, decryptSecret } from '../../worker/common.ts';

test('settings secrets are randomized, authenticated and require the deployment key', async () => {
  const key = 'a'.repeat(32);
  const first = await encryptSecret('secret', key);
  assert.notEqual(first, await encryptSecret('secret', key));
  assert.equal(await decryptSecret(first, key), 'secret');
  await assert.rejects(decryptSecret(first, 'b'.repeat(32)));
});

test('chat completions accepts only a boolean decision and posts minimal input', async () => {
  const config = { ai_base_url: 'https://model.example/v1', ai_model: 'model', spam_prompt: 'spam', ai_supports_vision: 0 };
  const question = { content: 'hello', images_num: 2 };
  const response = (content: string) => Response.json({ choices: [{ message: { content } }] });
  assert.equal(await classify(config, 'key', question, async (url, init) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'model');
    assert.deepEqual(JSON.parse(payload.messages[1].content), question);
    return response('{"is_spam":false}');
  }), false);
  await assert.rejects(classify(config, 'key', question, async () => response('{"is_spam":"false"}')));
  await assert.rejects(classify(config, 'key', question, async () => new Response(null, { status: 429 })));
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  function prepare(sql: string, params: (string | number)[] = []) {
    const st = sqlite.prepare(sql);
    return {
      bind: (...values: (string | number)[]) => prepare(sql, values),
      first: () => st.get(...params),
      run: () => ({ meta: st.run(...params) }),
      all: () => ({ results: st.all(...params) }),
    };
  }
  const DB = { prepare, batch: (items: {run(): unknown}[]) => {
    sqlite.exec('BEGIN');
    try { const values = items.map(s => s.run()); sqlite.exec('COMMIT'); return values; }
    catch (err) { sqlite.exec('ROLLBACK'); throw err; }
  }};
  return { DB, sqlite };
}

test('transient retry, crash recovery, manual review during model call, and duplicate delivery', async () => {
  const { DB, sqlite } = database();
  const modelKey = 'k'.repeat(32);
  const key = await encryptSecret('fixture-api', modelKey);
  DB.prepare('UPDATE config SET ai_api_key=?').bind(key).run();
  DB.prepare("INSERT INTO questions(id,tag_id,content) VALUES(101,1,'fixture')").run();
  DB.prepare('INSERT OR IGNORE INTO moderation_outbox(question_id) VALUES(101)').run();
  const sent: unknown[] = [];
  const env = { DB, SETTINGS_KEY: modelKey, MODERATION: { sendBatch: (messages: unknown[]) => sent.push(...messages) } } as unknown as Env;
  const original = globalThis.fetch;
  let ack = 0, retry = 0, requests = 0;
  const batch = { messages: [{ body: { questionId: 101 }, ack: () => ack++, retry: () => retry++, attempts: 1 }] } as unknown as MessageBatch<{questionId:number}>;
  try {
    await recoverModeration(env);
    assert.deepEqual(sent, [{ body: { questionId: 101 } }]);
    await recoverModeration(env);
    assert.equal(sent.length, 1);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await moderate(batch, env);
    assert.equal(retry, 1);
    assert.equal(ack, 0);
    globalThis.fetch = async () => {
      requests++;
      DB.prepare('UPDATE questions SET moderation_version=1,is_spam=0 WHERE id=101').run();
      return Response.json({ choices: [{ message: { content: '{"is_spam":true}' } }] });
    };
    await moderate(batch, env);
    await moderate(batch, env);
    assert.equal(requests, 1);
    assert.equal(ack, 2);
    assert.equal(DB.prepare('SELECT is_spam FROM questions WHERE id=101').first()?.is_spam, 0);
    assert.equal(DB.prepare('SELECT count(*) AS n FROM moderation_outbox').first()?.n, 0);
  } finally { globalThis.fetch = original; sqlite.close(); }
});

test('only a clean pending submission with auto-publication enabled at commit is published', async t => {
  const { DB, sqlite } = database();
  const modelKey = 'k'.repeat(32);
  const encrypted = await encryptSecret('fixture-api', modelKey);
  const frames: { Type: number; Data: number }[] = [];
  const realtime = { idFromName: (name: string) => name, get: () => ({
    async fetch(_url: string, init: RequestInit) {
      frames.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    },
  }) };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sqlite.close(); });
  const image = new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], { type: 'image/png' });
  const files = { get: async () => ({ size: image.size, body: image.stream(), arrayBuffer: () => image.arrayBuffer() }) };
  const env = { DB, SETTINGS_KEY: modelKey, REALTIME: realtime, FILES: files } as unknown as Env;
  const enabled = (value: number) => DB.prepare('UPDATE config SET ai_auto_publish=? WHERE id=1').bind(value).run();
  const vision = (value: number) => DB.prepare('UPDATE config SET ai_supports_vision=? WHERE id=1').bind(value).run();
  const insert = DB.prepare("INSERT INTO questions(tag_id,id,images_num,updated_at) VALUES (1,?,?,'original')");
  const enqueue = DB.prepare('INSERT INTO moderation_outbox(question_id) VALUES(?)');
  const row = DB.prepare('SELECT is_spam,is_publish,updated_at,moderation_version FROM questions WHERE id=?');
  DB.prepare('UPDATE config SET ai_api_key=?').bind(encrypted).run();
  assert.equal(DB.prepare('SELECT ai_auto_publish FROM config').first()?.ai_auto_publish, 0);
  const cases = [
    { id: 1, on: 0, result: '{"is_spam":false}', spam: 0, published: 0 },
    { id: 2, on: 1, result: '{"is_spam":false}', spam: 0, published: 1 },
    { id: 3, on: 1, result: '{"is_spam":true}', spam: 1, published: 0 },
    { id: 4, on: 1, result: '{"is_spam":"false"}', spam: 0, published: 0 },
    { id: 5, on: 1, result: '{"is_spam":false}', during: () => enabled(0), spam: 0, published: 0 },
    { id: 6, on: 0, result: '{"is_spam":false}', during: () => enabled(1), spam: 0, published: 1 },
    { id: 7, on: 1, result: '{"is_spam":false}', during: () =>
      DB.prepare('UPDATE questions SET is_spam=1, moderation_version=1 WHERE id=7').run(), spam: 1, published: 0 },
    { id: 8, on: 1, images: 1, result: '{"is_spam":false}', during: () => vision(1), spam: 0, published: 0 },
    { id: 9, on: 1, images: 1, vision: 1, result: '{"is_spam":false}', during: () => vision(0), spam: 0, published: 0 },
    { id: 10, on: 1, result: '{"is_spam":false}', during: () =>
      DB.prepare("UPDATE config SET ai_api_key=''").run(), spam: 0, published: 0 },
  ];
  for (const item of cases) {
    enabled(item.on);
    vision(item.vision ?? 0);
    insert.bind(item.id, item.images ?? 0).run();
    if (item.images) {
      const submission = crypto.randomUUID();
      DB.prepare('INSERT INTO question_images(object_key,submission_id,question_id) VALUES (?,?,?)')
        .bind('question-' + submission + '-0.png', submission, item.id).run();
    }
    enqueue.bind(item.id).run();
    let requests = 0, acknowledgements = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const payload = await new Response(init?.body).json();
      assert.equal(Array.isArray(payload.messages[1].content), Boolean(item.vision && item.images));
      item.during?.();
      return Response.json({ choices: [{ message: { content: item.result } }] });
    };
    const message = { body: { questionId: item.id }, attempts: 1,
      ack: () => acknowledgements++, retry: () => assert.fail('Unexpected retry') };
    const batch = { messages: [message] } as unknown as MessageBatch<{questionId:number}>;
    await moderate(batch, env);
    await moderate(batch, env);
    const question = row.bind(item.id).first()!;
    assert.equal(question.is_spam, item.spam);
    assert.equal(question.is_publish, item.published);
    assert.equal(question.updated_at !== 'original', item.published === 1);
    if (item.published) assert.equal(question.moderation_version, 1);
    assert.equal(requests, 1);
    assert.equal(acknowledgements, 2);
  }
  assert.deepEqual(frames, [{ Type: 2, Data: 2 }, { Type: 2, Data: 6 }]);

  // Two deliveries may both start a paid request before either commits. The
  // late clean result must not publish a submission already marked as spam.
  DB.prepare('UPDATE config SET ai_api_key=?, ai_auto_publish=1').bind(encrypted).run();
  insert.bind(11, 0).run();
  enqueue.bind(11).run();
  const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const replies = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()];
  let index = 0;
  globalThis.fetch = async () => {
    const attempt = index++;
    arrivals[attempt].resolve();
    const verdict = await replies[attempt].promise;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ is_spam: verdict }) } }] });
  };
  const duplicate = { messages: [{ body: { questionId: 11 }, attempts: 1,
    ack() {}, retry() { assert.fail('Unexpected duplicate retry'); } }] } as unknown as MessageBatch<{questionId:number}>;
  const first = moderate(duplicate, env);
  await arrivals[0].promise;
  const second = moderate(duplicate, env);
  await arrivals[1].promise;
  replies[0].resolve(true);
  await first;
  replies[1].resolve(false);
  await second;
  assert.equal(row.bind(11).first()?.is_spam, 1);
  assert.equal(row.bind(11).first()?.is_publish, 0);
  assert.equal(frames.length, 2);
});
