import { normalizeYouTubeHandle } from '../assets/channel-input.mjs';

const REPO = 'blockchainshadow/social-dashboard';
const GH = `https://api.github.com/repos/${REPO}`;
const SESSION_MS = 8 * 60 * 60 * 1000;
const origins = new Set(['https://social-dashboard-9ya.pages.dev', 'https://blockchainshadow.github.io']);
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const backupKey = /^backups\/dashboard-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?:\.\d{3}-[a-f0-9]{8})?\.enc$/;
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const stmt = (env, sql, ...args) => env.AUTH_DB.prepare(sql).bind(...args);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function cors(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const url = new URL(origin);
  if (!origins.has(origin) && !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) throw new HttpError(403, '来源不允许');
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
async function bodyOf(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 32768) throw new HttpError(413, '请求过大');
  const text = await request.text();
  if (text.length > 32768) throw new HttpError(413, '请求过大');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON 格式错误'); }
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
}
async function verifyPassword(user, password) {
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  const actual = user.salt ? await passwordHash(password, user.salt) : await digest(password);
  if (actual.length !== user.password_hash.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i++) different |= actual.charCodeAt(i) ^ user.password_hash.charCodeAt(i);
  return different === 0;
}
function ghHeaders(env) { return { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'social-dashboard', 'Content-Type': 'application/json' }; }
function encode64(value) {
  const bytes = encoder.encode(value); let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
async function configuration(env) {
  const response = await fetch(`${GH}/contents/channels.json?ref=main`, { headers: ghHeaders(env) });
  if (!response.ok) throw new HttpError(502, '读取频道配置失败');
  const file = await response.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  const channels = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(channels)) throw new HttpError(502, '频道配置无效');
  return { channels, sha: file.sha };
}
const keyOf = item => `${item.platform ?? 'youtube'}:${item.handle}`;
function userView(user, channels) {
  return { user: user.username, role: user.role, mustChangePassword: !!user.must_rotate, channels: channels.filter(c => c.owner === user.username).map(keyOf) };
}
async function session(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, '请重新登录');
  const sessionHash = await digest(token);
  const user = await stmt(env, 'SELECT u.* FROM sessions s JOIN users u ON s.username=u.username AND s.version=u.version WHERE s.token_hash=? AND s.expires_at>?', sessionHash, Date.now()).first();
  if (!user) throw new HttpError(401, '会话已失效，请重新登录');
  return { user, sessionHash };
}
async function queue(env, handle, kind, item, username) {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await stmt(env, "INSERT OR IGNORE INTO requests(id,handle,kind,item,username,status,created_at) VALUES(?,?,?,?,?,'queued',?)", id, handle, kind, JSON.stringify(item), username, now).run();
  const job = await stmt(env, "SELECT id,handle,kind,status,created_at AS createdAt FROM requests WHERE handle=? AND kind=? AND status='queued' ORDER BY created_at LIMIT 1", handle, kind).first();
  return job;
}
async function resolveEntry(env, channels, platform, handle) {
  let entry = channels.find(c => (c.platform ?? 'youtube') === platform && c.handle.toLowerCase() === handle.toLowerCase());
  if (entry || platform !== 'youtube') return entry;
  const object = await env.DATA.get('data/dashboard-index.json');
  const index = object ? await object.json() : null;
  const channelId = /^UC[\w-]{22}$/.test(handle) ? handle : index?.channels?.[handle]?.info?.channelId;
  if (!channelId) return null;
  return channels.find(c => (c.platform ?? 'youtube') === 'youtube' && (c.channelId === channelId || index?.channels?.[c.handle]?.info?.channelId === channelId));
}
function meta(body) {
  const out = {};
  for (const name of ['alias', 'group']) if (typeof body[name] === 'string') out[name] = body[name].trim().slice(0, 120);
  if (Array.isArray(body.tags)) out.tags = [...new Set(body.tags.map(x => String(x).trim()).filter(Boolean))].slice(0, 40);
  if (typeof body.all === 'boolean') out.all = body.all;
  return out;
}
async function management(request, env, user, body) {
  const action = body.action;
  if (action === 'members') {
    if (user.role !== 'admin') throw new HttpError(403, '仅管理员可查看成员');
    const { results: users } = await stmt(env, 'SELECT username,role FROM users ORDER BY username').all();
    return { ok: true, users, channels: (await configuration(env)).channels };
  }
  const platform = body.platform ?? 'youtube';
  if (!['youtube', 'tiktok'].includes(platform)) throw new HttpError(400, '平台无效');
  let handle = platform === 'youtube' ? normalizeYouTubeHandle(body.handle) : String(body.handle ?? '').trim();
  if (platform === 'tiktok' && !handle.startsWith('@')) handle = '@' + handle;
  if (!handle || (platform === 'tiktok' && !/^@[\w.]{1,64}$/.test(handle))) throw new HttpError(400, '账号格式无效');
  if (!['add', 'update', 'delete', 'refresh'].includes(action)) throw new HttpError(400, '操作无效');
  let owner = user.username;
  if (user.role === 'admin' && typeof body.owner === 'string' && body.owner.trim()) {
    owner = body.owner.trim();
    if (!(await stmt(env, 'SELECT username FROM users WHERE username=?', owner).first())) throw new HttpError(400, '指定成员不存在');
  }
  if (action === 'refresh' && platform === 'tiktok') throw new HttpError(409, 'TikTok 保持原采集流程，请通过本地管理刷新');
  for (let attempt = 0; attempt < 4; attempt++) {
    const cfg = await configuration(env);
    let entry = await resolveEntry(env, cfg.channels, platform, handle);
    if (entry) handle = entry.handle;
    if (entry && user.role !== 'admin' && entry.owner !== user.username && !(action === 'add' && !entry.owner)) throw new HttpError(403, '只能管理自己名下的频道');
    if (action !== 'add' && !entry) throw new HttpError(404, '频道不存在');
    if (action === 'refresh') return { ok: true, channels: cfg.channels, job: await queue(env, handle, 'refresh', entry, user.username) };
    if (action === 'add') {
      if (entry?.owner) throw new HttpError(409, '该账号已存在');
      if (entry) Object.assign(entry, meta(body), { owner });
      else {
        entry = { platform, handle, ...meta(body), owner };
        cfg.channels.push(entry);
      }
    } else if (action === 'update') {
      Object.assign(entry, meta(body));
      if (user.role === 'admin' && typeof body.owner === 'string') entry.owner = owner;
    } else cfg.channels = cfg.channels.filter(c => c !== entry);
    const response = await fetch(`${GH}/contents/channels.json`, { method: 'PUT', headers: ghHeaders(env), body: JSON.stringify({ message: `${action}: ${platform} ${handle} (by ${user.username})`, content: encode64(JSON.stringify(cfg.channels, null, 2) + '\n'), sha: cfg.sha, branch: 'main' }) });
    if ([409, 422].includes(response.status)) continue;
    if (!response.ok) throw new HttpError(502, '保存频道配置失败');
    // GitHub is authoritative; public intent becomes visible before the local collector runs.
    await env.DATA.put('channels.json', JSON.stringify(cfg.channels), { httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache' } });
    if (action === 'delete') await stmt(env, "UPDATE requests SET status='cancelled' WHERE handle=? AND status='queued'", handle).run();
    return { ok: true, channels: cfg.channels, ...(action === 'add' && platform === 'youtube' ? { job: await queue(env, handle, 'initial', entry, user.username) } : {}) };
  }
  throw new HttpError(409, '频道配置正在更新，请重试');
}
export default {
  async fetch(request, env) {
    let headers = {};
    try {
      headers = cors(request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith('/internal/')) {
        if (!env.RUNNER_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RUNNER_TOKEN}`) throw new HttpError(401, '采集器认证失败');
        if (pathname === '/internal/publication-object' && request.method === 'PUT') {
          const key = new URL(request.url).searchParams.get('key') ?? '';
          const allowed = ['channels.json', 'cf-usage.json', 'data/cf-usage.json', 'data/dashboard-index.json', 'data/dashboard-jobs.json', 'data/youtube-api-usage.json'].includes(key) ||
            /^data\/channels\/[a-f0-9]{24}\.json$/.test(key) || /^avatars\/[\p{L}\p{N}_.-]+\.(?:jpg|png|webp)$/u.test(key);
          if (!allowed) throw new HttpError(400, '发布对象名不允许');
          if (Number(request.headers.get('Content-Length') || 0) > 100 * 1024 * 1024) throw new HttpError(413, '发布对象超出上传限制');
          await env.DATA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'application/octet-stream', cacheControl: request.headers.get('Cache-Control') ?? 'no-store' } });
          return json({ ok: true }, 200, headers);
        }
        if (pathname === '/internal/requests' && request.method === 'GET') {
          const { results } = await stmt(env, "SELECT id,handle,kind,item FROM requests WHERE status='queued' ORDER BY created_at").all();
          return json({ requests: results.map(r => ({ ...r, item: JSON.parse(r.item) })) }, 200, headers);
        }
        if (pathname === '/internal/ack' && request.method === 'POST') {
          const body = await bodyOf(request);
          await stmt(env, "UPDATE requests SET status='accepted',local_job_id=? WHERE id=? AND status='queued'", String(body.jobId ?? ''), body.id).run();
          return json({ ok: true }, 200, headers);
        }
        if (pathname === '/internal/backups' && request.method === 'GET') {
          const objects = [];
          let cursor;
          do {
            const page = await env.DATA.list({ prefix: 'backups/dashboard-', cursor });
            objects.push(...page.objects.filter(o => backupKey.test(o.key)).map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size })));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          return json({ objects }, 200, headers);
        }
        if (pathname === '/internal/backup-delete' && request.method === 'POST') {
          const body = await bodyOf(request);
          if (!backupKey.test(body.key ?? '')) throw new HttpError(400, '备份对象名无效');
          await env.DATA.delete(body.key);
          return json({ ok: true }, 200, headers);
        }
        if (pathname === '/internal/backup-object') {
          const key = new URL(request.url).searchParams.get('key') ?? '';
          if (!backupKey.test(key)) throw new HttpError(400, '备份对象名无效');
          if (request.method === 'PUT') {
            if (Number(request.headers.get('Content-Length') || 0) > 100 * 1024 * 1024) throw new HttpError(413, '备份超出上传限制');
            await env.DATA.put(key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
            return json({ ok: true }, 200, headers);
          }
          if (request.method === 'GET') {
            const object = await env.DATA.get(key);
            if (!object) throw new HttpError(404, '备份不存在');
            return new Response(object.body, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
          }
        }
        throw new HttpError(404, '接口不存在');
      }
      if (pathname === '/auth/login' && request.method === 'POST') {
        const body = await bodyOf(request);
        const user = await stmt(env, 'SELECT * FROM users WHERE username=?', String(body.username ?? '').slice(0, 120)).first();
        if (!user || !(await verifyPassword(user, body.password))) throw new HttpError(401, '用户名或密码错误');
        // Existing private SHA-256 records are upgraded after the first successful password proof.
        if (!user.salt) {
          const salt = random(), hash = await passwordHash(body.password, salt);
          await stmt(env, 'UPDATE users SET password_hash=?,salt=? WHERE username=? AND salt IS NULL', hash, salt, user.username).run();
        }
        const token = random();
        await env.AUTH_DB.batch([
          stmt(env, 'DELETE FROM sessions WHERE expires_at<=?', Date.now()),
          stmt(env, 'INSERT INTO sessions(token_hash,username,version,expires_at) VALUES(?,?,?,?)', await digest(token), user.username, user.version, Date.now() + SESSION_MS),
        ]);
        return json({ ok: true, token, user: userView(user, (await configuration(env)).channels) }, 200, headers);
      }
      const { user, sessionHash } = await session(request, env);
      if (pathname === '/auth/session' && request.method === 'GET') return json({ ok: true, user: userView(user, (await configuration(env)).channels) }, 200, headers);
      if (pathname === '/auth/logout' && request.method === 'POST') {
        await stmt(env, 'DELETE FROM sessions WHERE token_hash=?', sessionHash).run();
        return json({ ok: true }, 200, headers);
      }
      if (pathname === '/auth/password' && request.method === 'POST') {
        const body = await bodyOf(request);
        if (!(await verifyPassword(user, body.currentPassword))) throw new HttpError(403, '当前密码错误');
        if (body.currentPassword === body.newPassword) throw new HttpError(400, '新密码不能与旧密码相同');
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1024) throw new HttpError(400, '新密码须为 12–1024 个字符');
        const salt = random(), hash = await passwordHash(body.newPassword, salt);
        const changes = await env.AUTH_DB.batch([
          stmt(env, 'UPDATE users SET password_hash=?,salt=?,must_rotate=0,version=version+1 WHERE username=? AND version=?', hash, salt, user.username, user.version),
          stmt(env, 'DELETE FROM sessions WHERE username=? AND EXISTS(SELECT 1 FROM users WHERE username=? AND password_hash=? AND salt=?)', user.username, user.username, hash, salt),
        ]);
        if ((changes[0].meta?.changes ?? changes[0].changes) !== 1) throw new HttpError(409, '密码已由另一请求更新，请重新登录');
        return json({ ok: true, reauthenticate: true }, 200, headers);
      }
      if (user.must_rotate) return json({ error: '请先更换曾公开的旧密码', passwordChangeRequired: true }, 403, headers);
      if (pathname === '/channels' && request.method === 'GET') return json({ ok: true, channels: (await configuration(env)).channels }, 200, headers);
      if (pathname === '/jobs' && request.method === 'GET') {
        const cfg = (await configuration(env)).channels;
        const allowed = new Set(cfg.filter(c => user.role === 'admin' || c.owner === user.username).map(c => c.handle));
        const object = await env.DATA.get('data/dashboard-jobs.json');
        const published = object ? await object.json() : { jobs: [] };
        const rows = Array.isArray(published) ? published : published.jobs ?? [];
        const { results: requests } = await stmt(env, "SELECT id,handle,kind,status,created_at AS createdAt,local_job_id AS localJobId FROM requests WHERE status IN ('queued','accepted') ORDER BY created_at").all();
        const jobs = rows.filter(j => allowed.has(j.handle));
        for (const pending of requests) if (allowed.has(pending.handle) && !jobs.some(j => String(j.id) === pending.localJobId)) jobs.push({ ...pending, status: 'queued' });
        return json({ ok: true, jobs }, 200, headers);
      }
      if ((pathname === '/' || pathname === '/channels') && request.method === 'POST') return json(await management(request, env, user, await bodyOf(request)), 200, headers);
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      if (!error.status) console.error('dashboard-worker request failed', error.name);
      return json({ error: error.status ? error.message : '服务暂时不可用' }, error.status ?? 500, headers);
    }
  },
};
