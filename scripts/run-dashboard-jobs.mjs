#!/usr/bin/env node
// scripts/run-dashboard-jobs.mjs
// 单例 runner：claim store 任务，调用 collector，保存结果，按任务发布，失败后重试不伪完成。
// 历史与任务状态写入走 SQLite；公开任务快照单独生成。

import { openStore } from "./dashboard-store.mjs";
import {
  syncChannelInitial,
  syncChannelFull,
  syncChannelRefresh,
  cacheAvatar,
} from "./fetch-youtube.mjs";
import { normalizeYouTubeHandle } from "../assets/channel-input.mjs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_RELAY = "https://dry-flower-a30f.xyxcliff.workers.dev";
const e0 = (e) => String(e?.message ?? e).slice(0, 200);

async function readConfig(root) {
  const raw = await readFile(path.join(root, "channels.json"), "utf8");
  const config = JSON.parse(raw);
  if (!Array.isArray(config)) throw new Error("channels.json must be an array");
  return config;
}

function configMap(config, store) {
  const map = new Map();
  for (const entry of config) {
    if ((entry.platform ?? "youtube") !== "youtube") continue;
    const canonical = store.resolveHandle(entry.handle) ?? entry.handle;
    if (!map.has(canonical) || canonical === entry.handle) map.set(canonical, entry);
  }
  return map;
}

function configuredEntry(store, config, handle) {
  return config.get(store.resolveHandle(handle) ?? handle) ?? null;
}


function knownVideoIdsAndPrior(store, handle) {
  const ch = store.getChannel(handle);
  if (!ch?.records?.length) return { knownVideoIds: [], priorVideos: {} };
  const latest = ch.records[ch.records.length - 1];
  return { knownVideoIds: Object.keys(latest.videos ?? {}), priorVideos: latest.videos ?? {} };
}

async function saveWithAvatar(store, result, meta = {}) {
  const remote = result.profile?.avatar;
  if (remote?.startsWith("http")) {
    const safeName = createHash("sha256")
      .update(result.profile.channelId || result.handle.normalize("NFC"))
      .digest("hex").slice(0, 24);
    const local = await cacheAvatar(remote, safeName);
    if (local) {
      result.profile.avatar = local;
    } else {
      result.profile.avatar = store.getChannel(result.handle)?.info?.avatar ?? remote;
    }
    result.profile.avatarRemote = remote;
  }
  const saved = store.saveChannel(result, meta);
  if (!saved) throw new Error(`channel ${result.handle} was removed during collection`);
  return saved;
}

function shell(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
      else resolve();
    });
  });
}

const DEFAULT_COLLECTORS = {
  initial: syncChannelInitial,
  full: syncChannelFull,
  refresh: syncChannelRefresh,
};

function buildMeta(entry, source) {
  return {
    source,
    owner: entry?.owner ?? null,
    alias: entry?.alias ?? null,
    group: entry?.group ?? null,
    tags: entry?.tags ?? [],
  };
}

export async function runOneJob(store, job, config, collectors = DEFAULT_COLLECTORS) {
  const { id, handle, kind, item = {}, status } = job;
  const entry = configuredEntry(store, config, handle);
  if (!entry) {
    const error = new Error(`channel ${handle} is no longer configured`);
    store.setJob(id, "failed", { error: error.message });
    throw error;
  }
  // Collected data is durable; restart publication without repeating API calls.
  if (status === "collected" || status === "publishing") return;

  const itemObj = typeof item === "string" ? JSON.parse(item) : item;
  const meta = buildMeta(entry, "youtube-api");
  const onProgress = (progress) => store.setJob(id, "running", {
    result: { ...progress, updatedAt: new Date().toISOString() },
  });
  try {
    let result;
    if (kind === "initial") {
      result = await collectors.initial(entry, { onProgress });
    } else if (kind === "full") {
      const prior = knownVideoIdsAndPrior(store, handle);
      result = entry.all === false
        ? await collectors.refresh(entry, { ...prior, onProgress })
        : await collectors.full(entry, { ...prior, onProgress });
    } else if (kind === "refresh") {
      result = await collectors.refresh(entry, {
        ...knownVideoIdsAndPrior(store, handle), onProgress,
      });
    } else {
      throw new Error(`unknown job kind ${kind}`);
    }
    await saveWithAvatar(store, result, meta);
    store.setJob(id, "collected", {
      result: { videoCountTracked: result.record.videoCountTracked, source: result.source },
    });
    if (kind === "initial" && entry.all !== false) {
      store.enqueue(entry.handle, "full", { ...itemObj, ...entry, fromInitial: true });
    }
  } catch (e) {
    store.setJob(id, "failed", { error: e0(e) });
    throw e;
  }
}

