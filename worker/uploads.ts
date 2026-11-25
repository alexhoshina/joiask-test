import { MultipartParseError, parseMultipartStream } from '@remix-run/multipart-parser/future';
import { getMultipartBoundary } from '@remix-run/multipart-parser';

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const maxQuestionBody = 30 * 1024 * 1024;
const uploadPrefix = '/upload-img/';

export class UploadError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

function cappedStream(body: ReadableStream<Uint8Array>, maximum: number, onLimit: () => void) {
  let length = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > maximum) onLimit();
      controller.enqueue(chunk);
    },
  }));
}

export async function readLimited(body: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const stream = cappedStream(body, maximum, () => { throw new UploadError(413, '文件大小超过限制'); });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function boundedBody(req: Request, maximum: number) {
  const tooLarge = () => { throw new UploadError(413, '请求大小不能超过 ' + (maximum / 1048576) + ' MiB'); };
  if (Number(req.headers.get('Content-Length')) > maximum) tooLarge();
  if (!req.body) throw new UploadError(400, '请求格式错误');
  return cappedStream(req.body, maximum, tooLarge);
}

export async function limitedForm(req: Request, maximum: number): Promise<FormData> {
  try {
    return await new Response(boundedBody(req, maximum), {headers: req.headers}).formData();
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, '请求格式错误');
  }
}

export function rasterExtension(bytes: Uint8Array): string {
  const starts = (signature: number[], offset = 0) => signature.every((v, i) => bytes[i + offset] === v);
  if (starts([137,80,78,71,13,10,26,10])) return '.png';
  if (starts([255,216,255])) return '.jpg';
  if (starts([71,73,70,56,55,97]) || starts([71,73,70,56,57,97])) return '.gif';
  if (starts([82,73,70,70]) && starts([87,69,66,80,86,80], 8)) return '.webp';
  return '';
}

export async function putImage(bucket: R2Bucket, key: string, body: Uint8Array | Blob): Promise<string> {
  const data = body instanceof Blob ? body : new Uint8Array(body);
  await bucket.put(key, data);
  return uploadPrefix + key;
}

// Reading each multipart part separately avoids retaining a batch of six
// images in the isolate. Reserved keys are not publicly readable until commit.
export async function stageQuestionUploads(req: Request, env: Env, submission: string) {
  const contentType = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const fields = new Map<string, string>();
  const images: string[] = [];
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = await limitedForm(req, maxQuestionBody);
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string' && !fields.has(name)) fields.set(name, value);
    }
    return { fields, images };
  }
  if (contentType !== 'multipart/form-data') throw new UploadError(400, '请求格式错误');
  const boundary = getMultipartBoundary(req.headers.get('Content-Type')!);
  if (!boundary) throw new UploadError(400, '请求格式错误');
  const parts = parseMultipartStream(boundedBody(req, maxQuestionBody), {boundary, maxFileSize:maxQuestionBody});
  const fieldNames = new Set(['tag_id','real_name','hide','rainbow','content']);
  try {
    for await (const part of parts) {
      if (!part.isFile) {
        if (part.name && fieldNames.has(part.name) && !fields.has(part.name)) fields.set(part.name, await part.text());
        continue;
      }
      if (part.name !== 'files[]') continue;
      if (images.length === 6) throw new UploadError(400, '最多上传 6 张图片');
      // Drain oversized parts without buffering them, so the whole-request
      // limit still applies to chunked requests without Content-Length.
      let length = 0;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for await (const chunk of part) {
        length += chunk.byteLength;
        if (length <= MAX_IMAGE_SIZE) chunks.push(chunk);
      }
      if (!length || length > MAX_IMAGE_SIZE) throw new UploadError(400, '图片不能为空且不能超过 5 MiB');
      const file = new Blob(chunks);
      const extension = rasterExtension(new Uint8Array(await file.slice(0,16).arrayBuffer()));
      if (!extension) throw new UploadError(400, '仅支持 PNG、JPEG、GIF 或 WebP 图片');
      const key = 'question-' + submission + '-' + images.length + extension;
      await env.DB.prepare('INSERT INTO question_images(object_key,submission_id) VALUES(?,?)').bind(key, submission).run();
      images.push(await putImage(env.FILES, key, file));
    }
  } catch (error) {
    if (error instanceof MultipartParseError) throw new UploadError(400, '请求格式错误');
    throw error;
  }
  return { fields, images };
}

async function removeReserved(env: Env, keys: string[]) {
  if (!keys.length) return;
  await env.FILES.delete(keys);
  await env.DB.prepare('DELETE FROM question_images WHERE discarded=1 AND object_key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(keys)).run();
}

export async function discardUploads(env: Env, submission: string) {
  const claimed = await env.DB.prepare('UPDATE question_images SET discarded=1 WHERE question_id IS NULL AND submission_id=? RETURNING object_key')
    .bind(submission).all<{object_key: string}>();
  await removeReserved(env, claimed.results.map(r => r.object_key));
}

export async function cleanupStaleUploads(env: Env) {
  const claimed = await env.DB.prepare(
    'UPDATE question_images SET discarded=1 WHERE object_key IN (' +
    'SELECT object_key FROM question_images WHERE question_id IS NULL AND (discarded=1 OR created_at < unixepoch()-86400) LIMIT 100) RETURNING object_key'
  ).all<{object_key: string}>();
  await removeReserved(env, claimed.results.map(r => r.object_key));
}

const types: Record<string, string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
export async function serveUpload(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, {status: 405, headers: {Allow:'GET, HEAD'}});
  let key;
  try { key = decodeURIComponent(new URL(req.url).pathname.slice(uploadPrefix.length)); }
  catch { return new Response(null, {status: 400}); }
  if (!key || /[\0\\]/.test(key) || key.split('/').some(p => !p || p === '.' || p === '..')) return new Response(null, {status: 404});
  if (key.startsWith('question-') && !await env.DB.prepare('SELECT question_id FROM question_images WHERE object_key=? AND question_id IS NOT NULL')
    .bind(key).first()) return new Response(null, {status: 404});
  if (key.startsWith('member-avatar-') && !await env.DB.prepare("SELECT 1 FROM avatar_uploads WHERE object_key=? AND state='linked'")
    .bind(key).first()) return new Response(null, {status: 404});
  const file = req.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!file) return new Response(null, {status: 404});
  const extension = key.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || '';
  const mime = Object.hasOwn(types, extension) ? types[extension] : undefined;
  const headers = new Headers({
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': mime ? 'inline' : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    'Content-Length': String(file.size), ETag: file.httpEtag,
  });
  if (req.headers.get('If-None-Match') === file.httpEtag) return new Response(null, {status: 304, headers});
  return new Response('body' in file ? (file as R2ObjectBody).body : null, {headers});
}
