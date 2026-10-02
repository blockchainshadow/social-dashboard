#!/usr/bin/env node
// YouTube 频道公开数据采集（API 优先，配额内运行）
// 本模块不再直接读写 JSON；数据通过 dashboard-store.mjs 持久化。
// 导出：syncChannelInitial / syncChannelFull / syncChannelRefresh / syncChannel / cacheAvatar

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { reserve, markBlocked, QuotaExceeded } from "./youtube-quota.mjs";
import { normalizeYouTubeHandle } from "../assets/channel-input.mjs";

const CONFIG_FILE = path.resolve("channels.json");
const AVATAR_DIR = path.resolve("web/avatars");
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 500);
const RECENT_EXACT = Number(process.env.RECENT_EXACT ?? 30);
const REFRESH_UPLOAD_PAGES = Number(process.env.YT_REFRESH_UPLOAD_PAGES ?? 2);

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

async function fetchWatch(videoId) {
  let html = await getText(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999`);
  if (/"status":"LOGIN_REQUIRED"/.test(html)) {
    await sleep(1500);
    html = await getText(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999`);
  }
  const pr = extractJsonAfter(html, "ytInitialPlayerResponse");
  const viewsStr = pr?.videoDetails?.viewCount ?? html.match(/"simpleText":"([\d,]+) views"/)?.[1];
  const likes = html.match(/along with ([\d,]+) other people/)?.[1];
  const publishedRaw = html.match(/"publishDate":\{"simpleText":"([^"]+)"/)?.[1];
  const lenSec = pr?.videoDetails?.lengthSeconds;
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
    const extension = ct === "image/png" ? "png" : ct === "image/webp" ? "webp"
      : ct === "image/jpeg" || ct === "image/jpg" ? "jpg" : null;
    if (!extension) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 3_000_000) return null;
    await mkdir(AVATAR_DIR, { recursive: true });
    await writeFile(path.join(AVATAR_DIR, `${name}.${extension}`), buf);
    return `avatars/${name}.${extension}`;
  } catch {
    return null;
  }
}

// ---------- YouTube Data API v3 ----------
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
    if ([400, 401, 403].includes(res.status)) throw new ApiFatal(msg);
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

export function apiVideo(vd, publishedFallback = null) {
  const vs = vd.statistics ?? {};
  return {
    title: vd.snippet?.title ?? "",
    views: vs.viewCount != null ? parseInt(vs.viewCount, 10) : null,
    likes: vs.likeCount != null ? parseInt(vs.likeCount, 10) : null,
    comments: vs.commentCount != null ? parseInt(vs.commentCount, 10) : null,
    published: toISODate(vd.snippet?.publishedAt),
    publishedFull: vd.snippet?.publishedAt ?? publishedFallback,
    durationSec: parseISODuration(vd.contentDetails?.duration),
    descriptionChars: vd.snippet?.description?.length ?? null,
    shorts: null,
    membersOnly: null,
    approx: false,
  };
}

async function fetchApiVideos(key, ids, out, publishedById = {}, onProgress = () => {}) {
  let fetched = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await ytApi(key, "videos", { part: "snippet,statistics,contentDetails", id: chunk.join(",") });
    for (const vd of res.items ?? []) {
      out[vd.id] = apiVideo(vd, publishedById[vd.id] ?? null);
      fetched++;
    }
    onProgress({ phase: "videos", fetched, requested: ids.length });
  }
}