function jobsNeedingPublish(store, id) {
  return store.jobs().filter((j) => j.id === id &&
    (j.status === "collected" || j.status === "publishing"));
}

export async function writeJobsSnapshot(store, root) {
  const jobs = store.jobs();
  const sanitized = jobs.map((j) => ({
    id: j.id,
    handle: j.handle,
    kind: j.kind,
    status: j.status,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    error: j.error,
    result: j.result,
  }));
  const fs = await import("node:fs/promises");
  const snapshotPath = path.join(root, "data", "dashboard-jobs.json");
  try {
    const previous = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    if (JSON.stringify(previous.jobs) === JSON.stringify(sanitized)) return previous;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const out = { updatedAt: new Date().toISOString(), jobs: sanitized };
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(out, null, 2));
  return out;
}

async function publishRound(store, root, id) {
  const jobs = jobsNeedingPublish(store, id);
  if (!jobs.length) return;
  for (const job of jobs) store.setJob(job.id, "publishing");
  await writeJobsSnapshot(store, root);
  // The index is uploaded LAST, after avatar and immutable shards.
  try {
    await shell("bash", [path.join(root, "scripts", "publish-r2.sh")], { cwd: root });
  } catch (error) {
    for (const job of jobs) store.setJob(job.id, "collected", {
      error: e0(error), release: true,
    });
    await writeJobsSnapshot(store, root);
    throw error;
  }
  for (const job of jobs) store.setJob(job.id, "complete", {
    result: { ...(job.result || {}), published: true },
  });
  await writeJobsSnapshot(store, root);
  try {
    await shell("bash", [path.join(root, "scripts", "publish-r2.sh"), "--jobs-only"], { cwd: root });
  } catch (error) {
    for (const job of jobs) store.setJob(job.id, "publishing", {
      result: { ...(job.result || {}), published: false },
      error: e0(error), release: true,
    });
    await writeJobsSnapshot(store, root);
    throw error;
  }
}

async function fetchRemoteRequests(store, root) {
  const relay = process.env.DASHBOARD_RELAY || DEFAULT_RELAY;
  let token;
  try {
    token = (await readFile(path.join(os.homedir(), ".config", "social-dashboard", "runner-token"), "utf8")).trim();
  } catch {
    return 0;
  }
  if (!token) return 0;
  const config = configMap(await readConfig(root), store);
  const res = await fetch(`${relay}/internal/requests`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`remote requests HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.requests)) throw new Error("remote requests missing array");
  let acked = 0;
  for (const req of data.requests) {
    if (!req.id || !req.handle || !req.kind) continue;
    const platform = req.item?.platform ?? req.platform ?? "youtube";
    if (platform !== "youtube") continue;
    const existing = store.jobForRequest(req.id);
    const handle = normalizeYouTubeHandle(req.handle);
    const entry = handle ? configuredEntry(store, config, handle) : null;
    if (!existing && !entry) continue;
    const job = existing ?? store.enqueue(entry.handle, req.kind, {
      ...entry, ...(req.item ?? {}), requestId: req.id,
    });
    const ack = await fetch(`${relay}/internal/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: req.id, jobId: job.id }),
      signal: AbortSignal.timeout(10000),
    });
    if (!ack.ok) throw new Error(`remote ack HTTP ${ack.status}`);
    acked++;
  }
  return acked;
}

