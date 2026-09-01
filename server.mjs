#!/usr/bin/env node
// 本地看板服务：静态托管 + 多平台账号管理 API（零依赖）
// 用法: node server.mjs  [端口默认 8000]

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as yt from "./scripts/fetch-youtube.mjs";
import * as tt from "./scripts/fetch-tiktok.mjs";

const MODS = { youtube: yt, tiktok: tt };
const ROOT = process.cwd();
const CONFIG_FILE = path.resolve("channels.json");
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8000);

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
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/web/index.html";
  let filePath = path.resolve(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) return sendJson(res, 403, { error: "forbidden" });
  try {
    let buf;
    try {
      buf = await readFile(filePath);
    } catch (e) {
      if (e.code === "EISDIR") {
        filePath = path.join(filePath, "index.html");
        buf = await readFile(filePath);
      } else throw e;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // 数据与页面不缓存（增删后需立即生效），仅静态资源缓存
      "Cache-Control": ext === ".json" || ext === ".html" ? "no-store" : "public, max-age=60",
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: `not found: ${rel}` });
  }
}

async function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function normalizeHandle(platform, input) {
  let h = String(input ?? "").trim();
  if (!h) return null;
  h = h.split("/").filter(Boolean).pop();
  if (platform === "tiktok") return tt.normalizeTikTokHandle(h);
  if (/^UC[\w-]{20,}$/.test(h)) return h;
  if (!h.startsWith("@")) h = "@" + h;
  return /^@[\w.-]{3,40}$/.test(h) ? h : null;
}

const entryHandle = (c) => (typeof c === "string" ? c : c.handle);
const entryPlatform = (c) => (typeof c === "string" ? "youtube" : c.platform ?? "youtube");

// 抓取结果落库（平台无关）；meta 携带备注名/分组
async function persistChannel(result, meta = {}) {
  const mod = MODS[result.platform];
  const history = await mod.loadHistory();
  const { ch, safeName } = mod.mergeIntoHistory(history, result);
  if (result.profile.avatar?.startsWith("http")) {
    const remote = result.profile.avatar;
    ch.info.avatar = (await mod.cacheAvatar(remote, safeName)) ?? remote;
    ch.info.avatarRemote = remote;
  }
  if (meta.alias) ch.info.alias = String(meta.alias).slice(0, 50);
  if (meta.group) ch.info.group = String(meta.group).slice(0, 30);
  if (Array.isArray(meta.tags) && meta.tags.length) ch.info.tags = meta.tags;
  await mod.saveHistory(history);
  const approxN = Object.values(result.record.videos ?? {}).filter((v) => v.approx).length;
  return {
    ok: true,
    platform: result.platform,
    name: result.profile.name,
    date: result.record.date,
    videos: result.record.videoCountTracked ?? 0,
    approx: approxN,
    followers: result.record.followers ?? null,
    subscribers: result.record.subscribers ?? null,
    source: result.source ?? "youtube",
  };
}

