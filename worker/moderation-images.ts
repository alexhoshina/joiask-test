import { Buffer } from 'node:buffer';
import { MAX_IMAGE_SIZE, rasterExtension } from './uploads.ts';

const encoder = new TextEncoder();
const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

// Object keys are selected from committed question_images rows for this question.
// Encode one R2 image at a time; six 5 MiB images would make a 40 MiB JSON string.
export function visionRequestBody(bucket: R2Bucket, objects: string, count: number, options: object,
  system: { role: string; content: string }, userText: string) {
  const keys = objects.split(';');
  if (count < 1 || count > 6 || keys.length !== count || new Set(keys).size !== count ||
      keys.some(key => !/^question-[\w-]+\.(?:png|jpg|gif|webp)$/.test(key))) {
    throw new Error('Incomplete moderation attachments');
  }
  let complete = false;
  async function* encode(): AsyncGenerator<Uint8Array> {
    const textPart = JSON.stringify({ type: 'text', text: userText });
    yield encoder.encode(JSON.stringify(options).slice(0, -1) + ',"messages":[' + JSON.stringify(system)
      + ',{"role":"user","content":[' + textPart);
    for (const key of keys) {
      const file = await bucket.get(key);
      if (!file || file.size <= 0 || file.size > MAX_IMAGE_SIZE) {
        await file?.body.cancel();
        throw new Error('Moderation attachment unavailable');
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const mime = mimeTypes[rasterExtension(bytes)];
      if (!mime || bytes.length !== file.size) throw new Error('Invalid moderation attachment');
      yield encoder.encode(',{"type":"image_url","image_url":{"url":"data:' + mime + ';base64,');
      // Every non-final chunk must contain a multiple of three bytes for valid base64.
      const chunkSize = 48 * 1024;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        yield encoder.encode(bytes.toString('base64', i, Math.min(i + chunkSize, bytes.length)));
      }
      yield encoder.encode('"}}');
    }
    complete = true;
    yield encoder.encode(']}]}');
  }
  const chunks = encode();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() { await chunks.return(undefined); },
  });
  return { body, complete: () => complete };
}