export async function queueLocalJobs(store, config, { kind = "refresh", handles = null } = {}) {
  for (const entry of config) {
    if ((entry.platform ?? "youtube") !== "youtube") continue;
    if (handles && !handles.includes(entry.handle)) continue;
    if (kind === "initial" && store.hasRecords(entry.handle)) continue;
    store.enqueue(entry.handle, kind, { ...entry });
  }
}

export async function runJobs({ root = process.cwd(), publish = true, sync = false, backup = false, collectors = DEFAULT_COLLECTORS } = {}) {
  const store = openStore({ root });
  try {
    try {
      const remote = await fetchRemoteRequests(store, root);
      if (remote) console.log(`[runner] enqueued ${remote} remote request(s)`);
    } catch (e) {
      console.warn(`[runner] remote requests skipped: ${e0(e)}`);
    }

    let ran = 0;
    let failed = 0;
    while (true) {
      const job = store.claim();
      if (!job) break;
      let config;
      try {
        config = await readConfig(root);
        store.reconcileConfig(config);
      } catch (error) {
        store.setJob(job.id, "failed", { error: e0(error) });
        throw error;
      }
      console.log(`[runner] ${job.handle} ${job.kind} #${job.id}`);
      try {
        await runOneJob(store, job, configMap(config, store), collectors);
        ran++;
      } catch (error) {
        failed++;
        console.error(`[runner] ${job.handle} ${job.kind} failed: ${e0(error)}`);
        await writeJobsSnapshot(store, root);
        if (publish) {
          await shell("bash", [path.join(root, "scripts", "publish-r2.sh"), "--jobs-only"], { cwd: root });
        }
        continue;
      }
      if (publish) {
        try {
          await publishRound(store, root, job.id);
        } catch (error) {
          console.error(`[runner] publish failed after ${job.handle}: ${e0(error)}`);
          throw error;
        }
      }
    }
    // Configuration edits and usage updates still publish when no collection ran.
    if (publish && ran === 0) {
      await writeJobsSnapshot(store, root);
      await shell("bash", [path.join(root, "scripts", "publish-r2.sh")], { cwd: root });
    }
    console.log(`[runner] done ran=${ran} failed=${failed}`);

    if (sync) await shell("bash", [path.join(root, "scripts", "sync-static.sh")], { cwd: root });
    if (backup) {
      await shell(process.execPath, [path.join(root, "scripts", "backup-dashboard.mjs"), "--backup", "--upload"], { cwd: root });
    }
    if (failed) throw new Error(`${failed} collection job(s) failed`);
  } finally {
    store.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
  const reconcile = argv.includes("--reconcile");
  const queueNew = argv.includes("--queue-new");
  const queueRefresh = argv.includes("--queue-refresh");
  const run = argv.includes("--run");
  const doPublish = !argv.includes("--no-publish");
  const doSync = argv.includes("--sync");
  const doBackup = argv.includes("--backup");

  const store = openStore({ root });
  try {
    if (reconcile) {
      const config = await readConfig(root);
      store.reconcileConfig(config);
    }
    if (queueNew || queueRefresh) {
      const config = await readConfig(root);
      if (queueNew) await queueLocalJobs(store, config, { kind: "initial" });
      if (queueRefresh) await queueLocalJobs(store, config, { kind: "refresh" });
    }
    if (run) {
      await runJobs({ root, publish: doPublish, sync: doSync, backup: doBackup });
    } else if (doPublish || doSync || doBackup) {
      await runJobs({ root, publish: doPublish, sync: doSync, backup: doBackup });
    }
  } finally {
    store.close();
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error("[run-dashboard-jobs]", e0(e));
    process.exit(1);
  });
}
