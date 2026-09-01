#!/usr/bin/env node
// TikTok 账号公开数据采集（零依赖，需 Node >= 18）
// 说明：TikTok 对无登录请求有 WAF 挑战，直接抓取通常被拦。
// 方案：优先直接抓取页面内嵌 JSON，失败则走 Jina Reader 渲染代理（免费无 Key）。
// 能拿到：昵称 / 粉丝数 / 累计获赞 / 关注数 / 头像；视频级数据 TikTok 延迟加载，暂无法获取。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheAvatar } from "./fetch-youtube.mjs";

export { cacheAvatar };

const CONFIG_FILE = path.resolve("channels.json");
const DATA_FILE = path.resolve("data/tiktok-history.json");
const AVATAR_DIR = path.resolve("web/avatars");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e0 = (e) => String(e?.message ?? e).slice(0, 120);

async function getText(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
      });
      if (res.ok) return res.text();
      lastErr = new Error(`${res.status} for ${url}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await sleep(2000);
  }
  throw lastErr;
}

// "86.8M" -> 86800000
function parseAbbrev(text) {
  const m = String(text).match(/([\d.,]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

export function normalizeTikTokHandle(input) {
  let h = String(input ?? "").trim();
  if (!h) return null;
  h = h.split("/").filter(Boolean).pop();
  if (!h.startsWith("@")) h = "@" + h;
  return /^@[\w.]{1,24}$/.test(h) ? h.toLowerCase() : null;
}

// ---------- 数据源 1：直接抓页面内嵌 JSON（部分网络可用） ----------
async function fetchDirect(handle) {
  const html = await getText(`https://www.tiktok.com/${handle}`);
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(\{.+?\})<\/script>/s
  );
  if (!m) throw new Error("页面无内嵌数据（被 WAF 拦截）");
  const j = JSON.parse(m[1]);
  const ud = j?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
  const { user, stats } = ud?.userInfo ?? {};
  if (!user || !stats) throw new Error("内嵌数据中无 userInfo");
  return {
    name: user.nickname ?? handle,
    uniqueId: user.uniqueId ?? handle.slice(1),
    avatar: user.avatarLarger ?? null,
    bio: user.signature ?? null,
    verified: !!user.verified,
    followers: stats.followerCount ?? null,
    hearts: stats.heartCount ?? null,
    following: stats.followingCount ?? null,
    videoCount: stats.videoCount ?? null,
  };
}

