import { fail, ok } from './common';
import { currentAdmin, currentMember } from './identity-shared';
import { connectRealtime, publish } from './realtime';
import { discardUploads, limitedForm, stageQuestionUploads, UploadError } from './uploads';

const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const badId = () => fail(400, 'ID 必须是正整数');
function recordId(raw: string | undefined) {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 && Number.isSafeInteger(id) ? id : null;
}

type Row = Record<string, unknown>;
async function objectBody(req: Request): Promise<Row | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Row : null;
  } catch { return null; }
}

async function tags(req: Request, env: Env, id: number | null) {
  const db = env.DB;
  if (req.method === 'GET') {
    const rows = await db.prepare('SELECT t.id,t.tag_name,t.description,t.created_at,COUNT(q.id) AS question_count ' +
      'FROM tags t LEFT JOIN questions q ON q.tag_id=t.id GROUP BY t.id ORDER BY t.id').all();
    return ok(rows.results);
  }
  if (req.method === 'DELETE') {
    if (id === 1) return fail(403, '不能删除默认话题');
    const row = await db.prepare('DELETE FROM tags WHERE id=? AND NOT EXISTS(SELECT 1 FROM questions WHERE tag_id=tags.id) RETURNING id').bind(id).first();
    if (row) return ok();
    return await db.prepare('SELECT id FROM tags WHERE id=?').bind(id).first() ? fail(400, '话题仍在使用中') : fail(404, '话题不存在');
  }
  const body = await objectBody(req);
  if (!body || typeof (body.tag_name ?? '') !== 'string' || typeof (body.description ?? '') !== 'string') return fail(400, 'invalid request');
  const values = [body.tag_name ?? '', body.description ?? ''];
  try {
    const result = id === null
      ? await db.prepare('INSERT INTO tags(tag_name,description) VALUES(?,?) RETURNING *').bind(...values).first()
      : await db.prepare('UPDATE tags SET tag_name=?,description=?,updated_at=' + timestamp + ' WHERE id=? RETURNING *').bind(...values, id).first();
    return result ? ok(result) : fail(404, 'tag not found');
  } catch (error) {
    if (String(error).includes('UNIQUE')) return id === null ? fail(401, '创建话题失败') : fail(500, 'internal server error');
    throw error;
  }
}

function validEmojiURL(url: string) {
  if (url.includes('\\') || /[\x00-\x1f]/.test(url)) return false;
  if (url.startsWith('/')) return !url.startsWith('//');
  try {
    const link = new URL(url);
    return ['https:', 'http:'].includes(link.protocol) && !!link.hostname && !link.username && !link.password;
  } catch { return false; }
}

async function catalog(req: Request, env: Env, id: number | null) {
  const db = env.DB;
  if (req.method === 'GET') return ok((await db.prepare('SELECT * FROM emojis ORDER BY id').all()).results);
  if (req.method === 'DELETE') {
    return await db.prepare('DELETE FROM emojis WHERE id=? RETURNING id').bind(id).first() ? ok() : fail(404, 'emoji not found');
  }
  const body = await objectBody(req);
  if (!body || typeof body.tag !== 'string' || typeof body.url !== 'string') return fail(400, 'invalid request');
  const tag = body.tag.trim(), url = body.url.trim();
  if (!tag || [...tag].length > 255 || [...url].length > 1024 || !validEmojiURL(url)) {
    return fail(400, 'tag 和 url 不能为空，且 url 必须是站内路径或 HTTP(S) 地址');
  }
  try {
    const result = id === null
      ? await db.prepare('INSERT INTO emojis(tag,url) VALUES(?,?) RETURNING *').bind(tag,url).first()
      : await db.prepare('UPDATE emojis SET tag=?,url=?,updated_at=' + timestamp + ' WHERE id=? RETURNING *').bind(tag,url,id).first();
    return result ? ok(result) : fail(404, 'emoji not found');
  } catch (error) {
    if (String(error).includes('UNIQUE')) return fail(400, 'tag already exists');
    throw error;
  }
}

function questionDTO(row: Row) {
  const {submission_id, moderation_version, tag_name, tag_description, tag_created, tag_updated,
    bilibili_uid, bilibili_name, bilibili_avatar, ...question} = row;
  for (const field of ['is_hide','is_rainbow','is_archive','is_publish','is_spam','is_real_name']) question[field] = Boolean(question[field]);
  question.tag = { id:row.tag_id, tag_name, description:tag_description, created_at:tag_created, updated_at:tag_updated };
  if (question.is_real_name && bilibili_uid != null) {
    question.bilibili_uid = String(bilibili_uid);
    if (bilibili_name) question.bilibili_name = bilibili_name;
    if (bilibili_avatar) question.bilibili_avatar = bilibili_avatar;
  }
  return question;
}

