import ssr from './ssr';
import { business } from './business';
import { cleanupStaleAvatars } from './avatars';
import { fail } from './common';
import { identity } from './identity';
import { moderate, recoverModeration, type ModerationJob } from './moderation';
import { settings } from './settings';
import { cleanupStaleUploads, serveUpload, UploadError } from './uploads';

export { Realtime } from './realtime';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/upload-img/')) return await serveUpload(request, env);
      if (url.pathname.startsWith('/api/')) {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin &&
          (request.method !== 'GET' || request.headers.has('Upgrade') || url.pathname === '/api/logout')) {
          return fail(403, '不允许跨站操作');
        }
        return await identity(request, env) ?? await settings(request, env)
          ?? await business(request, env, ctx) ?? fail(404, '接口不存在');
      }
      if (/^\/(?:admin|docs)(?:\/|$)/.test(url.pathname)) return await env.ASSETS.fetch(request);
      return await ssr.fetch(request, env, ctx);
    } catch (err) {
      if (err instanceof UploadError) return fail(err.code, err.message);
      if (err instanceof SyntaxError && url.pathname.startsWith('/api/')) return fail(400, '请求格式错误');
      console.error({ event: 'request_failed', category: err instanceof Error ? err.name : 'unknown',
        path: url.pathname, method: request.method });
      return url.pathname.startsWith('/api/') ? fail(500, '内部错误') : new Response('服务暂不可用', { status: 500 });
    }
  },
  queue: moderate,
  async scheduled(_event, env) {
    await Promise.all([recoverModeration(env), cleanupStaleUploads(env), cleanupStaleAvatars(env)]);
  },
} satisfies ExportedHandler<Env, ModerationJob>;