async function fetchPlaylistItems(key, playlistId, opts = {}) {
  const { maxResults = Infinity, publishedById = {}, onProgress = () => {} } = opts;
  const ids = new Set();
  let pageToken = null;
  let pages = 0;
  let truncated = false;
  const seenTokens = new Set();
  const HARD_PAGE_LIMIT = 2000;
  do {
    const params = { part: "snippet,contentDetails", playlistId, maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;
    const res = await ytApi(key, "playlistItems", params);
    const items = res.items ?? [];
    for (const it of items) {
      const id = it?.contentDetails?.videoId;
      if (id && !publishedById[id]) {
        publishedById[id] = it?.contentDetails?.videoPublishedAt ?? it?.snippet?.publishedAt ?? null;
      }
      if (id) ids.add(id);
    }
    const next = res.nextPageToken ?? null;
    // 空页且仍返回相同 token 时停止，避免无限循环
    if (next && (seenTokens.has(next) || (items.length === 0 && next === pageToken))) {
      throw new Error(`playlist pagination repeated token for ${playlistId}`);
    }
    if (next) seenTokens.add(next);
    pageToken = next;
    pages++;
    onProgress({ phase: "playlist", pages, discovered: ids.size });
    if (ids.size >= maxResults) {
      truncated = !!pageToken;
      break;
    }
    if (pages >= HARD_PAGE_LIMIT && pageToken) {
      throw new Error(`playlist pagination exceeded hard page limit (${HARD_PAGE_LIMIT})`);
    }
  } while (pageToken);
  return { ids: Array.from(ids), truncated };
}

async function fetchChannelByAPI(key, handle) {
  const chRes = /^UC[\w-]{20,}$/.test(handle)
    ? await ytApi(key, "channels", { part: "snippet,statistics,contentDetails", id: handle })
    : await ytApi(key, "channels", { part: "snippet,statistics,contentDetails", forHandle: handle });
  const c = chRes.items?.[0];
  if (!c) {
    const e = new Error(`API 未找到频道 ${handle}`);
    e.apiRetryable = true;
    throw e;
  }
  const sn = c.snippet ?? {};
  const st = c.statistics ?? {};
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
  return { profile, about, subscribers, uploadsId: c.contentDetails?.relatedPlaylists?.uploads };
}

export async function syncChannelViaAPI(item, { kind = "refresh", knownVideoIds = [], priorVideos = {}, onProgress = () => {} } = {}) {
  const key = await loadYouTubeKey();
  if (!key) throw new Error("未配置 YOUTUBE_API_KEY");
  const handle = typeof item === "string" ? item : item.handle;
  console.log(`\n== ${handle}（API ${kind}） ==`);

  const { profile, about, subscribers, uploadsId } = await fetchChannelByAPI(key, handle);
  if (!uploadsId && about.videoCountTotal > 0) {
    throw new Error(`channel ${handle} reports uploads but API returned no uploads playlist`);
  }

  const publishedById = {};
  let fetchedIds = [];
  let truncated = false;
  if (uploadsId) {
    if (kind === "initial") {
      ({ ids: fetchedIds } = await fetchPlaylistItems(key, uploadsId, { maxResults: 50, publishedById, onProgress }));
    } else if (kind === "full") {
      const rawCap = process.env.YT_MAX_FULL_VIDEOS;
      const explicitCap = rawCap === undefined ? Infinity : Number(rawCap);
      if (!Number.isInteger(explicitCap) && explicitCap !== Infinity || explicitCap <= 0) {
        throw new Error("YT_MAX_FULL_VIDEOS must be a positive integer");
      }
      ({ ids: fetchedIds, truncated } = await fetchPlaylistItems(key, uploadsId, {
        maxResults: explicitCap, publishedById, onProgress,
      }));
    } else {
      ({ ids: fetchedIds } = await fetchPlaylistItems(key, uploadsId, {
        maxResults: REFRESH_UPLOAD_PAGES * 50, publishedById, onProgress,
      }));
    }
  }

  const fetchedSet = new Set(fetchedIds);
  const idsToFetch = Array.from(new Set([...fetchedIds, ...knownVideoIds.filter((id) => !fetchedSet.has(id))]));
  const videosOut = {};
  if (idsToFetch.length) await fetchApiVideos(key, idsToFetch, videosOut, publishedById, onProgress);

  // The public API does not classify Shorts or member-only videos; preserve prior evidence.
  const knownSet = new Set(knownVideoIds);
  for (const [id, video] of Object.entries(videosOut)) {
    if (!knownSet.has(id) || !priorVideos[id]) continue;
    if (priorVideos[id].shorts != null) video.shorts = priorVideos[id].shorts;
    if (priorVideos[id].membersOnly != null) video.membersOnly = priorVideos[id].membersOnly;
  }
  if (process.env.YT_CLASSIFY_SHORTS === "1") {
    const newIds = Object.keys(videosOut).filter((id) => !knownSet.has(id));
    const shorts = await classifyNewShorts(profile.channelId, newIds);
    for (const id of shorts) videosOut[id].shorts = true;
  }
  if (truncated) {
    onProgress({ phase: "truncated", discovered: fetchedIds.length, reason: "configured cap" });
    throw new Error(`full collection reached YT_MAX_FULL_VIDEOS=${process.env.YT_MAX_FULL_VIDEOS}; not complete`);
  }

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

async function classifyNewShorts(channelId, videoIds) {
  // Optional Shorts tab lookup, never per-video watch; failed classification remains unknown.
  const out = new Set();
  if (!channelId || !videoIds.length) return out;
  try {
    const page = await fetchChannelPage(channelUrlBase(channelId));
    const { innertube } = page;
    if (!innertube) return out;
    const shorts = await browseAll(channelId, "shorts", innertube, 50);
    const wanted = new Set(videoIds);
    for (const [id] of shorts) {
      if (wanted.has(id)) out.add(id);
    }
  } catch {
    // Classification is advisory; missing data remains unknown.
  }
  return out;
}

export async function syncChannelInitial(item, opts = {}) {
  return syncChannelViaAPI(item, { kind: "initial", ...opts });
}
export async function syncChannelFull(item, opts = {}) {
  return syncChannelViaAPI(item, { kind: "full", ...opts });
}
export async function syncChannelRefresh(item, opts = {}) {
  return syncChannelViaAPI(item, { kind: "refresh", ...opts });
}

// 页面抓取兜底（仅在未配置 API key 或 API 完全不可用时使用）
export async function syncChannel(item, opts = {}) {
  const handle = typeof item === "string" ? item : item.handle;
  const key = await loadYouTubeKey();
  if (key) {
    try {
      return await syncChannelViaAPI(item, { kind: opts.kind ?? "refresh", knownVideoIds: opts.knownVideoIds ?? [] });
    } catch (e) {
      if (e instanceof QuotaExceeded || e instanceof ApiFatal) {
        console.warn(`  ! API 不可用，改用页面抓取: ${e0(e)}`);
      } else {
        console.warn(`  ! API 失败，改用页面抓取: ${e0(e)}`);
      }
    }
  }

  const all = !!item.all || !!opts.all;
  const exactLimit = opts.exactLimit ?? RECENT_EXACT;
  const base = channelUrlBase(handle);

  console.log(`\n== ${handle}${all ? "（全量/兜底）" : ""} ==`);
  const page = await fetchChannelPage(base);
  const { profile: pageProfile, subscribers: pageSubscribers, videos: firstPage, innertube } = page;
  const pageAbout = await fetchAbout(base).catch(() => ({}));
  const profile = pageProfile;
  const about = pageAbout;
  const subscribers = pageSubscribers;

  let videoList = firstPage;
  if ((all || opts.kind === "full") && innertube && profile.channelId) {
    const merged = new Map(firstPage);
    for (const kind of ["videos", "shorts"]) {
      for (const [id, v] of await browseAll(profile.channelId, kind, innertube)) {
        if (!merged.has(id)) merged.set(id, v);
        else if (v.shorts) merged.get(id).shorts = true;
      }
    }
    videoList = [...merged.entries()];
  }
  if (!videoList.length && innertube && profile.channelId) {
    videoList = await browseAll(profile.channelId, "shorts", innertube, 2);
  }

  const rss = profile.rssUrl ? await fetchRss(profile.rssUrl).catch(() => ({})) : {};
  const videosOut = {};
  for (let i = 0; i < videoList.length; i++) {
    const [id, meta] = videoList[i];
    if (i < exactLimit) {
      await sleep(REQUEST_DELAY_MS);
      let detail = {};
      try {
        detail = await fetchWatch(id);
      } catch {}
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
      videosOut[id] = {
        title: meta.title,
        views: parseAbbrev(meta.viewsText),
        likes: null,
        published: null,
        publishedFull: null,
        durationSec: null,
        descriptionChars: null,
        shorts: !!meta.shorts,
        membersOnly: false,
        approx: true,
      };
    }
  }

  const record = {
    date: new Date().toISOString().slice(0, 10),
    subscribers,
    channelTotalViews: about.totalViews ?? null,
    channelVideoCount: about.videoCountTotal ?? null,
    videoCountTracked: Object.keys(videosOut).length,
    videos: videosOut,
  };
  return { handle, platform: "youtube", profile, about, record, source: "youtube-page" };
}

// TikTok collector still shares config read/write; channel history belongs to SQLite.
export async function readConfig() {
  const channels = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  if (!Array.isArray(channels)) throw new Error("channels.json 格式应为数组");
  return channels;
}

export async function writeConfig(channels) {
  await writeFile(CONFIG_FILE, JSON.stringify(channels, null, 2));
}

async function main(args = process.argv.slice(2)) {
  let only = null;
  let full = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--full") {
      full = true;
    } else if (args[i] === "--only" && args[i + 1]) {
      only = new Set(args[++i].split(",").map((raw) => {
        const handle = normalizeYouTubeHandle(raw.trim());
        if (!handle) throw new Error(`Invalid YouTube handle: ${raw}`);
        return handle;
      }));
    } else {
      throw new Error(`Unknown option: ${args[i]}`);
    }
  }
  const { openStore } = await import("./dashboard-store.mjs");
  const store = openStore();
  try {
    const config = await readConfig();
    store.reconcileConfig(config);
    const selectedHandles = only && new Set([...only].map((handle) => store.resolveHandle(handle) ?? handle));
    let selected = 0;
    for (const entry of config) {
      if ((entry.platform ?? "youtube") !== "youtube") continue;
      const normalized = normalizeYouTubeHandle(entry.handle);
      if (selectedHandles && !selectedHandles.has(normalized) &&
          !selectedHandles.has(store.resolveHandle(entry.handle) ?? entry.handle)) continue;
      const kind = full ? "full" : store.hasRecords(entry.handle) ? "refresh" : "initial";
      store.enqueue(entry.handle, kind, { ...entry });
      selected++;
    }
    if (only && selected === 0) throw new Error("No configured YouTube channel matched --only");
  } finally {
    store.close();
  }
  const { runJobs } = await import("./run-dashboard-jobs.mjs");
  await runJobs();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