const sortKeys = new Set(['id','created_at','is_hide','is_rainbow','is_archive','is_publish']);
async function listQuestions(req: Request, env: Env) {
  const query = new URL(req.url).searchParams;
  const admin = await currentAdmin(req,env);
  const filters: string[] = [], values: (string | number)[] = [];
  const add = (condition: string, value: string | number) => { filters.push(condition); values.push(value); };
  for (const field of ['page','page_size','tag_id']) {
    const raw = query.get(field);
    if (raw && (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return fail(400, '请求错误');
  }
  if (Number(query.get('tag_id')) > 0) add('q.tag_id=?', Number(query.get('tag_id')));
  if (query.get('search')) add('q.content LIKE ?', '%' + query.get('search') + '%');
  const toggles = {hide:'is_hide', rainbow:'is_rainbow', archive:'is_archive', is_spam:'is_spam', publish:'is_publish'};
  for (const [param, column] of Object.entries(toggles)) {
    const raw = query.get(param);
    if (!raw) continue;
    if (!/^(true|false|t|f|0|1)$/i.test(raw)) return fail(400, '请求错误');
    if (param !== 'publish' || admin) add('q.' + column + '=?', /^(1|true|t)$/i.test(raw) ? 1 : 0);
  }
  if (!admin) filters.push('q.is_publish=1');
  const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const requested = query.get('order_by') || '';
  const order = sortKeys.has(requested) ? requested : 'id';
  const direction = query.get('order') === 'asc' ? ' ASC' : ' DESC';
  const page = Math.max(1, Number(query.get('page')) || 1);
  const size = Math.max(5, Math.min(100, Number(query.get('page_size')) || 5));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * size);
  const [count, list] = await env.DB.batch<Row>([
    env.DB.prepare('SELECT count(*) AS total FROM questions q' + where).bind(...values),
    env.DB.prepare('SELECT q.*,t.tag_name,t.description AS tag_description,t.created_at AS tag_created,t.updated_at AS tag_updated ' +
      'FROM questions q JOIN tags t ON t.id=q.tag_id' + where + ' ORDER BY q.' + order + direction +
      (order !== 'is_archive' ? ',q.is_archive ASC' : '') + ',q.id DESC LIMIT ? OFFSET ?').bind(...values,size,offset),
  ]);
  return ok({questions:list.results.map(questionDTO), total:count.results[0].total, page, page_size:size});
}

async function enqueueModeration(env: Env, id: number) {
  await env.MODERATION.send({questionId:id});
  await env.DB.prepare('UPDATE moderation_outbox SET last_enqueued_at=unixepoch() WHERE question_id=?').bind(id).run();
}

async function postQuestion(req: Request, env: Env, ctx: ExecutionContext) {
  const config = await env.DB.prepare('SELECT require_verified_user_to_post FROM config LIMIT 1').first();
  if (!config) return fail(500, '内部错误');
  const member = await currentMember(req,env);
  if (config.require_verified_user_to_post && !member) return fail(403, '投稿需要先完成 B 站验证并登录');
  const submission = crypto.randomUUID();
  let committed = false;
  try {
    const { fields, images } = await stageQuestionUploads(req,env,submission);
    const real = fields.get('real_name') === 'true';
    if (real && !member) return fail(403, '实名投稿需要先完成 B 站验证并登录');
    const tag = recordId(fields.get('tag_id'));
    if (!tag) return badId();
    const db = env.DB;
    if (!await db.prepare('SELECT id FROM tags WHERE id=?').bind(tag).first()) return fail(404, '话题不存在');
    const [insert,,outbox] = await db.batch<Row>([
      db.prepare('INSERT INTO questions(submission_id,tag_id,content,images_num,images,bilibili_uid,bilibili_name,bilibili_avatar,is_real_name,is_hide,is_rainbow) ' +
        'SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM question_images WHERE submission_id=? AND discarded=0)=? RETURNING id')
        .bind(submission,tag,(fields.get('content') || '').replace(/^[ \r\n\t]+|[ \r\n\t]+$/g,''),images.length,images.join(';'),
          member?.bilibili_uid ?? null, real ? member!.bilibili_name : '', real ? member!.bilibili_avatar : '',
          Number(real), Number(fields.get('hide') === 'true'), Number(fields.get('rainbow') === 'true'), submission,images.length),
      db.prepare('UPDATE question_images SET question_id=(SELECT id FROM questions WHERE submission_id=?) WHERE submission_id=? AND discarded=0')
        .bind(submission,submission),
      db.prepare("INSERT INTO moderation_outbox(question_id) SELECT id FROM questions WHERE submission_id=? AND EXISTS(SELECT 1 FROM config WHERE ai_api_key<>'') RETURNING question_id")
        .bind(submission),
    ]);
    if (!insert.results.length) return fail(409, '上传已过期，请重试');
    committed = true;
    if (outbox.results.length) ctx.waitUntil(enqueueModeration(env, Number(insert.results[0].id)).catch(() => {
      // The scheduled dispatcher retries the durable outbox row.
      console.error('Immediate moderation dispatch failed for question', insert.results[0].id);
    }));
    return ok();
  } catch (error) {
    if (error instanceof UploadError) return fail(error.code, error.message);
    throw error;
  } finally {
    // Even after an ambiguous D1 commit this only cleans unlinked objects.
    if (!committed) await discardUploads(env,submission);
  }
}

async function modifyQuestion(req: Request, env: Env, id: number, ctx: ExecutionContext) {
  if (req.method === 'DELETE') {
    const row = await env.DB.prepare('DELETE FROM questions WHERE id=? RETURNING submission_id').bind(id).first<{submission_id:string | null}>();
    if (!row) return fail(404, '提问不存在');
    if (row.submission_id) ctx.waitUntil(discardUploads(env,row.submission_id));
    return ok();
  }
  const body = await objectBody(req);
  if (!body || !Number.isSafeInteger(body.tag_id) || Number(body.tag_id) <= 0) return fail(400, '请求错误');
  const flags = ['is_hide','is_rainbow','is_archive','is_publish','is_spam'];
  if (flags.some(k => body[k] != null && typeof body[k] !== 'boolean')) return fail(400, '请求错误');
  if (!await env.DB.prepare('SELECT id FROM tags WHERE id=?').bind(body.tag_id).first()) return fail(404, '话题不存在');
  const result = await env.DB.prepare('UPDATE questions SET tag_id=?,is_hide=?,is_rainbow=?,is_archive=?,is_publish=?,' +
    'is_spam=coalesce(?,is_spam),moderation_version=moderation_version+1,updated_at=' + timestamp + ' WHERE id=? RETURNING id')
    .bind(body.tag_id,...flags.slice(0,4).map(k => Number(body[k] === true)), body.is_spam == null ? null : Number(body.is_spam),id).first();
  if (!result) return fail(404, '提问不存在');
  ctx.waitUntil(publish(env,{Type:2,Data:id}));
  return ok();
}

const reactions = new Set(['👍','👎','🤣','😭','😓','😬','🥳','😨','😠','💩','💖','🐵','❓','🫂','🔘','👅','🥺','👻','😅','🌹']);
async function react(req: Request, env: Env, id: number, ctx: ExecutionContext) {
  let form: FormData;
  try { form = await limitedForm(req, 64 * 1024); } catch { return fail(400, '无效的表情符号'); }
  const emoji = form.get('emoji');
  if (typeof emoji !== 'string' || !reactions.has(emoji)) return fail(400, '无效的表情符号');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const [insert,read] = await env.DB.batch<Row>([
    env.DB.prepare('INSERT INTO like_records(ip,question_id,emoji) SELECT ?,id,? FROM questions WHERE id=? ON CONFLICT(ip,question_id) DO NOTHING RETURNING id')
      .bind(ip,emoji,id),
    env.DB.prepare('SELECT id FROM questions WHERE id=?').bind(id),
  ]);
  if (!read.results.length) return fail(404, '提问不存在');
  if (!insert.results.length) return fail(400, '您已经评价过了');
  ctx.waitUntil(publish(env, {Type:1,Data:id}));
  return ok();
}

async function stats(env: Env) {
  const [totals,counts] = await env.DB.batch<Row>([
    env.DB.prepare('SELECT count(*) AS total_questions,(SELECT count(*) FROM tags) AS total_tags,(SELECT count(*) FROM admins) AS total_users,' +
      '(SELECT count(*) FROM users) AS total_members,coalesce(sum(images_num),0) AS total_images,coalesce(sum(is_rainbow),0) AS rainbow_questions,' +
      'coalesce(sum(is_archive),0) AS archived_questions,coalesce(sum(is_publish),0) AS published_questions FROM questions'),
    env.DB.prepare('SELECT t.*,COUNT(q.id) AS count FROM tags t LEFT JOIN questions q ON q.tag_id=t.id GROUP BY t.id ORDER BY t.id'),
  ]);
  return ok({...totals.results[0],tag_stats:counts.results.map(({count,...tag}) => ({tag,count}))});
}

export async function business(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const path = new URL(req.url).pathname, method = req.method;
  if (method === 'GET' && (path === '/api/sse' || path === '/api/ws')) return connectRealtime(req, env);
  if (method === 'GET' && path === '/api/statistics') {
    return await currentAdmin(req,env) ? stats(env) : fail(408,'请先登录');
  }
  const match = path.match(/^\/api\/(tag|emoji|question)(?:\/([^/]+)(\/emoji)?)?$/);
  if (!match) return null;
  const [, resource, raw, reaction] = match;
  const isReact = resource === 'question' && reaction && method === 'POST';
  if (reaction && !isReact) return null;
  if (!raw && !['GET','POST'].includes(method) || raw && !isReact && !['PUT','DELETE'].includes(method)) return null;
  const publicRoute = !raw && method === 'GET' || resource === 'question' && method === 'POST';
  if (!publicRoute && !await currentAdmin(req,env)) return fail(408,'请先登录');
  const id = recordId(raw);
  if (raw && !id) return badId();
  if (resource === 'tag') return tags(req,env,id);
  if (resource === 'emoji') return catalog(req,env,id);
  if (id && isReact) return react(req,env,id,ctx);
  if (id) return modifyQuestion(req,env,id,ctx);
  if (method === 'GET') return listQuestions(req,env);
  return postQuestion(req,env,ctx);
}
