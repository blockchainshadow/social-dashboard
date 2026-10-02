#!/usr/bin/env node
// YouTube 频道公开数据采集（零依赖，需 Node >= 18）
// CLI 用法: node scripts/fetch-youtube.mjs
// 也可作为模块被 server.mjs 引用: import { syncChannel } from "..."

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { reserve, markBlocked, QuotaExceeded } from "./youtube-quota.mjs";

const CONFIG_FILE = path.resolve("channels.json");
const DATA_FILE = path.resolve("data/youtube-history.json");
const AVATAR_DIR = path.resolve("web/avatars");
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 500);
const RECENT_EXACT = Number(process.env.RECENT_EXACT ?? 30); // 前 N 个视频抓精确数据，其余用列表近似值

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e0 = (e) => String(e?.message ?? e).slice(0, 120);

// ---------- HTTP ----------
async function getText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: "SOCS=CAI",
        },
        redirect: "follow",
      });
      if (res.ok) return res.text();
      if (res.status === 404) throw new Error(`404 ${url}`);
      lastErr = new Error(`${res.status} ${res.statusText} for ${url}`);
    } catch (e) {
      lastErr = e;
    }
    const wait = 2000 * 2 ** i + Math.random() * 1000;
    if (i < tries - 1) {
      console.warn(`  ! 请求失败(${i + 1}/${tries})，${Math.round(wait / 1000)}s 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function postJson(url, body, headers = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA, ...headers },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      lastErr = new Error(`${res.status} ${res.statusText} for ${url}`);
    } catch (e) {
      lastErr = e;
    }
    const wait = 2000 * 2 ** i;
    if (i < tries - 1) await sleep(wait);
  }
  throw lastErr;
}

// ---------- JSON 提取 ----------
function extractBalanced(html, marker) {
  const i = html.indexOf(marker);
  if (i === -1) return null;
  const start = html.indexOf("{", i);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
}

export function extractJsonAfter(html, marker) {
  const raw = extractBalanced(html, marker);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function collect(node, key, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
  }
  return out;
}

// ---------- 解析工具 ----------
function parseAbbrev(text) {
  const m = String(text).match(/([\d.,]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

function parseIntNum(text) {
  const m = String(text ?? "").replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
}

function toISODate(text) {
  const t = Date.parse(String(text));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function parseKeywords(raw) {
  if (!raw) return [];
  const parts = String(raw).match(/"[^"]*"|\S+/g) ?? [];
  return [...new Set(parts.map((p) => p.replaceAll('"', "").trim()).filter(Boolean))].slice(0, 30);
}

function channelUrlBase(handleOrId) {
  return handleOrId.startsWith("UC")
    ? `https://www.youtube.com/channel/${handleOrId}`
    : `https://www.youtube.com/${handleOrId}`;
}

// 统一的视频条目解析（兼容新旧渲染器）
function parseVideoRenderer(v) {
  return v.videoId
    ? { id: v.videoId, title: v.title?.runs?.[0]?.text ?? v.title?.simpleText ?? "", viewsText: v.viewCountText?.simpleText ?? null, shorts: false }
    : null;
}
function parseLockup(l) {
  if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  if (!l.contentId || !meta) return null;
  const parts =
    meta.metadata?.contentMetadataViewModel?.metadataRows?.flatMap?.((r) => r.metadataParts ?? []) ?? [];
  const viewsText = parts.map((p) => p.text?.content).find((t) => /views?$/i.test(t ?? "")) ?? null;
  return { id: l.contentId, title: meta.title?.content ?? "", viewsText, shorts: false };
}
function parseShortsLockup(s) {
  const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
  if (!id) return null;
  const meta = s.overlayMetadataViewModel;
  let title = meta?.primaryText?.content ?? null;
  let viewsText = meta?.secondaryText?.content ?? null;
  if (!title) {
    const base = (s.accessibilityText ?? "").replace(/\s*-\s*play\s+Short\s*$/i, "");
    const c = base.lastIndexOf(",");
    if (c !== -1 && /view/i.test(base.slice(c))) {
      title = base.slice(0, c).trim();
      viewsText = base.slice(c + 1).trim();
    } else {
      title = base.trim() || null;
    }
  }
  return { id, title: title ?? "", viewsText, shorts: true };
}
function extractVideos(json) {
  const out = new Map();
  for (const [key, fn] of [
    ["videoRenderer", parseVideoRenderer],
    ["gridVideoRenderer", parseVideoRenderer],
    ["lockupViewModel", parseLockup],
    ["shortsLockupViewModel", parseShortsLockup],
  ]) {
    for (const node of collect(json, key)) {
      const v = fn(node);
      if (v && !out.has(v.id)) out.set(v.id, v);
    }
  }
  return [...out.values()];
}
function extractContinuationToken(json) {
  for (const c of collect(json, "continuationItemRenderer")) {
    const t =
      c.continuationEndpoint?.continuationCommand?.token ??
      c.button?.buttonRenderer?.command?.continuationCommand?.token;
    if (t) return t;
  }
  return null;
}

// ---------- innertube browse 翻页（拉取全部视频） ----------
const TAB_PARAMS = {
  videos: "EgZ2aWRlb3PyBgQKAjoA",
  shorts: "EgZzaG9ydHPyBgUKA5oBAA==",
};

async function browseAll(channelId, kind, innertube, maxPages = 400) {
  const seen = new Map();
  let token = null;
  for (let page = 0; page < maxPages; page++) {
    const body = token
      ? { context: innertube.context, continuation: token }
      : { context: innertube.context, browseId: channelId, params: TAB_PARAMS[kind] };
    let json;
    try {
      json = await postJson(
        `https://www.youtube.com/youtubei/v1/browse?key=${innertube.apiKey}&prettyPrint=false`,
        body,
        {
          "X-Youtube-Client-Name": "1",
          "X-Youtube-Client-Version": innertube.context?.client?.clientVersion ?? "2.20240801.00.00",
        }
      );
    } catch (e) {
      console.warn(`  ! ${kind} 翻页第 ${page + 1} 页失败: ${e0(e)}`);
      break;
    }
    for (const v of extractVideos(json)) {
      if (!seen.has(v.id)) seen.set(v.id, v);
    }
    token = extractContinuationToken(json);
    process.stdout.write(`    ${kind}: 已获取 ${seen.size} 个 (第${page + 1}页)\r`);
    if (!token) break;
    await sleep(350);
  }
  process.stdout.write("\n");
  return [...seen.entries()].map(([id, v]) => [id, v]);
}

// ---------- 频道 about 页 ----------
async function fetchAbout(base) {
  const html = await getText(`${base}/about?hl=en&gl=US`);
  let vm = null;
  try {
    vm = JSON.parse(extractBalanced(html, '"aboutChannelViewModel":'));
  } catch {}
  const joinedRaw =
    typeof vm?.joinedDateText === "string" ? vm.joinedDateText : vm?.joinedDateText?.content;
  const links = Array.isArray(vm?.links)
    ? vm.links
        .map((l) => {
          const m = l?.channelExternalLinkViewModel;
          return m ? { title: m.title?.content ?? null, url: m.link?.content ?? null } : null;
        })
        .filter(Boolean)
    : [];
  return {
    totalViews: parseIntNum(vm?.viewCountText),
    videoCountTotal: parseIntNum(vm?.videoCountText),
    joinedDate: joinedRaw ? toISODate(joinedRaw.replace(/^Joined\s+/i, "")) : null,
    country: typeof vm?.country === "string" ? vm.country : null,
    links,
  };
}

// ---------- 频道 /videos 页：档案 + 订阅数 + 首屏视频 + innertube 凭据 ----------
async function fetchChannelPage(base) {
  const html = await getText(`${base}/videos?hl=en&gl=US`);
  const data = extractJsonAfter(html, "ytInitialData");
  if (!data) throw new Error("未能解析 ytInitialData（页面可能被风控或改版）");

  const meta = data?.metadata?.channelMetadataRenderer ?? {};
  const profile = {
    name: meta.title ?? base,
    channelId: meta.externalId ?? null,
    canonicalUrl: meta.vanityChannelUrl ?? meta.channelUrl ?? null,
    description: meta.description ?? null,
    keywords: parseKeywords(meta.keywords),
    rssUrl: meta.rssUrl ?? null,
    avatar: meta.avatar?.thumbnails?.at(-1)?.url ?? null,
    isFamilySafe: meta.isFamilySafe ?? null,
    availableCountryCodes: meta.availableCountryCodes ?? null,
  };

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const context = extractJsonAfter(html, '"INNERTUBE_CONTEXT":') ?? {
    client: { clientName: "WEB", clientVersion: "2.20240801.00.00", hl: "en", gl: "US" },
  };
  const innertube = apiKey ? { apiKey, context } : null;

  const subMatch = html.match(/"(?:simpleText|content)":"([^"]{0,30}?subscribers?)"/i);
  const subscribers = subMatch ? parseAbbrev(subMatch[1]) : null;

  const seen = new Map();
  const add = (v) => v && !seen.has(v.id) && seen.set(v.id, v);
  for (const node of collect(data, "videoRenderer")) add(parseVideoRenderer(node));
  for (const node of collect(data, "lockupViewModel")) add(parseLockup(node));

  return { profile, subscribers, videos: [...seen.entries()], innertube };
}

