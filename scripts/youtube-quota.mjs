#!/usr/bin/env node
// YouTube API 配额原子预留 + 公开快照（跨进程安全，PT 日边界）
// 公开文件 data/youtube-api-usage.json 只含聚合计数，不含密钥/端点/频道名。

import { readFile, writeFile, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LIMIT = 9000;
const HARD_CAP = 9000;

export class QuotaExceeded extends Error {}

export function getPTDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function resolveLimit(raw = process.env.YT_QUOTA_CAP) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0; // fail closed：非法值直接锁死
  return Math.min(Math.floor(n), HARD_CAP);
}

function rawPath(logsDir, day) {
  return path.resolve(logsDir, `.yt-quota-${day}`);
}

function lockDirPath(logsDir, day) {
  return path.resolve(logsDir, `.yt-quota-lock-${day}`);
}

function blockedPath(logsDir, day) {
  return path.resolve(logsDir, `.yt-quota-blocked-${day}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireLock(lockDir, timeoutMs = 5000) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      return;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      // 不强行接管未知进程的锁：磁盘/调度停顿也不能造成配额重复预留。
      if (Date.now() - started > timeoutMs) {
        throw new QuotaExceeded(`无法获取配额锁 ${lockDir}（已等待 ${timeoutMs}ms），fail closed`);
      }
      await sleep(20 + Math.floor(Math.random() * 80));
    }
  }
}

async function releaseLock(lockDir) {
  await rmdir(lockDir).catch(() => {});
}

async function readUsed(raw) {
  try {
    const txt = (await readFile(raw, "utf8")).trim();
    if (!txt) return 0;
    const n = parseInt(txt, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== txt) {
      throw new QuotaExceeded(`配额原始日志损坏: ${raw}`);
    }
    return n;
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
}

async function readSnapshot(pub) {
  try {
    return JSON.parse(await readFile(pub, "utf8"));
  } catch {
    return null;
  }
}

async function writePublicSnapshot(pub, { updatedAt, day, used, limit, blocked }) {
  const next = { updatedAt, day, used, limit, blocked: !!blocked };
  const prev = await readSnapshot(pub);
  if (
    prev &&
    prev.day === next.day &&
    prev.used === next.used &&
    prev.limit === next.limit &&
    prev.blocked === next.blocked
  ) {
    return false; // 未变化，保留原 updatedAt 与文件 mtime
  }
  await writeFile(pub, JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

async function readBlocked(file) {
  try {
    if ((await readFile(file, "utf8")).trim() !== "1") throw new QuotaExceeded(`配额阻断标记损坏: ${file}`);
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

export async function reserve(options = {}) {
  const cost = Math.max(1, Math.floor(Number(options.cost ?? 1)) || 1);
  const dataDir = path.resolve(options.dataDir ?? "data");
  const logsDir = path.resolve(options.logsDir ?? "logs");
  const now = options.now ?? new Date();
  const day = getPTDate(now);
  const limit = resolveLimit();
  const raw = rawPath(logsDir, day);
  const pub = path.resolve(dataDir, "youtube-api-usage.json");
  const lockDir = lockDirPath(logsDir, day);
  const blockedFile = blockedPath(logsDir, day);

  await mkdir(dataDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  await acquireLock(lockDir, options.lockTimeoutMs ?? 5000);
  try {
    const used = await readUsed(raw);
    const alreadyBlocked = used >= limit || (await readBlocked(blockedFile));
    if (alreadyBlocked) {
      await writePublicSnapshot(pub, {
        updatedAt: now.toISOString(),
        day,
        used,
        limit,
        blocked: true,
      });
      return { ok: false, used, limit, day, remaining: Math.max(0, limit - used), blocked: true };
    }

    const newUsed = used + cost;
    if (newUsed > limit) {
      await writePublicSnapshot(pub, {
        updatedAt: now.toISOString(),
        day,
        used,
        limit,
        blocked: true,
      });
      return { ok: false, used, limit, day, remaining: 0, blocked: true };
    }

    await writeFile(raw, String(newUsed), "utf8");
    const blocked = newUsed >= limit;
    await writePublicSnapshot(pub, {
      updatedAt: now.toISOString(),
      day,
      used: newUsed,
      limit,
      blocked,
    });
    return { ok: true, used: newUsed, limit, day, remaining: limit - newUsed, blocked };
  } finally {
    await releaseLock(lockDir);
  }
}

export async function markBlocked(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? "data");
  const logsDir = path.resolve(options.logsDir ?? "logs");
  const now = options.now ?? new Date();
  const day = options.day ?? getPTDate(now);
  const limit = resolveLimit();
  const raw = rawPath(logsDir, day);
  const pub = path.resolve(dataDir, "youtube-api-usage.json");
  const lockDir = lockDirPath(logsDir, day);
  const blockedFile = blockedPath(logsDir, day);

  await mkdir(dataDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  await acquireLock(lockDir, options.lockTimeoutMs ?? 5000);
  try {
    const used = await readUsed(raw);
    await writeFile(blockedFile, "1", "utf8");
    await writePublicSnapshot(pub, {
      updatedAt: now.toISOString(),
      day,
      used,
      limit,
      blocked: true,
    });
    return { used, limit, day, blocked: true };
  } finally {
    await releaseLock(lockDir);
  }
}

export async function refreshSnapshot(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? "data");
  const logsDir = path.resolve(options.logsDir ?? "logs");
  const now = options.now ?? new Date();
  const day = getPTDate(now);
  const limit = resolveLimit();
  const raw = rawPath(logsDir, day);
  const pub = path.resolve(dataDir, "youtube-api-usage.json");
  const lockDir = lockDirPath(logsDir, day);
  const blockedFile = blockedPath(logsDir, day);

  await mkdir(dataDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  await acquireLock(lockDir, options.lockTimeoutMs ?? 5000);
  try {
    const used = await readUsed(raw);
    const blocked = used >= limit || (await readBlocked(blockedFile));
    await writePublicSnapshot(pub, {
      updatedAt: now.toISOString(),
      day,
      used,
      limit,
      blocked,
    });
    return { day, used, limit, blocked, path: pub };
  } finally {
    await releaseLock(lockDir);
  }
}

async function run(argv = process.argv.slice(2)) {
  if (argv.includes("--snapshot")) {
    const result = await refreshSnapshot();
    console.log(JSON.stringify(result));
    return;
  }
  console.error("用法: node scripts/youtube-quota.mjs --snapshot");
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  await run();
}