function cleanMeta(body) {
  const meta = {};
  if (typeof body.alias === "string" && body.alias.trim()) meta.alias = body.alias.trim();
  if (typeof body.group === "string" && body.group.trim()) meta.group = body.group.trim();
  if (Array.isArray(body.tags)) {
    const tags = [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
    if (tags.length) meta.tags = tags;
  }
  return meta;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

    if (url.pathname === "/api/channels" && req.method === "GET") {
      return send(res, 200, await readFile(CONFIG_FILE, "utf8"));
    }

    // 添加账号 {handle, platform, all}
    if (url.pathname === "/api/channels" && req.method === "POST") {
      const body = await readBody(req);
      const platform = body.platform === "tiktok" ? "tiktok" : "youtube";
      const handle = normalizeHandle(platform, body.handle);
      if (!handle) return sendJson(res, 400, { error: "请输入有效的账号 handle、主页链接或频道 ID" });

      const config = await readFile(CONFIG_FILE, "utf8").then(JSON.parse);
      if (config.some((c) => entryPlatform(c) === platform && entryHandle(c) === handle))
        return sendJson(res, 409, { error: `${platform}:${handle} 已在跟踪列表中` });

      console.log(`[api] 添加 ${platform} ${handle}${body.all ? "（全量）" : ""} …`);
      const meta = cleanMeta(body);
      const item = { handle, ...(body.all ? { all: true } : {}) };
      const result = await MODS[platform].syncChannel(item); // 先验证再入列
      const summary = await persistChannel(result, meta);

      config.push({ platform, handle, ...(body.all ? { all: true } : {}), ...meta });
      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      return sendJson(res, 200, summary);
    }

    // 更新备注名/分组 {handle, platform, alias, group}（留空即清除）
    if (url.pathname === "/api/channel-meta" && req.method === "POST") {
      const body = await readBody(req);
      const platform = body.platform === "tiktok" ? "tiktok" : "youtube";
      const handle = normalizeHandle(platform, body.handle);
      const config = await readFile(CONFIG_FILE, "utf8").then(JSON.parse);
      const entry = config.find((c) => entryPlatform(c) === platform && entryHandle(c) === handle);
      if (!entry) return sendJson(res, 404, { error: `${platform}:${handle} 不在跟踪列表中` });

      if (typeof body.alias === "string" && body.alias.trim()) entry.alias = body.alias.trim().slice(0, 50);
      else delete entry.alias;
      if (typeof body.group === "string" && body.group.trim()) entry.group = body.group.trim().slice(0, 30);
      else delete entry.group;
      if (Array.isArray(body.tags)) {
        const tags = [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
        if (tags.length) entry.tags = tags;
        else delete entry.tags;
      }
      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));

      const mod = MODS[platform];
      const history = await mod.loadHistory();
      if (history.channels[handle]) {
        const info = history.channels[handle].info ?? {};
        if (entry.alias) info.alias = entry.alias;
        else delete info.alias;
        if (entry.group) info.group = entry.group;
        else delete info.group;
        if (entry.tags) info.tags = entry.tags;
        else delete info.tags;
        history.channels[handle].info = info;
        await mod.saveHistory(history);
      }
      console.log(`[api] 更新备注 ${platform} ${handle}: alias=${entry.alias ?? "-"} group=${entry.group ?? "-"} tags=${(entry.tags ?? []).join(",") || "-"}`);
      return sendJson(res, 200, { ok: true, alias: entry.alias ?? "", group: entry.group ?? "", tags: entry.tags ?? [] });
    }

    // 删除 /api/channels/{platform}/{handle}
    if (url.pathname?.startsWith("/api/channels/") && req.method === "DELETE") {
      const parts = decodeURIComponent(url.pathname.slice("/api/channels/".length)).split("/");
      const platform = parts.length === 2 ? parts[0] : "youtube";
      const handle = parts.length === 2 ? parts[1] : parts[0];
      if (!MODS[platform]) return sendJson(res, 400, { error: `未知平台 ${platform}` });

      const config = await readFile(CONFIG_FILE, "utf8").then(JSON.parse);
      const next = config.filter(
        (c) => !(entryPlatform(c) === platform && entryHandle(c) === handle)
      );
      if (next.length === config.length)
        return sendJson(res, 404, { error: `${platform}:${handle} 不在列表中` });
      await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2));

      const mod = MODS[platform];
      const history = await mod.loadHistory();
      delete history.channels[handle];
      await mod.saveHistory(history);
      console.log(`[api] 删除 ${platform} ${handle}`);
      return sendJson(res, 200, { ok: true });
    }

    // 刷新单个账号 {handle, platform}
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const body = await readBody(req);
      const platform = body.platform === "tiktok" ? "tiktok" : "youtube";
      const handle = normalizeHandle(platform, body.handle);
      const config = await readFile(CONFIG_FILE, "utf8").then(JSON.parse);
      const entry = config.find(
        (c) => entryPlatform(c) === platform && entryHandle(c) === handle
      );
      if (!entry) return sendJson(res, 404, { error: `${platform}:${handle} 不在跟踪列表中` });

      console.log(`[api] 刷新 ${platform} ${handle} …`);
      const result = await MODS[platform].syncChannel(entry);
      return sendJson(res, 200, await persistChannel(result, entry));
    }

    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error("[error]", e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.log(`看板服务已启动: http://localhost:${PORT}/web/`);
  console.log("API: POST /api/channels {handle, platform, all} | DELETE /api/channels/{platform}/{handle} | POST /api/refresh");
});