// ---------- 数据源 2：本地无头浏览器（最可靠，需安装 playwright） ----------
let _browser; // 复用同一个浏览器实例
async function getBrowser() {
  if (!_browser) {
    const { chromium } = await import("playwright");
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

async function fetchViaBrowser(handle) {
  let browser;
  try {
    browser = await getBrowser();
  } catch {
    throw new Error("未安装 playwright（npm i playwright && npx playwright install chromium）");
  }
  const page = await browser.newPage({
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });
  try {
    await page.goto(`https://www.tiktok.com/${handle}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    // WAF 挑战由真实浏览器执行，等待内嵌数据出现
    await page.waitForSelector("script#__UNIVERSAL_DATA_FOR_REHYDRATION__", {
      timeout: 45000,
    });
    const raw = await page.$eval(
      "script#__UNIVERSAL_DATA_FOR_REHYDRATION__",
      (el) => el.textContent
    );
    const j = JSON.parse(raw);
    const ud = j?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
    const { user, stats } = ud?.userInfo ?? {};
    if (!user || !stats) throw new Error("页面数据中无 userInfo（可能触发验证码）");

    // 首屏视频列表（约 9-16 个，带精确互动数据）
    const videos = {};
    for (const it of ud.itemList ?? []) {
      videos[it.id] = {
        title: it.desc ?? "",
        views: it.stats?.playCount ?? null,
        likes: it.stats?.diggCount ?? null,
        comments: it.stats?.commentCount ?? null,
        shares: it.stats?.shareCount ?? null,
        published: it.createTime
          ? new Date(Number(it.createTime) * 1000).toISOString().slice(0, 10)
          : null,
        durationSec: it.video?.duration ?? null,
        shorts: false,
        approx: false,
      };
    }

    return {
      info: {
        name: user.nickname ?? handle,
        uniqueId: user.uniqueId ?? handle.slice(1),
        avatar: user.avatarLarger ?? null,
        bio: user.signature ?? null,
        verified: !!user.verified,
        followers: stats.followerCount ?? null,
        hearts: stats.heartCount ?? null,
        following: stats.followingCount ?? null,
        videoCount: stats.videoCount ?? null,
      },
      videos,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 数据源 3：Jina Reader 渲染代理（免费无 Key，有限流需退避重试） ----------
async function fetchViaJina(handle) {
  let lastErr;
  const waits = [0, 15000, 30000, 60000];
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) {
      console.log(`  Jina 限流/失败，${waits[i] / 1000}s 后重试(${i}/${waits.length - 1})…`);
      await sleep(waits[i]);
    }
    try {
      const res = await fetch(`https://r.jina.ai/https://www.tiktok.com/${handle}`, {
        headers: {
          "User-Agent": UA,
          ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
        },
      });
      if (res.status === 403 || res.status === 429) {
        lastErr = new Error(`Jina ${res.status} 限流`);
        continue;
      }
      if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
      const text = await res.text();
      if (!/Followers/i.test(text)) throw new Error("Jina 返回内容无粉丝数据");

      const grab = (label) => {
        const re = new RegExp(`\\*\\*([\\d.,]+\\s*[KMB]?)\\*\\*\\s*${label}`, "i");
        return parseAbbrev(text.match(re)?.[1]);
      };
      const title = text.match(/^Title:\s*(.+?)\s*\((@[\w.]+)\)\s*\|/m)?.[1] ?? handle.slice(1);
      const avatar = text.match(/!\[Image 1\]\(([^)]+)\)/)?.[1] ?? null;

      return {
        name: title,
        uniqueId: handle.slice(1),
        avatar,
        bio: null,
        verified: null,
        followers: grab("Followers"),
        hearts: grab("Likes"),
        following: grab("Following"),
        videoCount: null,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Jina 请求失败");
}

// ---------- 同步单个账号（与 youtube 模块同接口） ----------
// 三级降级：直连 → 本地无头浏览器 → Jina Reader
export async function syncChannel(item, opts = {}) {
  const handle = typeof item === "string" ? item : item.handle;
  console.log(`\n== tiktok ${handle} ==`);

  let info, videos = {}, source;
  try {
    info = await fetchDirect(handle);
    source = "direct";
  } catch (e) {
    console.log(`  直接抓取失败（${e0(e)}），尝试本地无头浏览器…`);
    try {
      const r = await fetchViaBrowser(handle);
      info = r.info;
      videos = r.videos;
      source = "browser";
    } catch (e2) {
      console.log(`  浏览器方案失败（${e0(e2)}），改走 Jina Reader…`);
      info = await fetchViaJina(handle);
      source = "jina";
    }
  }
  await sleep(500);

  const record = {
    date: new Date().toISOString().slice(0, 10),
    followers: info.followers,
    hearts: info.hearts,
    following: info.following,
    channelVideoCount: info.videoCount,
    videoCountTracked: Object.keys(videos).length,
    videos, // 浏览器方案可拿到首屏视频的精确互动数据；Jina 方案为空
  };

  return {
    handle,
    platform: "tiktok",
    profile: {
      name: info.name,
      channelId: null,
      canonicalUrl: `https://www.tiktok.com/${handle}`,
      description: info.bio,
      keywords: [],
      rssUrl: null,
      avatar: info.avatar,
      isFamilySafe: null,
      availableCountryCodes: null,
      verified: info.verified,
    },
    about: {},
    record,
    source,
  };
}

// ---------- 历史与配置（与 youtube 模块同接口） ----------
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

export function readConfig() {
  return import("./fetch-youtube.mjs").then((m) => m.readConfig());
}

export function writeConfig(channels) {
  return import("./fetch-youtube.mjs").then((m) => m.writeConfig(channels));
}

export function mergeIntoHistory(history, { handle, profile, record }) {
  const ch = (history.channels[handle] ??= { info: {}, records: [] });
  ch.records = ch.records.filter((r) => r.date !== record.date);
  ch.records.push(record);
  ch.records.sort((a, b) => a.date.localeCompare(b.date));
  ch.info = {
    ...profile,
    ...(ch.info ?? {}),
    ...profile,
  };
  return { ch, safeName: handle.replace(/[^\w-]/g, "") || "channel" };
}

// ---------- CLI ----------
async function main() {
  const channels = await readConfig();
  const tiktokEntries = channels.filter(
    (c) => (typeof c === "string" ? "youtube" : c.platform ?? "youtube") === "tiktok"
  );
  if (!tiktokEntries.length) {
    console.log("channels.json 中没有 platform=tiktok 的账号");
    return;
  }
  const history = await loadHistory();
  for (const item of tiktokEntries) {
    try {
      const result = await syncChannel(item);
      const { ch, safeName } = mergeIntoHistory(history, result);
      if (result.profile.avatar?.startsWith("http")) {
        const remote = result.profile.avatar;
        ch.info.avatar = (await cacheAvatar(remote, safeName)) ?? remote;
        ch.info.avatarRemote = remote;
      }
      console.log(
        `  ${result.profile.name}: 粉丝=${result.record.followers?.toLocaleString()} 获赞=${result.record.hearts?.toLocaleString()}（来源:${result.source}）`
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
