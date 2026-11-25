import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

test('the vision deadline interrupts a response body after workerd receives its headers', { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: root, contents: `
      import { verifyVision } from './worker/vision-check';
      const networkFetch = globalThis.fetch;
      export default { async fetch() {
        let receivedHeaders = false;
        globalThis.fetch = async (...args) => {
          const response = await networkFetch(...args);
          receivedHeaders = response.headers.has('X-Streaming-Fixture');
          return response;
        };
        try {
          const result = await verifyVision('https://model.example.test', 'vision', 'fixture', 1);
          return Response.json({ result, receivedHeaders });
        } finally { globalThis.fetch = networkFetch; }
      } };
    ` }, bundle: true, write: false, platform: 'node', format: 'esm',
  });
  let finish, upstreamEnded = false;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-24',
    compatibilityFlags: ['nodejs_compat'],
    outboundService() {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"choices":[' + ' '.repeat(8192)));
          // A reader that ignores the deadline eventually receives an invalid response.
          finish = setTimeout(() => { upstreamEnded = true; controller.close(); }, 3500);
        },
        cancel() { clearTimeout(finish); },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Streaming-Fixture': '1' } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch('https://ask.example.test/probe');
    assert.deepEqual(await response.json(), { result: 'timeout', receivedHeaders: true });
    assert.equal(upstreamEnded, false, 'the probe must return before the upstream finishes streaming');
  } finally {
    clearTimeout(finish);
    await runtime.dispose();
  }
});
