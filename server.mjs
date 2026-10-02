#!/usr/bin/env node
// 本地看板服务：静态托管 + 多平台账号管理 API（零依赖）
// 用法: node server.mjs [端口默认 8000]

import http from "node:http";
import { readFile, writeFile, rename, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "./scripts/dashboard-store.mjs";
import { runJobs } from "./scripts/run-dashboard-jobs.mjs";
import { normalizeYouTubeHandle } from "./assets/channel-input.mjs";
import * as tt from "./scripts/fetch-tiktok.mjs";

const ROOT = process.env.DASH_ROOT ?? process.cwd();

const CONFIG_FILE = path.resolve(ROOT, "channels.json");
const RELAY = process.env.DASH_RELAY || "https://dry-flower-a30f.xyxcliff.workers.dev";
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8000);
// 安全默认值：只绑回环。如需局域网/公网访问，必须显式设置 HOST 并配置 DASH_TOKEN
const HOST = process.env.HOST ?? "127.0.0.1";
const ADMIN_TOKEN = process.env.DASH_TOKEN ?? "";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

if (!LOOPBACK.has(HOST) && !ADMIN_TOKEN) {
  console.error(`拒绝启动：HOST=${HOST} 为非回环地址，但未设置 DASH_TOKEN；远程运维入口必须显式启用受控访问。`);
  console.error("如确需远程访问，请设置 DASH_TOKEN 环境变量后再启动。");
  process.exit(1);
}

const store = openStore({ root: ROOT });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, code, data, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj));

async function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = path.posix.normalize(decodeURIComponent(urlPath));
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel === "/web" || rel === "/web/") rel = "/web/index.html";
  if (!rel.startsWith("/") || rel.split("/").includes("..")) return sendJson(res, 404, { error: "not found" });
  const publicFile =
    ["/index.html", "/web/index.html", "/channels.json", "/cf-usage.json",
      "/assets/dashboard-client.mjs", "/assets/channel-input.mjs",
      "/data/dashboard-index.json", "/data/dashboard-jobs.json", "/data/youtube-api-usage.json",
      "/data/tiktok-history.json"].includes(rel) ||
    /^\/(?:web\/)?avatars\/[^/]+\.(?:jpe?g|png|webp|svg|ico)$/i.test(rel) ||
    /^\/data\/channels\/[^/]+\.json$/.test(rel);
  if (!publicFile) return sendJson(res, 404, { error: "not found" });
  const rootReal = await realpath(ROOT);
  try {
    const filePath = await realpath(path.resolve(ROOT, "." + rel));
    if (!filePath.startsWith(rootReal + path.sep)) return sendJson(res, 404, { error: "not found" });
    const buf = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".json" || ext === ".html" ? "no-store" : "public, max-age=60",
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    req.on("end", () => {
      if (size > maxBytes) return finish(null);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        finish({});
      }
    });
    req.on("error", () => finish({}));
  });
}

function getBearer(req) {
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return "";
}

async function relayAuth(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body != null) init.body = JSON.stringify(body);
  const r = await fetch(`${RELAY}${path}`, init);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

async function validateSession(req) {
  const token = getBearer(req);
  if (!token) return null;
  const { ok, body } = await relayAuth("GET", "/auth/session", null, token);
  if (!ok || !body.user) return null;
  return body.user;
}

function isLocalAdmin(req) {
  return !!ADMIN_TOKEN && req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
}

function entryHandle(c) { return typeof c === "string" ? c : c.handle; }
function entryPlatform(c) { return typeof c === "string" ? "youtube" : c.platform ?? "youtube"; }

async function readConfig() {
  const value = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  if (!Array.isArray(value)) throw new Error("channels.json must be an array");
  return value;
}

