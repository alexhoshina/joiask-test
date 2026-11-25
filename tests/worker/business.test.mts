import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { cleanupStaleUploads, discardUploads, serveUpload, stageQuestionUploads, UploadError } from '../../worker/uploads.ts';

function resources() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(readFileSync(new URL('../../migrations/0003_business.sql', import.meta.url), 'utf8'));
  const files = new Map<string, Blob>();
  const env = {
    DB: { prepare: (s: string) => {
      const statement = sql.prepare(s);
      const bind = (...params: (string | number)[]) => ({
        first: async () => statement.get(...params),
        run: async () => statement.run(...params),
        all: async () => ({results:statement.all(...params)}),
      });
      return {...bind(),bind};
    }},
    FILES: {
      put: async (key: string, value: Blob) => { files.set(key,value); },
      delete: async (keys: string[]) => keys.forEach(k => files.delete(k)),
      head: async (key: string) => {
        const value = files.get(key);
        return value ? {size:value.size,httpEtag:'"fixture"'} : null;
      },
      get: async (key: string) => {
        const value = files.get(key);
        return value ? {body:value.stream(),size:value.size,httpEtag:'"fixture"'} : null;
      },
    },
  } as unknown as Env;
  return {sql,files,env};
}

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,1]);
async function form(files: Uint8Array<ArrayBuffer>[]) {
  const body = new FormData();
  for (const file of files) body.append('files[]',new Blob([file],{type:'text/html'}),'ignored.svg');
  body.set('tag_id','1');
  body.set('content','after the files');
  // Encode on the client side first. A Worker receives a network body, not
  // Undici's outgoing FormData stream, which can enqueue after cancellation.
  const encoded = new Response(body);
  const wire = new Uint8Array(await encoded.arrayBuffer());
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset === wire.length) { controller.close(); return; }
      const next = Math.min(offset + 65536, wire.length);
      controller.enqueue(wire.subarray(offset,next));
      offset = next;
    },
  });
  return new Request('https://example.test/api/question',{
    method:'POST', headers:encoded.headers, body:stream, duplex:'half',
  } as RequestInit);
}

test('an uploaded raster stays private until its question commits and can be collected after deletion', async () => {
  const {sql,files,env} = resources();
  const {fields,images} = await stageQuestionUploads(await form([png]),env,'abc');
  assert.equal(fields.get('content'),'after the files');
  assert.deepEqual(images,['/upload-img/question-abc-0.png']);
  const url = new Request('https://example.test' + images[0]);
  assert.equal((await serveUpload(url,env)).status,404);
  sql.exec("INSERT INTO questions(id,tag_id) VALUES(2,1); UPDATE question_images SET question_id=2;");
  const file = await serveUpload(url,env);
  assert.equal(file.headers.get('X-Content-Type-Options'),'nosniff');
  assert.match(file.headers.get('Content-Security-Policy')!,/sandbox/);
  assert.equal(file.headers.get('Content-Type'),'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),png);
  await discardUploads(env,'abc');
  assert.equal(files.size,1);
  sql.exec("DELETE FROM questions WHERE id=2; UPDATE question_images SET created_at=0;");
  assert.equal((await serveUpload(url,env)).status,404);
  await cleanupStaleUploads(env);
  assert.equal(files.size,0);
  sql.close();
});

test('GET and HEAD retain the legacy upload sandbox and treat unknown file types as attachments', async () => {
  const {sql,files,env} = resources();
  for (const [name,url,mime,disposition] of [
    ['old/logo.SVG','old/logo.SVG','image/svg+xml','inline'],
    ['old/image.jpg.html','old/image.jpg.%68tml','application/octet-stream','attachment'],
    ['old/icon.JPG','old/icon.JPG','image/jpeg','inline'],
  ]) {
    files.set(name,new Blob(['fixture']));
    for (const method of ['GET','HEAD']) {
      const result = await serveUpload(new Request('https://example.test/upload-img/' + url,{method}),env);
      assert.equal(result.status,200);
      assert.equal(result.headers.get('Content-Type'),mime);
      assert.equal(result.headers.get('Content-Disposition'),disposition);
      assert.equal(result.headers.get('X-Content-Type-Options'),'nosniff');
      assert.match(result.headers.get('Content-Security-Policy')!,/^sandbox;/);
      assert.equal(await result.text(),method === 'GET' ? 'fixture' : '');
    }
  }
  sql.close();
});

test('multipart input rejects invalid bytes and a failed submission can dispose of its valid earlier parts', async () => {
  const {sql,files,env} = resources();
  const invalid = new TextEncoder().encode('<svg></svg>');
  await assert.rejects(stageQuestionUploads(await form([png,invalid]),env,'invalid'), (e:unknown) => e instanceof UploadError && e.code === 400);
  await discardUploads(env,'invalid');
  assert.equal(files.size,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM question_images').get()?.n,0);
  sql.close();
});

test('whole-request limit counts multipart framing without Content-Length', async () => {
  const {sql,env} = resources();
  const bytes = new Uint8Array(5 * 1024 * 1024); bytes.set(png);
  const body = await form(Array(6).fill(bytes));
  assert.equal(body.headers.get('Content-Length'),null);
  await assert.rejects(stageQuestionUploads(body,env,'limit'), (e:unknown) => e instanceof UploadError && e.code === 413);
  await discardUploads(env,'limit');
  sql.close();
});

test('accepts six images and exactly 5 MiB per file, and rejects the next image or byte', async () => {
  const {sql, files, env} = resources();
  const limit = 5 * 1024 * 1024;
  const largest = new Uint8Array(limit);
  largest.set(png);
  const six = [largest, png, png, png, png, png];
  const accepted = await stageQuestionUploads(await form(six), env, 'accepted');
  assert.equal(accepted.images.length, 6);
  assert.equal(files.get('question-accepted-0.png')?.size, limit);
  await discardUploads(env, 'accepted');
  const oversized = new Uint8Array(limit + 1);
  oversized.set(png);
  for (const rejected of [[png, oversized], [...six, png]]) {
    await assert.rejects(stageQuestionUploads(await form(rejected), env, 'rejected'),
      (error: unknown) => error instanceof UploadError && error.code === 400);
    await discardUploads(env, 'rejected');
    assert.equal(files.size, 0);
  }
  sql.close();
});

test('reaction counts include historical JSON and one IP can react only once per question', () => {
  const {sql} = resources();
  sql.exec('INSERT INTO questions(id,tag_id,emojis) VALUES(10,1,\'[{"value":"👍","count":4}]\')');
  const insert = sql.prepare('INSERT INTO like_records(ip,question_id,emoji) VALUES(?,10,?) ON CONFLICT(ip,question_id) DO NOTHING');
  insert.run('one','👍'); insert.run('two','💖'); insert.run('one','💖');
  const row = sql.prepare('SELECT emojis FROM questions WHERE id=10').get()!;
  assert.deepEqual(JSON.parse(String(row.emojis)),[{value:'👍',count:5},{value:'💖',count:1}]);
  sql.exec('DELETE FROM questions WHERE id=10');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM like_records').get()?.n,0);
  sql.close();
});
