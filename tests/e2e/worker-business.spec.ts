import { test, expect, apiData } from './fixtures.js';
import type { Page } from '@playwright/test';

test('Worker serves sniffed raster attachments and rejects SVG submissions', async ({ request, adminApi, dataset }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCHsAAAAASUVORK5CYII=', 'base64');
  const content = 'R2 ' + dataset.tag.tag_name;
  const post = (bytes:Buffer) => request.post('/api/question', { multipart: {
    tag_id:String(dataset.tag.id), content, 'files[]':{name:'upload.svg',mimeType:'image/svg+xml',buffer:bytes},
  } });
  expect((await (await post(Buffer.from('<svg/>'))).json()).code).toBe(400);
  await apiData(post(png));
  const listing = await apiData<{questions:{id:number;images:string;images_num:number}[]}>(adminApi.get('/api/question', {params:{tag_id:dataset.tag.id}}));
  expect(listing.questions).toHaveLength(1);
  const [question] = listing.questions;
  expect(question.images_num).toBe(1);
  for (const response of [await request.get(question.images), await request.head(question.images)]) {
    expect(response.status()).toBe(200);
    expect(response.headers()).toMatchObject({
      'content-type':'image/png','content-disposition':'inline','x-content-type-options':'nosniff',
      'content-security-policy':"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    });
  }
  expect(await (await request.get(question.images)).body()).toEqual(png);
  await apiData(adminApi.delete('/api/question/' + question.id));
  expect((await request.get(question.images)).status()).toBe(404);
});

type WireEvent = {
  type?: string;
  clientId?: string;
  cardId?: number;
  Type?: number;
  Data?: unknown;
};

declare global {
  interface Window {
    realtimeTest: {
      socket: WebSocket;
      events?: EventSource;
      connectedToSSE: boolean;
      websocketFrames: WireEvent[];
      sseFrames: WireEvent[];
    };
  }
}

async function openSocketPage(page: Page) {
  // A real document gives Chromium the site's network address space. The
  // static docs do not open their own realtime subscriptions.
  await page.goto('/docs/');
  await page.evaluate(() => {
    const url = new URL('/api/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    window.realtimeTest = { socket, connectedToSSE: false, websocketFrames: [], sseFrames: [] };
    socket.onmessage = message => window.realtimeTest.websocketFrames.push(JSON.parse(message.data));
  });
  await expect.poll(() => page.evaluate(() => window.realtimeTest.websocketFrames.find(frame => frame.type === 'connected')?.clientId))
    .toEqual(expect.any(String));
  return page.evaluate(() => window.realtimeTest.websocketFrames.find(frame => frame.type === 'connected')!.clientId!);
}

function expectFrame(page: Page, transport: 'websocketFrames' | 'sseFrames', frame: WireEvent) {
  return expect.poll(() => page.evaluate(key => window.realtimeTest[key], transport)).toContainEqual(frame);
}

test('two browser sessions exchange cursors and receive reactions and archive updates over WebSocket and SSE', async ({
  browser, adminApi, dataset, baseURL,
}) => {
  const question = await dataset.createQuestion('Realtime ' + dataset.tag.tag_name, { is_publish: true });
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const [a, b] = await Promise.all([first.newPage(), second.newPage()]);
    const [sender, recipient] = await Promise.all([openSocketPage(a), openSocketPage(b)]);
    expect(sender).not.toBe(recipient);

    const cursor = { type: 'cursor', cardId: question.id, x: 0.25, y: 0.5 };
    await a.evaluate(position => window.realtimeTest.socket.send(JSON.stringify(position)), cursor);
    await expectFrame(b, 'websocketFrames', { ...cursor, clientId: sender });

    await a.evaluate(() => window.realtimeTest.socket.close());
    await expectFrame(b, 'websocketFrames', { type: 'cursor_leave', clientId: sender });
    const streamResponse = a.waitForResponse(response => new URL(response.url()).pathname === '/api/sse');
    await a.evaluate(() => {
      const stream = new EventSource('/api/sse');
      window.realtimeTest.events = stream;
      stream.addEventListener('connected', event => { window.realtimeTest.connectedToSSE = event.data === 'connected'; });
      stream.addEventListener('emoji', event => window.realtimeTest.sseFrames.push(JSON.parse(event.data)));
    });
    expect((await streamResponse).headers()['content-type']).toContain('text/event-stream');
    await expect.poll(() => a.evaluate(() => window.realtimeTest.connectedToSSE)).toBe(true);

    const react = (emoji: string) => b.evaluate(async ({ id, value }) => {
      const response = await fetch('/api/question/' + id + '/emoji', { method: 'POST', body: new URLSearchParams({ emoji: value }) });
      return (await response.json()).code;
    }, { id: question.id, value: emoji });
    expect(await react('👍')).toBe(200);
    const reaction = { Type: 1, Data: { card_id: question.id, emojis: [{ value: '👍', count: 1 }] } };
    await Promise.all([expectFrame(a, 'sseFrames', reaction), expectFrame(b, 'websocketFrames', reaction)]);
    expect(await react('💖')).toBe(400);

    await apiData(adminApi.put('/api/question/' + question.id, { data: { ...question, is_archive: true } }));
    const archive = { Type: 2, Data: question.id };
    await Promise.all([expectFrame(a, 'sseFrames', archive), expectFrame(b, 'websocketFrames', archive)]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
