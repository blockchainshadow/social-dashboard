import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getPTDate,
  resolveLimit,
  reserve,
  refreshSnapshot,
  markBlocked,
  QuotaExceeded,
} from "../scripts/youtube-quota.mjs";

const here = fileURLToPath(new URL("../scripts/youtube-quota.mjs", import.meta.url));

async function tmpEnv(extraEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "yt-quota-"));
  await mkdir(path.join(dir, "data"), { recursive: true });
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return {
    dir,
    run(code) {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "--eval", code],
          {
            cwd: dir,
            env: { ...process.env, ...extraEnv },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
      });
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("getPTDate 返回 America/Los_Angeles 的 YYYY-MM-DD", () => {
  // 2026-10-03T06:59:00Z = PT 2026-10-02 23:59 (PDT)
  assert.equal(getPTDate(new Date("2026-10-03T06:59:00Z")), "2026-10-02");
  // 2026-10-03T07:01:00Z = PT 2026-10-03 00:01
  assert.equal(getPTDate(new Date("2026-10-03T07:01:00Z")), "2026-10-03");
});

test("resolveLimit 默认 9000 且硬上限 9000，错误值 fail closed", () => {
  assert.equal(resolveLimit(undefined), 9000);
  assert.equal(resolveLimit(""), 9000);
  assert.equal(resolveLimit("9000"), 9000);
  assert.equal(resolveLimit("12000"), 9000);
  assert.equal(resolveLimit("-1"), 0);
  assert.equal(resolveLimit("abc"), 0);
  assert.equal(resolveLimit("NaN"), 0);
});

