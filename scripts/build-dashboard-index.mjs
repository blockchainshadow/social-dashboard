#!/usr/bin/env node
// 从 SQLite store 生成 dashboard 索引与内容寻址分片。
// 输出：
//   - data/dashboard-index.json  （小索引：updatedAt + channels[handle].{info,path,version}）
//   - data/channels/<content-hash>.json  （单个频道的完整 {info,records}，内容不变则路径不变）
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./dashboard-store.mjs";

const OUT_DIR = "data/channels";
const INDEX_PATH = "data/dashboard-index.json";

function sha256(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function build({ root = process.cwd() } = {}) {
  const store = openStore({ root });
  const outDir = path.resolve(root, OUT_DIR);
  const indexPath = path.resolve(root, INDEX_PATH);
  try {
    await mkdir(outDir, { recursive: true });
    let previous = { channels: {} };
    try {
      previous = JSON.parse(await readFile(indexPath, "utf8"));
      if (!previous?.channels || typeof previous.channels !== "object") throw new Error("invalid index");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const reuse = { ...previous.channels };
    // A missing local immutable shard must be rebuilt even if the DB row did not change.
    for (const [handle, entry] of Object.entries(reuse)) {
      if (!entry.path || !(await exists(path.resolve(root, entry.path)))) delete reuse[handle];
    }
    const snapshot = store.publicationSnapshot(reuse);
    const index = { updatedAt: previous.updatedAt, channels: {} };
    let changed = Object.keys(snapshot.channels).length !== Object.keys(previous.channels).length;
    for (const handle of Object.keys(snapshot.channels).sort()) {
      const row = snapshot.channels[handle];
      const prev = reuse[handle];
      if (row.content === undefined && prev) {
        index.channels[handle] = { ...prev, info: row.info, sourceVersion: row.sourceVersion };
        continue;
      }
      if (typeof row.content !== "string") throw new Error(`missing channel content: ${handle}`);
      const hash = sha256(row.content);
      const shardName = `${hash.slice(0, 24)}.json`;
      const shardPath = path.join(outDir, shardName);
      if (!(await exists(shardPath))) await writeFile(shardPath, row.content, { flag: "wx" });
      index.channels[handle] = {
        info: row.info,
        path: `${OUT_DIR}/${shardName}`,
        version: hash.slice(0, 16),
        sourceVersion: row.sourceVersion,
      };
      if (index.channels[handle].path !== previous.channels[handle]?.path ||
          row.sourceVersion !== previous.channels[handle]?.sourceVersion) changed = true;
    }
    if (changed || !previous.updatedAt) {
      index.updatedAt = new Date().toISOString();
      const tmp = `${indexPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(index), "utf8");
      await rename(tmp, indexPath);
    }
    console.log(`[build-dashboard-index] channels=${Object.keys(index.channels).length} changed=${changed}`);
  } finally {
    store.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
  await build({ root });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[build-dashboard-index] 失败:", err);
    process.exit(1);
  });
}