// ---------- watch 页精确数据 ----------
async function fetchWatch(videoId) {
  let html = await getText(
    `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999`
  );

  // 反爬拦截（LOGIN_REQUIRED）时重试一次，通常能轮换通过
  if (/"status":"LOGIN_REQUIRED"/.test(html)) {
    await sleep(1500);
    html = await getText(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999`
    );
  }

  const pr = extractJsonAfter(html, "ytInitialPlayerResponse");
  const viewsStr =
    pr?.videoDetails?.viewCount ?? html.match(/"simpleText":"([\d,]+) views"/)?.[1];
  const likes = html.match(/along with ([\d,]+) other people/)?.[1];
  const publishedRaw = html.match(/"publishDate":\{"simpleText":"([^"]+)"/)?.[1];
  const lenSec = pr?.videoDetails?.lengthSeconds;

  // 会员视频：页面明确提示需要付费/仅会员可见
  const membersOnly = /This video requires payment|available to this channel's members/i.test(html);

  let descriptionChars = null;
  const di = html.indexOf('"attributedDescription"');
  if (di !== -1) {
    const m = html.slice(di, di + 800).match(/"content":"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try {
        descriptionChars = JSON.parse(`"${m[1]}"`).length;
      } catch {}
    }
  }

  return {
    views: viewsStr ? parseInt(viewsStr.replace(/,/g, ""), 10) : null,
    likes: likes ? parseInt(likes.replace(/,/g, ""), 10) : null,
    published: publishedRaw ? toISODate(publishedRaw) : null,
    durationSec: lenSec != null ? parseInt(lenSec, 10) : null,
    descriptionChars,
    membersOnly,
  };
}

// ---------- RSS：最近15个视频的精确发布时间 ----------
async function fetchRss(rssUrl) {
  const xml = await getText(rssUrl);
  const out = {};
  for (const entry of xml.split("<entry>").slice(1)) {
    const vid = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!vid) continue;
    out[vid] = {
      publishedFull: entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null,
      descriptionChars:
        entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.length ?? undefined,
    };
  }
  return out;
}

// ---------- 头像本地化（带 SSRF/磁盘防护：仅 http(s)、15s 超时、拒收文本、限 3MB） ----------
export async function cacheAvatar(url, name) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (ct.startsWith("text/") || ct.includes("html")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 3_000_000) return null;
    await mkdir(AVATAR_DIR, { recursive: true });
    await writeFile(path.join(AVATAR_DIR, `${name}.jpg`), buf);
    return `avatars/${name}.jpg`;
  } catch {
    return null;
  }
}

// ---------- YouTube Data API v3（配额内优先，1 call = 1 单位） ----------
// Key 来源：$YOUTUBE_API_KEY 或 ~/.config/social-dashboard/youtube-api-key
// 配额由 youtube-quota.mjs 管理：发送前原子预留 1 单位，失败也计数，
// PT 午夜重置，公开快照写入 data/youtube-api-usage.json。
async function loadYouTubeKey() {
  if (process.env.YOUTUBE_API_KEY?.trim()) return process.env.YOUTUBE_API_KEY.trim();
  try {
    const t = (await readFile(path.join(os.homedir(), ".config", "social-dashboard", "youtube-api-key"), "utf8")).trim();
    if (t) return t;
  } catch {}
  return "";
}

class ApiFatal extends Error {}

async function ytApi(key, endpoint, params) {
  // 发送前跨进程原子预留 1 单位；任何预留/写入错误都 fail closed 走页面抓取。
  let quota;
  try {
    quota = await reserve({ cost: 1 });
  } catch (e) {
    throw new QuotaExceeded(`配额预留失败，fail closed: ${e0(e)}`);
  }
  if (!quota.ok) {
    throw new QuotaExceeded(`配额已用尽（${quota.used}/${quota.limit}），明早自动恢复`);
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = j?.error?.errors?.[0]?.reason ?? "";
    const msg = `YT API ${endpoint} ${res.status}: ${(j?.error?.message ?? "").slice(0, 120)}`;
    if (res.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(reason + JSON.stringify(j))) {
      await markBlocked().catch(() => {});
      throw new QuotaExceeded(`YouTube API 配额耗尽: ${reason}`);
    }
    if ([400, 401, 403].includes(res.status)) throw new ApiFatal(msg); // key/权限问题，回退抓取也救不了
    const e = new Error(msg);
    e.apiRetryable = true;
    throw e;
  }
  return j;
}

function parseISODuration(s) {
  const m = String(s ?? "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
}

// API 路径先取最近 50 条；全量枚举与 API 不提供的字段由频道页、Shorts 页和 RSS 补齐。
function apiVideo(vd, publishedFallback = null) {
  const vs = vd.statistics ?? {};
  return {
    title: vd.snippet?.title ?? "",
    views: vs.viewCount != null ? parseInt(vs.viewCount, 10) : null,
    likes: vs.likeCount != null ? parseInt(vs.likeCount, 10) : null,
    published: toISODate(vd.snippet?.publishedAt),
    publishedFull: vd.snippet?.publishedAt ?? publishedFallback,
    durationSec: parseISODuration(vd.contentDetails?.duration),
    descriptionChars: vd.snippet?.description?.length ?? null,
    shorts: false,
    membersOnly: false,
    approx: false,
  };
}

async function fetchApiVideos(key, ids, out, publishedById = {}) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await ytApi(key, "videos", { part: "snippet,statistics,contentDetails", id: chunk.join(",") });
    for (const vd of res.items ?? []) out[vd.id] = apiVideo(vd, publishedById[vd.id] ?? null);
  }
}
export async function syncChannelViaAPI(item) {
  const key = await loadYouTubeKey();
  if (!key) throw new Error("未配置 YOUTUBE_API_KEY");
  const handle = typeof item === "string" ? item : item.handle;
  console.log(`\n== ${handle}（API） ==`);
  const chRes = /^UC[\w-]{20,}$/.test(handle)
    ? await ytApi(key, "channels", { part: "snippet,statistics,contentDetails", id: handle })
    : await ytApi(key, "channels", { part: "snippet,statistics,contentDetails", forHandle: handle });
  const c = chRes.items?.[0];
  if (!c) {
    const e = new Error(`API 未找到频道 ${handle}`);
    e.apiRetryable = true; // handle 可能改名，值得回退抓取试一次
    throw e;
  }
  const sn = c.snippet ?? {};
  const st = c.statistics ?? {};
  const uploadsId = c.contentDetails?.relatedPlaylists?.uploads;

  const videosOut = {};
  if (uploadsId) {
    const pl = await ytApi(key, "playlistItems", { part: "snippet,contentDetails", playlistId: uploadsId, maxResults: "50" });
    const items = pl.items ?? [];
    const pubById = {};
    for (const it of items) {
      const id = it?.contentDetails?.videoId;
      if (id && !pubById[id]) pubById[id] = it?.contentDetails?.videoPublishedAt ?? it?.snippet?.publishedAt ?? null;
    }
    const ids = Object.keys(pubById);
    await fetchApiVideos(key, ids, videosOut, pubById);
  }

  const thumbs = sn.thumbnails ?? {};
  const avatar = [thumbs.maxres, thumbs.standard, thumbs.high, thumbs.medium, thumbs.default]
    .map((t) => t?.url).find(Boolean) ?? null;
  const profile = {
    name: sn.title ?? handle,
    channelId: c.id ?? null,
    canonicalUrl: channelUrlBase(handle),
    description: sn.description ?? null,
    keywords: [],
    rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${c.id ?? ""}`,
    avatar,
    isFamilySafe: null,
    availableCountryCodes: null,
  };
  const subscribers = st.subscriberCount != null ? parseInt(st.subscriberCount, 10) : null;
  const about = {
    totalViews: st.viewCount != null ? parseInt(st.viewCount, 10) : null,
    videoCountTotal: st.videoCount != null ? parseInt(st.videoCount, 10) : null,
    joinedDate: toISODate(sn.publishedAt),
    country: sn.country ?? null,
    links: [],
  };
  const record = {
    date: new Date().toISOString().slice(0, 10),
    subscribers,
    channelTotalViews: about.totalViews,
    channelVideoCount: about.videoCountTotal,
    videoCountTracked: Object.keys(videosOut).length,
    videos: videosOut,
  };
  return { handle, platform: "youtube", profile, about, record, source: "youtube-api" };
}

// ---------- 同步单个频道（供 CLI 与 server 共用） ----------
export async function syncChannel(item, opts = {}) {
  const handle = typeof item === "string" ? item : item.handle;
  const key = await loadYouTubeKey();
  let apiResult = null;
  if (key) {
    try {
      apiResult = await syncChannelViaAPI(item);
    } catch (e) {
      console.warn(`  ! API 失败，改用页面抓取: ${e0(e)}`);
    }
  }
  const all = !!item.all || !!opts.all;
  const exactLimit = opts.exactLimit ?? RECENT_EXACT;
  const base = channelUrlBase(handle);

  console.log(`\n== ${handle}${all ? "（全量）" : ""} ==`);
  let page;
  try {
    page = await fetchChannelPage(base);
  } catch (e) {
    if (apiResult) {
      console.warn(`  ! 频道页不可用，仅保留 API 最近视频: ${e0(e)}`);
      return apiResult;
    }
    throw e;
  }
  const { profile: pageProfile, subscribers: pageSubscribers, videos: firstPage, innertube } = page;
  const profile = apiResult ? {
    ...pageProfile,
    name: apiResult.profile.name,
    channelId: apiResult.profile.channelId,
    description: apiResult.profile.description,
    avatar: apiResult.profile.avatar ?? pageProfile.avatar,
    rssUrl: pageProfile.rssUrl ?? apiResult.profile.rssUrl,
  } : pageProfile;
  const pageAbout = await fetchAbout(base).catch(() => ({}));
  const about = apiResult ? {
    ...pageAbout,
    totalViews: apiResult.about.totalViews,
    videoCountTotal: apiResult.about.videoCountTotal,
    joinedDate: apiResult.about.joinedDate ?? pageAbout.joinedDate,
    country: apiResult.about.country ?? pageAbout.country,
  } : pageAbout;
  const subscribers = apiResult?.record.subscribers ?? pageSubscribers;

  // 全量模式：通过 innertube 翻页补齐普通视频与 Shorts（跨标签页全局去重，
  // 否则部分频道两个标签页返回相同内容，重复项会覆盖已抓取的精确数据）
  let videoList = firstPage;
  if (all && innertube && profile.channelId) {
    const merged = new Map(firstPage);
    for (const kind of ["videos", "shorts"]) {
      for (const [id, v] of await browseAll(profile.channelId, kind, innertube)) {
        if (!merged.has(id)) merged.set(id, v);
        else if (v.shorts) merged.get(id).shorts = true;
      }
    }
    videoList = [...merged.entries()];
  }
  if (!all) {
    // 非全量时保留原 Shorts 回退逻辑（首页无普通视频则取 Shorts 首屏）
    if (firstPage.length === 0 && innertube && profile.channelId) {
      videoList = await browseAll(profile.channelId, "shorts", innertube, 2);
    }
  }

  // API 最近 50 条可能尚未出现在页面列表；全量时再批量查询页面枚举到的旧视频。
  const apiVideos = apiResult?.record.videos ?? {};
  const listed = new Set(videoList.map(([id]) => id));
  for (const id of Object.keys(apiVideos)) {
    if (!listed.has(id)) videoList.push([id, { title: apiVideos[id].title, viewsText: null, shorts: false }]);
  }
  if (apiResult) {
    const missing = videoList.map(([id]) => id).filter((id) => !apiVideos[id]);
    try {
      await fetchApiVideos(key, missing, apiVideos);
    } catch (e) {
      console.warn(`  ! API 补全中断，剩余视频改用页面数据: ${e0(e)}`);
    }
  }

  const rss = profile.rssUrl ? await fetchRss(profile.rssUrl).catch(() => ({})) : {};

  const videosOut = {};
  for (let i = 0; i < videoList.length; i++) {
    const [id, meta] = videoList[i];
    const api = apiVideos[id];
    if (api) {
      let detail = {};
      if (api.views == null || (i < exactLimit && (
        api.likes == null || api.published == null || api.durationSec == null || api.descriptionChars == null
      ))) {
        try {
          await sleep(REQUEST_DELAY_MS);
          detail = await fetchWatch(id);
        } catch (e) {
          console.warn(`  ! ${id} 页面补字段失败: ${e0(e)}`);
        }
      }
      const views = api.views ?? detail.views ?? parseAbbrev(meta.viewsText);
      videosOut[id] = {
        ...api,
        views,
        likes: api.likes ?? detail.likes ?? null,
        published: api.published ?? detail.published ?? null,
        publishedFull: api.publishedFull ?? rss[id]?.publishedFull ?? null,
        durationSec: api.durationSec ?? detail.durationSec ?? null,
        descriptionChars: api.descriptionChars ?? detail.descriptionChars ?? rss[id]?.descriptionChars ?? null,
        shorts: !!meta.shorts,
        membersOnly: !!detail.membersOnly,
        approx: api.views == null && detail.views == null && views != null,
      };
    } else if (i < exactLimit) {
      await sleep(REQUEST_DELAY_MS);
      let detail = {};
      try {
        detail = await fetchWatch(id);
      } catch (e) {
        console.warn(`  ! ${id} 详情失败，使用近似值: ${e0(e)}`);
      }
      const r = rss[id] ?? {};
      videosOut[id] = {
        title: meta.title,
        views: detail.views ?? parseAbbrev(meta.viewsText),
        likes: detail.likes ?? null,
        published: detail.published ?? null,
        publishedFull: r.publishedFull ?? null,
        durationSec: detail.durationSec ?? null,
        descriptionChars: detail.descriptionChars ?? r.descriptionChars ?? null,
        shorts: !!meta.shorts,
        membersOnly: !!detail.membersOnly,
        approx: detail.views == null,
      };
    } else {
      let views = parseAbbrev(meta.viewsText);
      let membersOnly = false;
      if (views == null) {
        // 会员/首映等无法从列表页获取播放量的视频需访问 watch 页。
        try {
          await sleep(REQUEST_DELAY_MS);
          const d = await fetchWatch(id);
          views = d.views;
          membersOnly = d.membersOnly;
        } catch {}
      }
      videosOut[id] = {
        title: meta.title,
        views,
        likes: null,
        published: null,
        publishedFull: null,
        durationSec: null,
        descriptionChars: null,
        shorts: !!meta.shorts,
        membersOnly,
        approx: true,
      };
    }
    process.stdout.write(`  · ${i + 1}/${videoList.length} ${id}\r`);
  }

  const record = {
    date: new Date().toISOString().slice(0, 10),
    subscribers,
    channelTotalViews: about.totalViews ?? null,
    channelVideoCount: about.videoCountTotal ?? null,
    videoCountTracked: Object.keys(videosOut).length,
    videos: videosOut,
  };
  return {
    handle,
    platform: "youtube",
    profile,
    about,
    record,
    source: apiResult ? "hybrid" : "youtube-page",
  };
}

// ---------- 历史合并与持久化 ----------
export async function loadHistory() {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    return { updatedAt: new Date().toISOString(), channels: {} };
  }
}