test("reserve 原子递增并写入公开快照", async () => {
  const env = await tmpEnv();
  try {
    const r1 = await reserve({ dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") });
    assert.equal(r1.ok, true);
    assert.equal(r1.used, 1);
    assert.equal(r1.limit, 9000);
    assert.equal(r1.blocked, false);

    const r2 = await reserve({ dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") });
    assert.equal(r2.used, 2);

    const raw = await readFile(path.join(env.dir, "logs", `.yt-quota-${r1.day}`), "utf8");
    assert.equal(raw, "2");

    const pub = JSON.parse(await readFile(path.join(env.dir, "data", "youtube-api-usage.json"), "utf8"));
    assert.equal(pub.day, r1.day);
    assert.equal(pub.used, 2);
    assert.equal(pub.limit, 9000);
    assert.equal(pub.blocked, false);
    assert.ok(pub.updatedAt);
  } finally {
    await env.cleanup();
  }
});

test("多个并行进程共享预算且不会超卖", async () => {
  const env = await tmpEnv({ YT_QUOTA_CAP: "5" });
  try {
    const code = `
      import { reserve } from ${JSON.stringify(here)};
      const r = await reserve();
      console.log(JSON.stringify(r));
    `;
    const tasks = Array.from({ length: 10 }, () => env.run(code));
    const results = await Promise.all(tasks);
    assert.ok(results.every((r) => r.code === 0), results.map((r) => r.err).join("\n"));
    const parsed = results.map((r) => JSON.parse(r.out));
    const okCount = parsed.filter((r) => r.ok).length;
    const blockedCount = parsed.filter((r) => !r.ok && r.blocked).length;
    assert.equal(okCount, 5);
    assert.equal(blockedCount, 5);

    const day = parsed[0].day;
    const raw = await readFile(path.join(env.dir, "logs", `.yt-quota-${day}`), "utf8");
    assert.equal(raw, "5");
  } finally {
    await env.cleanup();
  }
});

test("达到上限后 reserve 阻断并标记 blocked", async () => {
  const prev = process.env.YT_QUOTA_CAP;
  process.env.YT_QUOTA_CAP = "1";
  const env = await tmpEnv();
  try {
    const r1 = await reserve({ dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") });
    assert.equal(r1.ok, true);
    const r2 = await reserve({ dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") });
    assert.equal(r2.ok, false);
    assert.equal(r2.blocked, true);
    const pub = JSON.parse(await readFile(path.join(env.dir, "data", "youtube-api-usage.json"), "utf8"));
    assert.equal(pub.blocked, true);
    assert.equal(pub.used, 1);
  } finally {
    await env.cleanup();
    if (prev === undefined) delete process.env.YT_QUOTA_CAP;
    else process.env.YT_QUOTA_CAP = prev;
  }
});

test("跨 PT 午夜 reset 为零且不沿用昨日", async () => {
  const env = await tmpEnv();
  try {
    const yesterday = new Date("2026-10-03T06:59:00Z"); // PT 2026-10-02
    const today = new Date("2026-10-03T07:01:00Z"); // PT 2026-10-03
    const dataDir = path.join(env.dir, "data");
    const logsDir = path.join(env.dir, "logs");

    const r1 = await reserve({ dataDir, logsDir, now: yesterday });
    assert.equal(r1.day, "2026-10-02");
    assert.equal(r1.used, 1);

    const r2 = await reserve({ dataDir, logsDir, now: today });
    assert.equal(r2.day, "2026-10-03");
    assert.equal(r2.used, 1); // 新一天，不累计

    const pub = JSON.parse(await readFile(path.join(dataDir, "youtube-api-usage.json"), "utf8"));
    assert.equal(pub.day, "2026-10-03");
    assert.equal(pub.used, 1);
  } finally {
    await env.cleanup();
  }
});

test("损坏的配额日志导致 fail closed", async () => {
  const env = await tmpEnv();
  try {
    const day = getPTDate();
    const raw = path.join(env.dir, "logs", `.yt-quota-${day}`);
    await writeFile(raw, "not-a-number", "utf8");
    await assert.rejects(
      reserve({ dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") }),
      QuotaExceeded,
    );
  } finally {
    await env.cleanup();
  }
});

test("Google 配额耗尽状态不会因公开快照丢失而解除", async () => {
  const env = await tmpEnv();
  try {
    const options = { dataDir: path.join(env.dir, "data"), logsDir: path.join(env.dir, "logs") };
    await reserve(options);
    await markBlocked(options);
    await unlink(path.join(options.dataDir, "youtube-api-usage.json"));
    const usage = await refreshSnapshot(options);
    assert.equal(usage.blocked, true);
    const next = await reserve(options);
    assert.equal(next.ok, false);
    assert.equal(next.used, 1);
  } finally {
    await env.cleanup();
  }
});

test("已有配额锁时超时拒绝调用", async () => {
  const env = await tmpEnv();
  try {
    const logsDir = path.join(env.dir, "logs");
    const lock = path.join(logsDir, `.yt-quota-lock-${getPTDate()}`);
    await mkdir(lock);
    await assert.rejects(
      reserve({ dataDir: path.join(env.dir, "data"), logsDir, lockTimeoutMs: 60 }),
      QuotaExceeded,
    );
  } finally {
    await env.cleanup();
  }
});

test("refreshSnapshot 在未变化时保留 updatedAt", async () => {
  const env = await tmpEnv();
  try {
    const dataDir = path.join(env.dir, "data");
    const logsDir = path.join(env.dir, "logs");
    const r1 = await refreshSnapshot({ dataDir, logsDir });
    const pub1 = JSON.parse(await readFile(path.join(dataDir, "youtube-api-usage.json"), "utf8"));
    const firstUpdatedAt = pub1.updatedAt;

    await new Promise((r) => setTimeout(r, 20));
    const r2 = await refreshSnapshot({ dataDir, logsDir });
    assert.deepEqual(r1, r2);
    const pub2 = JSON.parse(await readFile(path.join(dataDir, "youtube-api-usage.json"), "utf8"));
    assert.equal(pub2.updatedAt, firstUpdatedAt); // 文件未重写
  } finally {
    await env.cleanup();
  }
});

test("refreshSnapshot 跨日会重写文件", async () => {
  const env = await tmpEnv();
  try {
    const dataDir = path.join(env.dir, "data");
    const logsDir = path.join(env.dir, "logs");
    await reserve({ dataDir, logsDir, now: new Date("2026-10-03T06:59:00Z") });
    await refreshSnapshot({ dataDir, logsDir, now: new Date("2026-10-03T07:01:00Z") });
    const pub = JSON.parse(await readFile(path.join(dataDir, "youtube-api-usage.json"), "utf8"));
    assert.equal(pub.day, "2026-10-03");
    assert.equal(pub.used, 0);
  } finally {
    await env.cleanup();
  }
});
