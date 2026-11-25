import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../../worker/moderation.ts';

const settings = { ai_base_url: 'https://model.example/v1', ai_model: 'vision', spam_prompt: '垃圾投稿', ai_supports_vision: 1 };
const keys = ['question-test-0.png', 'question-test-1.jpg'];
const images = [
  Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(100013, 0xf1)]),
  Buffer.from([255,216,255,12,36]),
];
const question = { content: '带有 "引号" 和换行\n的正文', images_num: 2, images: keys.join(';') };
const verdict = (fields = {}) => Response.json({ choices: [{ message: { content: '{"is_spam":false}' }, ...fields }] });
function bucketFor(data) {
  return { async get(key) {
    const image = data[keys.indexOf(key)];
    return image && { size: image.length, arrayBuffer: async () => Uint8Array.from(image).buffer };
  } };
}

test('vision sends the exact bytes of each linked raster as Chat Completions image parts', async () => {
  const result = await classify(settings, 'test', question, async (_url, init) => {
    const body = await new Response(init.body).json();
    const [text, png, jpg] = body.messages[1].content;
    assert.deepEqual(JSON.parse(text.text), { content: question.content, images_num: 2 });
    assert.deepEqual(png, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + images[0].toString('base64') } });
    assert.equal(jpg.image_url.url, 'data:image/jpeg;base64,' + images[1].toString('base64'));
    assert.ok(!JSON.stringify(body).includes(keys[0]));
    return verdict({ finish_reason: 'stop' });
  }, bucketFor(images));
  assert.equal(result, false);
});

test('text-only mode does not read or transmit attachments', async () => {
  const result = await classify({ ...settings, ai_supports_vision: 0 }, 'test', question, async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    assert.deepEqual(JSON.parse(user), { content: question.content, images_num: 2 });
    return verdict();
  }, { get() { assert.fail('text-only model attempted to read an image'); } });
  assert.equal(result, false);
});

test('incomplete, missing or invalid images cannot yield a publishable verdict', async () => {
  const consume = async (_url, init) => {
    await new Response(init.body).json();
    return verdict();
  };
  await assert.rejects(classify(settings, 'test', { ...question, images: keys[0] }, consume, bucketFor(images)));
  await assert.rejects(classify(settings, 'test', question, consume, bucketFor(images.slice(0, 1))));
  await assert.rejects(classify(settings, 'test', question, consume, bucketFor([Buffer.from('invalid'), images[1]])));
  await assert.rejects(classify(settings, 'test', question, async () => verdict(), bucketFor(images)));
});

test('refused, filtered and truncated completions are left for manual review', async () => {
  const textOnly = { content: 'text', images_num: 0 };
  for (const fields of [{ finish_reason: 'length' }, { finish_reason: 'content_filter' },
    { message: { content: '{"is_spam":false}', refusal: 'refused' } }]) {
    await assert.rejects(classify(settings, 'test', textOnly, async () => verdict(fields)));
  }
});
