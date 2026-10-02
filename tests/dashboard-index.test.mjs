import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openStore } from "../scripts/dashboard-store.mjs";

const builder = fileURLToPath(new URL("../scripts/build-dashboard-index.mjs", import.meta.url));

function makeRecord(date, subscribers, videos = {}) {
  return { date, subscribers, videoCountTracked: Object.keys(videos).length, videos };
}

test("dashboard index loads the selected channel and reflects changed and removed channels", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dashboard-index-"));
  try {
    await mkdir(path.join(dir, "data"), { recursive: true });
    const store = openStore({ root: dir });
    store.saveChannel(
      { handle: "@mkbhd", profile: { name: "MKBHD", channelId: "UCxxxx" }, about: {}, record: makeRecord("2026-10-01", 21300000, { first: { views: 42 } }), source: "test" },
      { owner: "alex" }
    );
    store.saveChannel(
      { handle: "@small", profile: { name: "Small" }, about: {}, record: makeRecord("2026-10-01", 0), source: "test" }
    );
    store.close();

    execFileSync(process.execPath, [builder], { cwd: dir });
    const first = JSON.parse(await readFile(path.join(dir, "data/dashboard-index.json"), "utf8"));
    assert.deepEqual(Object.keys(first.channels), ["@mkbhd", "@small"]);
    assert.equal(first.channels["@mkbhd"].info.owner, "alex");
    const firstFile = path.join(dir, first.channels["@mkbhd"].path);
    const firstChannel = JSON.parse(await readFile(firstFile, "utf8"));
    const oldShard = path.join(dir, first.channels["@small"].path);
    const unchangedShardStat = await stat(oldShard);
    assert.match(first.channels["@small"].path, /^data\/channels\/[0-9a-f]{24}\.json$/);
    assert.equal(firstChannel.info.name, "MKBHD");

    const store2 = openStore({ root: dir });
    store2.saveChannel(
      { handle: "@mkbhd", profile: { name: "MKBHD", channelId: "UCxxxx" }, about: {}, record: makeRecord("2026-10-02", 21400000, { first: { views: 42 } }), source: "test" },
      { owner: "alex" }
    );
    store2.deleteChannel("@small");
    store2.close();

    execFileSync(process.execPath, [builder], { cwd: dir });
    const next = JSON.parse(await readFile(path.join(dir, "data/dashboard-index.json"), "utf8"));
    assert.deepEqual(Object.keys(next.channels), ["@mkbhd"]);
    // Already-published content-addressed shards must remain available to old index readers.
    assert.notEqual(next.channels["@mkbhd"].path, first.channels["@mkbhd"].path);
    assert.equal((await stat(firstFile)).size > 0, true);
    assert.equal((await stat(oldShard)).ino, unchangedShardStat.ino);
    assert.notEqual(next.channels["@mkbhd"].version, first.channels["@mkbhd"].version);
    const nextFile = path.join(dir, next.channels["@mkbhd"].path);
    const nextChannel = JSON.parse(await readFile(nextFile, "utf8"));
    assert.equal(nextChannel.records[nextChannel.records.length - 1].subscribers, 21400000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
