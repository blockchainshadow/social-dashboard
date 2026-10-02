#!/usr/bin/env node
// 增量补充采集：检测 channels.json 中尚未入库的新频道，排队 initial 任务。
// 实际采集与发布由 run-dashboard-jobs.mjs 单例 runner 完成。
import { openStore } from "./dashboard-store.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const e0 = (e) => String(e?.message ?? e).slice(0, 160);

async function readConfig(root) {
  const raw = await readFile(path.join(root, "channels.json"), "utf8");
  const config = JSON.parse(raw);
  if (!Array.isArray(config)) throw new Error("channels.json must be an array");
  return config;
}

async function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
  const run = argv.includes("--run");

  const config = await readConfig(root);
  const store = openStore({ root });
  try {
    store.reconcileConfig(config);
    const youtube = config.filter((c) => (c.platform ?? "youtube") === "youtube");
    const newChannels = [];
    for (const item of youtube) {
      if (store.hasRecords(item.handle)) continue;
      const job = store.enqueue(item.handle, "initial", { ...item }, { once: true });
      if (job.status === "queued") newChannels.push(item.handle);
    }
    console.log(JSON.stringify({ queued: newChannels.length, newChannels }));
  } finally {
    store.close();
  }

  if (run) {
    const { runJobs } = await import("./run-dashboard-jobs.mjs");
    await runJobs({ root, publish: true, sync: true });
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error("[watch-new-channels]", e0(e));
    process.exit(1);
  });
}