async function writeConfigAtomic(config) {
  if (!Array.isArray(config)) throw new Error("Worker did not return channel configuration");
  const tmp = `${CONFIG_FILE}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2));
    await rename(tmp, CONFIG_FILE);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

let mutationQueue = Promise.resolve();
function serializeMutation(operation) {
  const task = mutationQueue.then(operation);
  mutationQueue = task.catch(() => {});
  return task;
}

async function workerConfig(token) {
  const response = await relayAuth("GET", "/channels", null, token);
  if (!response.ok) return response;
  if (!Array.isArray(response.body.channels)) throw new Error("Worker did not return channel configuration");
  return response;
}

function normalizeHandle(platform, value) {
  return platform === "youtube" ? normalizeYouTubeHandle(value) : tt.normalizeTikTokHandle(value);
}

function resolveEntry(platform, value, config) {
  const normalized = normalizeHandle(platform, value);
  if (!normalized) return null;
  const exact = config.find((entry) => entryPlatform(entry) === platform && entryHandle(entry) === normalized);
  if (exact || platform !== "youtube") return exact ?? null;
  const channel = store.getChannel(normalized);
  const channelId = channel?.info?.channelId;
  return channelId ? config.find((entry) => entryPlatform(entry) === "youtube" &&
    (entryHandle(entry) === channelId || store.getChannel(entryHandle(entry))?.info?.channelId === channelId)) ?? null : null;
}

async function persistTikTok(result, meta = {}) {
  const history = await tt.loadHistory();
  const { ch, safeName } = tt.mergeIntoHistory(history, result);
  if (result.profile.avatar?.startsWith("http")) {
    const remote = result.profile.avatar;
    ch.info.avatar = (await tt.cacheAvatar(remote, safeName)) ?? remote;
    ch.info.avatarRemote = remote;
  }
  for (const key of ["alias", "group", "tags", "owner"]) {
    if (meta[key] != null) ch.info[key] = meta[key];
  }
  await tt.saveHistory(history);
}

function canManage(user, entry) {
  return user.role === "admin" ||
    (entry.owner && entry.owner === user.user);
}

function filterJobsForUser(user, jobs, config) {
  if (user.role === "admin") return jobs;
  return jobs.filter((job) => {
    const entry = resolveEntry("youtube", job.handle, config);
    return entry && canManage(user, entry);
  });
}

function triggerRunJobs() {
  void runJobs({ root: ROOT, publish: true }).catch((error) => console.error("[runner]", error));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // 健康检查
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

    // 静态资源
    if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res, url.pathname);

    // 本地 admin CLI  transport（DASH_TOKEN）仅用于非暴露数据的运维命令，不作为普通管理权限
    const localAdmin = isLocalAdmin(req);

    // auth 代理
    if (url.pathname.startsWith("/api/auth/")) {
      const workerPath = url.pathname.replace("/api", "");
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
      // login 不需要 token；其它需要
      const token = workerPath === "/auth/login" ? "" : getBearer(req);
      const { ok, status, body: wb } = await relayAuth(req.method, workerPath, body, token || undefined);
      return sendJson(res, status, wb);
    }

    const token = getBearer(req);
    const user = await validateSession(req);
    if (!user && !localAdmin) return sendJson(res, 401, { error: "unauthorized" });
    const actingUser = user ?? { user: "admin", role: "admin", channels: [] };
    if (actingUser.mustChangePassword) {
      return sendJson(res, 403, { error: "请先更换曾公开的旧密码", passwordChangeRequired: true });
    }
    // Worker/GitHub config is authoritative. DASH_TOKEN is read-only local
    // CLI transport; mutations require a revocable Worker session.
    if ((url.pathname === "/api/channels" || url.pathname === "/api/jobs") && req.method === "GET") {
      const configResponse = user ? await workerConfig(token) : { ok: true, body: { channels: await readConfig() } };
      if (!configResponse.ok) return sendJson(res, configResponse.status, configResponse.body);
      const config = configResponse.body.channels;
      if (url.pathname === "/api/channels") return sendJson(res, 200, config);
      return sendJson(res, 200, { ok: true, jobs: filterJobsForUser(actingUser, store.jobs(), config) });
    }
    if (url.pathname === "/api/" && req.method === "POST") {
      const body = await readBody(req);
      if (body?.action !== "members") return sendJson(res, 400, { error: "unknown action" });
      if (actingUser.role !== "admin") return sendJson(res, 403, { error: "仅管理员可用" });
      const response = await relayAuth("POST", "/", body, token);
      return sendJson(res, response.status, response.body);
    }

    let action;
    let body;
    if (url.pathname === "/api/channels" && req.method === "POST") action = "add";
    else if (url.pathname === "/api/channel-meta" && req.method === "POST") action = "update";
    else if (url.pathname === "/api/refresh" && req.method === "POST") action = "refresh";
    else if (url.pathname.startsWith("/api/channels/") && req.method === "DELETE") action = "delete";
    else return sendJson(res, 404, { error: "not found" });
    if (!user) return sendJson(res, 401, { error: "请使用 Worker 会话管理频道" });
    if (action === "delete") {
      let segments;
      try { segments = decodeURIComponent(url.pathname.slice("/api/channels/".length)).split("/"); }
      catch { return sendJson(res, 400, { error: "无效频道路径" }); }
      if (segments.length !== 2) return sendJson(res, 400, { error: "无效频道路径" });
      body = { platform: segments[0], handle: segments[1] };
    } else {
      body = await readBody(req);
      if (!body) return sendJson(res, 413, { error: "请求体过大（上限 1MB）" });
    }
    if (!["youtube", "tiktok"].includes(body.platform ?? "youtube")) return sendJson(res, 400, { error: "未知平台" });
    const platform = body.platform ?? "youtube";
    const normalized = normalizeHandle(platform, body.handle);
    if (!normalized) return sendJson(res, 400, { error: "请输入有效的账号 handle、主页链接或频道 ID" });

    const result = await serializeMutation(async () => {
      const latestResponse = await workerConfig(token);
      if (!latestResponse.ok) return { status: latestResponse.status, body: latestResponse.body };
      const before = latestResponse.body.channels;
      const existing = resolveEntry(platform, normalized, before);
      if (action !== "add" && !existing) return { status: 404, body: { error: `${platform}:${normalized} 不在跟踪列表中` } };
      if (existing && action !== "add" && !canManage(actingUser, existing)) {
        return { status: 403, body: { error: "无权管理该频道" } };
      }
      const handle = existing ? entryHandle(existing) : normalized;
      if (action === "refresh" && platform === "tiktok") {
        const snapshot = await tt.syncChannel(existing);
        await persistTikTok(snapshot, existing);
        return { status: 200, body: { ok: true } };
      }
      const payload = {
        action, platform, handle,
        ...(action === "add" ? { all: !!body.all, owner: actingUser.user } : {}),
        ...(["add", "update"].includes(action) ? {
          alias: typeof body.alias === "string" ? body.alias.trim().slice(0, 50) : "",
          group: typeof body.group === "string" ? body.group.trim().slice(0, 30) : "",
          tags: Array.isArray(body.tags) ? [...new Set(body.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 10) : [],
        } : {}),
      };
      const response = await relayAuth("POST", "/", payload, token);
      if (!response.ok) return { status: response.status, body: response.body };
      const authoritative = response.body.channels;
      if (!Array.isArray(authoritative)) throw new Error("Worker did not return channel configuration");
      await writeConfigAtomic(authoritative);
      store.reconcileConfig(authoritative);
      const updated = resolveEntry(platform, response.body.job?.handle ?? handle, authoritative);

      if (action === "add" && platform === "youtube") {
        if (!updated) throw new Error("Worker added channel absent from returned configuration");
        const job = store.enqueue(entryHandle(updated), "initial", updated);
        triggerRunJobs();
        return { status: 202, body: { ok: true, job } };
      }
      if (action === "refresh" && platform === "youtube") {
        if (!updated) throw new Error("Worker refreshed channel absent from returned configuration");
        const job = store.enqueue(entryHandle(updated), "refresh", updated);
        triggerRunJobs();
        return { status: 202, body: { ok: true, job } };
      }
      if (platform === "tiktok" && action === "delete") {
        const history = await tt.loadHistory();
        delete history.channels[handle];
        await tt.saveHistory(history);
      } else if (platform === "tiktok" && action === "update") {
        const history = await tt.loadHistory();
        if (history.channels[handle]) {
          const info = history.channels[handle].info ?? {};
          for (const key of ["alias", "group", "tags"]) {
            if (payload[key]?.length) info[key] = payload[key];
            else delete info[key];
          }
          history.channels[handle].info = info;
          await tt.saveHistory(history);
        }
      } else if (platform === "tiktok" && ["add", "refresh"].includes(action)) {
        const item = updated ?? { platform, handle, ...payload };
        const snapshot = await tt.syncChannel(item);
        await persistTikTok(snapshot, item);
      }
      if (platform === "youtube") triggerRunJobs();
      return { status: 200, body: {
        ok: true,
        ...(action === "update" ? { alias: updated?.alias ?? "", group: updated?.group ?? "", tags: updated?.tags ?? [] } : {}),
      } };
    });
    return sendJson(res, result.status, result.body);
  } catch (e) {
    console.error("[error]", e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`看板服务已启动: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/${LOOPBACK.has(HOST) ? "（仅本机可访问）" : "（DASH_TOKEN 运维只读；管理需 Worker 会话）"}`);
  console.log("API: POST /api/auth/login | GET /api/auth/session | POST /api/auth/logout | POST /api/auth/password");
  console.log("     POST /api/channels | DELETE /api/channels/{platform}/{handle} | POST /api/refresh | GET /api/jobs");
});

process.on("SIGINT", () => { store.close(); process.exit(0); });
process.on("SIGTERM", () => { store.close(); process.exit(0); });