export async function saveHistory(history) {
  history.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(history, null, 2));
}

export async function readConfig() {
  const channels = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  if (!Array.isArray(channels)) throw new Error("channels.json 格式应为数组");
  return channels;
}

export async function writeConfig(channels) {
  await writeFile(CONFIG_FILE, JSON.stringify(channels, null, 2));
}

// 页面/API 不完整时保留旧视频，但不把旧指标误认为本次采集结果。
export function preserveTrackedVideos(record, previous) {
  if (!previous) return;
  for (const [id, video] of Object.entries(previous.videos ?? {})) {
    if (!Object.hasOwn(record.videos, id)) {
      record.videos[id] = { ...video, staleAt: video.staleAt ?? previous.date };
    }
  }
  record.videoCountTracked = Object.keys(record.videos).length;
}

// 合并一条频道记录到 history 并返回该频道对象
export function mergeIntoHistory(history, { handle, profile, about, record }) {
  const ch = (history.channels[handle] ??= { info: {}, records: [] });
  const previous = ch.records.findLast((r) => r.date <= record.date);
  preserveTrackedVideos(record, previous);
  ch.records = ch.records.filter((r) => r.date !== record.date);
  ch.records.push(record);
  ch.records.sort((a, b) => a.date.localeCompare(b.date));
  const safeName = handle.replace(/[^\w-]/g, "") || "channel";
  const info = {
    ...profile,
    keywords: profile.keywords?.length ? profile.keywords : (ch.info?.keywords ?? []),
    country: about.country ?? ch.info?.country ?? null,
    joinedDate: about.joinedDate ?? ch.info?.joinedDate ?? null,
    links: about.links?.length ? about.links : (ch.info?.links ?? []),
    avatarRemote: ch.info?.avatarRemote ?? null,
  };
  ch.info = info;
  return { ch, safeName };
}

