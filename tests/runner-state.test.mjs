import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../scripts/dashboard-store.mjs";
import { runJobs, queueLocalJobs } from "../scripts/run-dashboard-jobs.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HANDLE = "@runner-test";
const CONFIG = [{ platform: "youtube", handle: HANDLE, all: true, owner: "alice", alias: "Runner" }];

function result(count) {
  const videos = Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `video-${i}`, { title: `Video ${i}`, views: 10, shorts: null, membersOnly: null },
  ]));
  return {
    handle: HANDLE,
    platform: "youtube",
    profile: { name: "Runner", channelId: "UC" + "x".repeat(22), avatar: null },
    about: {},
    record: {
      date: "2026-10-02", subscribers: 5, channelTotalViews: 10,
      channelVideoCount: count, videoCountTracked: count, videos,
    },
    source: "youtube-api",
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "runner-state-"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "channels.json"), JSON.stringify(CONFIG));
  // Publish script records the externally visible status at each publication boundary.
  await writeFile(path.join(root, "scripts", "publish-r2.sh"), `#!/bin/bash
node -e 'const fs=require("fs"); const jobs=JSON.parse(fs.readFileSync("data/dashboard-jobs.json","utf8")).jobs; fs.appendFileSync("publish-events.ndjson",JSON.stringify({phase:process.argv[1] || "index",jobs:jobs.map(j=>({kind:j.kind,status:j.status}))})+"\\n")' -- "\${1:-index}"
if [ -f fail-index ] && [ "\${1:-}" != "--jobs-only" ]; then exit 17; fi
`);
  const store = openStore({ root });
  store.reconcileConfig(CONFIG);
  store.enqueue(HANDLE, "initial", CONFIG[0]);
  store.close();
  return root;
}

async function events(root) {
  return (await readFile(path.join(root, "publish-events.ndjson"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
}

// Avoid an ambient runner token (and production relay) during isolated tests.
async function isolatedRunner(root, opts) {
  const home = await mkdtemp(path.join(tmpdir(), "runner-no-token-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    await runJobs({ root, ...opts });
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    await rm(home, { recursive: true, force: true });
  }
}

test("initial publishes before full collection and completion follows index", async () => {
  const root = await fixture();
  try {
    let fullSawInitialPublished = false;
    await isolatedRunner(root, { collectors: {
      initial: async () => result(1),
      full: async () => {
        const published = await events(root);
        fullSawInitialPublished = published.some((event) =>
          event.jobs.some((job) => job.kind === "initial" && job.status === "complete"));
        return result(3);
      },
      refresh: async () => { throw new Error("unexpected refresh"); },
    } });
    assert.equal(fullSawInitialPublished, true);
    const store = openStore({ root });
    assert.equal(store.getChannel(HANDLE).records[0].videoCountTracked, 3);
    assert.deepEqual(store.jobs(HANDLE).map((job) => job.status), ["complete", "complete"]);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed index publication releases claim; retry does not recollect initial", async () => {
  const root = await fixture();
  try {
    let initialCalls = 0;
    const collectors = {
      initial: async () => { initialCalls++; return result(1); },
      full: async () => result(2),
      refresh: async () => { throw new Error("unexpected refresh"); },
    };
    await writeFile(path.join(root, "fail-index"), "1");
    await assert.rejects(isolatedRunner(root, { collectors }), /exited 17/);
    let store = openStore({ root });
    assert.equal(store.jobs(HANDLE).find((job) => job.kind === "initial").status, "collected");
    assert.equal(store.getChannel(HANDLE).records[0].videoCountTracked, 1);
    store.close();
    await rm(path.join(root, "fail-index"));
    await isolatedRunner(root, { collectors });
    store = openStore({ root });
    assert.equal(initialCalls, 1);
    assert.deepEqual(store.jobs(HANDLE).map((job) => job.status), ["complete", "complete"]);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue-new skips existing records without skipping new configured channels", async () => {
  const root = await fixture();
  try {
    const store = openStore({ root });
    store.saveChannel(result(1));
    const config = [...CONFIG, { platform: "youtube", handle: "@another", all: false }];
    await queueLocalJobs(store, config, { kind: "initial" });
    assert.equal(store.jobs(HANDLE).filter((job) => job.kind === "initial").length, 1);
    assert.equal(store.jobs("@another").filter((job) => job.kind === "initial").length, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration deletion reaches the published index without a collection job", async () => {
  const root = await fixture();
  try {
    const store = openStore({ root });
    store.saveChannel(result(1), CONFIG[0]);
    for (const job of store.jobs()) store.setJob(job.id, "failed");
    const builder = fileURLToPath(new URL("../scripts/build-dashboard-index.mjs", import.meta.url));
    execFileSync(process.execPath, [builder, "--root", root]);
    const before = JSON.parse(await readFile(path.join(root, "data", "dashboard-index.json"), "utf8"));
    assert.equal(before.channels[HANDLE].info.channelId, result(1).profile.channelId);
    await writeFile(path.join(root, "channels.json"), "[]");
    store.reconcileConfig([]);
    store.close();
    await writeFile(path.join(root, "scripts", "publish-r2.sh"),
      `#!/bin/bash\n"${process.execPath}" "${builder}" --root "$PWD"\n`);
    await isolatedRunner(root, {});
    const after = JSON.parse(await readFile(path.join(root, "data", "dashboard-index.json"), "utf8"));
    assert.equal(after.channels[HANDLE], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
