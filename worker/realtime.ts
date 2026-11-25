import { DurableObject } from 'cloudflare:workers';
export { connectRealtime, publish } from './realtime-client';

type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; id: number };
const encoder = new TextEncoder();

export class Realtime extends DurableObject<Env> {
  private subscribers = new Set<Subscriber>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/events' && req.method === 'POST') {
      const event = await req.json<{Type:1 | 2; Data:number}>();
      if (!this.subscribers.size && !this.ctx.getWebSockets().length) return new Response(null,{status:204});
      // API requests may arrive out of commit order. Read the current counts
      // serially in the room so a late publisher cannot undo a newer frame.
      await this.ctx.blockConcurrencyWhile(async () => {
        let payload: unknown = event;
        if (event.Type === 1) {
          const row = await this.env.DB.prepare('SELECT emojis FROM questions WHERE id=?').bind(event.Data).first<{emojis:string}>();
          if (!row) return;
          payload = {Type:1, Data:{card_id:event.Data,emojis:JSON.parse(row.emojis)}};
        }
        const frame = JSON.stringify(payload);
        this.broadcastSockets(frame);
        for (const sub of this.subscribers) this.write(sub, 'id: ' + sub.id++ + '\nevent: emoji\ndata: ' + frame + '\n\n');
      });
      return new Response(null, {status: 204});
    }
    if (path === '/api/sse' && req.method === 'GET') return this.connectSSE(req);
    if (path !== '/api/ws') return new Response(null, {status: 404});
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, {status: 426});
    const [client, server] = Object.values(new WebSocketPair());
    const clientId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(clientId);
    server.send(JSON.stringify({type: 'connected', clientId}));
    return new Response(null, {status: 101, webSocket: client});
  }

  webSocketMessage(sender: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let cursor;
    try { cursor = JSON.parse(message); } catch { return; }
    if (cursor?.type !== 'cursor' || !Number.isSafeInteger(cursor.cardId)
      || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;
    this.broadcastSockets(JSON.stringify({
      type: 'cursor', clientId: sender.deserializeAttachment(), cardId: cursor.cardId, x: cursor.x, y: cursor.y,
    }), sender);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.broadcastSockets(JSON.stringify({type:'cursor_leave', clientId:socket.deserializeAttachment()}), socket);
    // 1005, 1006 and 1015 are synthetic browser statuses, not wire codes.
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.close([1005,1006,1015].includes(code) ? 1000 : code, reason);
    }
  }

  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket, 1011, 'Connection error');
  }

  private broadcastSockets(text: string, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try { socket.send(text); } catch { /* A concurrent close is delivered separately. */ }
    }
  }

  private write(sub: Subscriber, frame: string) {
    try {
      if ((sub.controller.desiredSize ?? 0) <= -64) {
        sub.controller.error(new Error('Event stream client fell behind'));
        this.remove(sub);
      } else {
        sub.controller.enqueue(encoder.encode(frame));
      }
    } catch { this.remove(sub); }
  }

  private remove(sub: Subscriber) {
    this.subscribers.delete(sub);
    if (this.subscribers.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private connectSSE(req: Request) {
    let sub: Subscriber;
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        sub = {controller, id:1};
        this.subscribers.add(sub);
        this.write(sub, 'event: connected\ndata: connected\n\n');
        if (this.heartbeat === null) {
          this.heartbeat = setInterval(() => {
            for (const client of this.subscribers) this.write(client, 'event: heartbeat\ndata: heartbeat\n\n');
          }, 15000);
        }
        req.signal.addEventListener('abort', () => {
          if (this.subscribers.has(sub)) { this.remove(sub); controller.close(); }
        }, {once: true});
      },
      cancel: () => this.remove(sub),
    });
    return new Response(body, {headers: {'Content-Type':'text/event-stream', 'Cache-Control':'no-store'}});
  }
}