// ---------- CLI 主流程 ----------
async function main() {
  const all = await readConfig();
  // 只处理 youtube 平台的账号（tiktok 由 fetch-tiktok.mjs 负责）
  const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const only = onlyArg ? onlyArg.split(",").map((x) => (x.trim().startsWith("@") ? x.trim() : "@" + x.trim())) : null;
  const channels = all
    .filter((c) => (typeof c === "string" ? "youtube" : c.platform ?? "youtube") === "youtube")
    .filter((c) => !only || only.includes(typeof c === "string" ? c : c.handle));
  if (!channels.length) {
    console.log("channels.json 中没有 platform=youtube 的账号");
    return;
  }

  const history = await loadHistory();
  for (const item of channels) {
    try {
      const result = await syncChannel(item);
      const { ch, safeName } = mergeIntoHistory(history, result);
      if (result.profile.avatar?.startsWith("http")) {
        const remote = result.profile.avatar;
        ch.info.avatar = (await cacheAvatar(remote, safeName)) ?? remote;
        ch.info.avatarRemote = remote;
      }
      const approxN = Object.values(result.record.videos).filter((v) => v.approx).length;
      console.log(
        `\n  ${result.profile.name}: 订阅=${result.record.subscribers} 总播放=${result.record.channelTotalViews} ` +
          `视频=${result.record.videoCountTracked}${approxN ? `（其中 ${approxN} 个为近似值）` : ""}`
      );
    } catch (e) {
      console.error(`  ✗ 抓取失败: ${e0(e)}`);
      process.exitCode = 1;
    }
  }
  await saveHistory(history);
  console.log(`\n已写入 ${path.relative(process.cwd(), DATA_FILE)}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
