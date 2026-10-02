import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, preserveTrackedVideos, ChannelConflictError } from "../scripts/dashboard-store.mjs";

async function tmpRoot(prefix = "dashboard-store-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "data"), { recursive: true });
  return dir;
}

function sampleHistory() {
  return {
    updatedAt: "2026-09-01T00:00:00Z",
    channels: {
      "@mkbhd": {
        info: { name: "MKBHD", owner: "alex", channelId: "UCBJycsmduvYEL83R_U4JriQ", alias: "mkbhd" },
        records: [
          {
            date: "2026-09-01",
            subscribers: 21300000,
            videoCountTracked: 2,
            videos: {
              v1: { title: "Phone", views: 1000, published: "2026-09-01" },
              v2: { title: "Laptop", views: 500, published: "2026-08-01" },
            },
          },
        ],
      },
      "@small": {
        info: { name: "Small Channel" },
        records: [
          {
            date: "2026-09-01",
            subscribers: 100,
            videoCountTracked: 1,
            videos: { s1: { title: "Intro", views: 10, published: "2026-09-01" } },
          },
        ],
      },
    },
  };
}

function buildResult(handle, { channelId, date, videos, subscribers = 0 }) {
  return {
    handle,
    profile: { name: handle, channelId },
    about: {},
    record: { date, subscribers, videoCountTracked: Object.keys(videos).length, videos },
    source: "test",
  };
}

test("imports youtube-history.json once and preserves counts", async () => {
  const root = await tmpRoot();
  try {
    const history = sampleHistory();
    await writeFile(join(root, "data", "youtube-history.json"), JSON.stringify(history));

    const store = openStore({ root });
    try {
      assert.ok(store.getRevision() > 0, "revision bumped by import");
      const exported = store.exportHistory();
      assert.deepEqual(Object.keys(exported.channels).sort(), ["@mkbhd", "@small"]);
      for (const handle of Object.keys(history.channels)) {
        const ch = store.getChannel(handle);
        assert.ok(ch, `getChannel ${handle}`);
        assert.equal(ch.records.length, history.channels[handle].records.length);
        assert.equal(
          ch.records[0].videoCountTracked,
          history.channels[handle].records[0].videoCountTracked
        );
      }
      // Presentation labels are not identity aliases; stable IDs are.
      assert.equal(store.getChannel("mkbhd"), null);
      assert.equal(store.getChannel("UCBJycsmduvYEL83R_U4JriQ").info.name, "MKBHD");
      assert.equal((await stat(join(root, "data", "dashboard.sqlite"))).mode & 0o777, 0o600);
    } finally {
      store.close();
    }

    // Second open must not re-import (file unchanged, revision stays).
    const store2 = openStore({ root });
    try {
      assert.equal(store2.getRevision(), 1);
    } finally {
      store2.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid history JSON fails closed", async () => {
  const root = await tmpRoot();
  try {
    await writeFile(join(root, "data", "youtube-history.json"), "{not json");
    assert.throws(() => openStore({ root }), /invalid JSON|Unexpected token/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects structurally damaged history rather than importing partial channels", async () => {
  for (const channel of [
    null,
    { info: null, records: [] },
    { info: {}, records: null },
    { info: {}, records: [{ date: "yesterday", videos: {} }] },
    { info: {}, records: [{ date: "2026-02-31", videos: {} }] },
    { info: {}, records: [{ date: "2026-10-01", videos: [] }] },
    { info: {}, records: [{ date: "2026-10-01", videos: { v1: null } }] },
  ]) {
    const root = await tmpRoot();
    try {
      await writeFile(join(root, "data", "youtube-history.json"),
        JSON.stringify({ channels: { "@broken": channel } }));
      assert.throws(() => openStore({ root }), /invalid channel|invalid record|invalid video/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("saveChannel preserves missing videos with staleAt and replaces same-day record", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const first = buildResult("@ex", {
        channelId: "UC_1",
        date: "2026-10-01",
        videos: {
          a: { title: "A", views: 10, published: "2026-10-01" },
          b: { title: "B", views: 20, published: "2026-09-01" },
        },
      });
      store.saveChannel(first);

      const second = buildResult("@ex", {
        channelId: "UC_1",
        date: "2026-10-02",
        videos: {
          a: { title: "A", views: 15, published: "2026-10-01" },
        },
      });
      store.saveChannel(second);

      const ch = store.getChannel("@ex");
      assert.equal(ch.records.length, 2);
      const latest = ch.records.find((r) => r.date === "2026-10-02");
      assert.equal(latest.videoCountTracked, 2);
      assert.equal(latest.videos.a.views, 15);
      assert.equal(latest.videos.b.staleAt, "2026-10-01");

      // Same-day replacement keeps stale markers.
      const third = buildResult("@ex", {
        channelId: "UC_1",
        date: "2026-10-02",
        videos: {
          a: { title: "A", views: 18, published: "2026-10-01" },
        },
      });
      store.saveChannel(third);
      const again = store.getChannel("@ex").records.find((r) => r.date === "2026-10-02");
      assert.equal(again.videoCountTracked, 2);
      assert.equal(again.videos.a.views, 18);
      assert.equal(again.videos.b.staleAt, "2026-10-01");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stable channelId merges aliases and old handles", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      store.saveChannel(buildResult("@old", { channelId: "UC_stable", date: "2026-10-01", videos: { x: { title: "X" } } }), {
        alias: "former",
      });

      // New configured handle for the same channel absorbs records and aliases.
      store.saveChannel(buildResult("@new", { channelId: "UC_stable", date: "2026-10-02", videos: { y: { title: "Y" } } }));

      const all = store.listChannels();
      assert.deepEqual(Object.keys(all), ["@new"]);

      const merged = store.getChannel("@new");
      assert.equal(merged.records.length, 2);
      assert.ok(merged.records.some((r) => r.videos.x));
      assert.ok(merged.records.some((r) => r.videos.y));

      assert.equal(store.getChannel("@old").info.name, "@new");
      assert.equal(store.getChannel("former"), null);
      assert.equal(store.getChannel("@OLD").info.name, "@new");
      assert.equal(store.resolveHandle("@OLD"), "@new");
      assert.equal(store.hasRecords("@OLD"), true);
      assert.equal(store.hasRecords("@missing"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first official save deduplicates migrated rows sharing stable channelId", async () => {
  const root = await tmpRoot();
  try {
    const history = {
      channels: {
        "@first": {
          info: { name: "First", channelId: "UC1111111111111111111111" },
          records: [{ date: "2026-09-01", videos: { v1: { title: "Older" } } }],
        },
        "@second": {
          info: { name: "Second", channelId: "UC1111111111111111111111" },
          records: [{ date: "2026-09-02", videos: { v2: { title: "Newer" } } }],
        },
      },
    };
    await writeFile(join(root, "data", "youtube-history.json"), JSON.stringify(history));
    const store = openStore({ root });
    try {
      store.saveChannel(buildResult("@second", {
        channelId: "UC1111111111111111111111", date: "2026-10-01", videos: {},
      }));
      assert.deepEqual(Object.keys(store.listChannels()), ["@second"]);
      assert.equal(store.getChannel("@first").records.length, 3);
      assert.equal(store.getChannel("UC1111111111111111111111").records.length, 3);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateMeta retains owner and deleteChannel blocks resurrection", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      store.saveChannel(buildResult("@ex", { channelId: "UC_2", date: "2026-10-01", videos: {} }), { owner: "alex" });
      store.updateMeta("@ex", { group: "tech" });
      const ch = store.getChannel("@ex");
      assert.equal(ch.info.owner, "alex");
      assert.equal(ch.info.group, "tech");

      assert.ok(store.deleteChannel("@ex"));
      assert.equal(store.getChannel("@ex"), null);
      assert.equal(store.updateMeta("@ex", { group: "x" }), null);

      // A running job completing later must not resurrect the deleted channel.
      const resurrect = store.saveChannel(buildResult("@ex", { channelId: "UC_2", date: "2026-10-02", videos: {} }));
      assert.equal(resurrect, null);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcileConfig removes channels safely and does not resurrect from running jobs", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      store.saveChannel(buildResult("@keep", { channelId: "UC_K", date: "2026-10-01", videos: {} }), { owner: "o1" });
      store.saveChannel(buildResult("@drop", { channelId: "UC_D", date: "2026-10-01", videos: {} }));

      // Start a job for the channel that will be removed.
      const job = store.enqueue("@drop", "full");
      const claimed = store.claim();
      assert.equal(claimed.id, job.id);

      // Config no longer contains @drop.
      const remaining = store.reconcileConfig([{ platform: "youtube", handle: "@keep", owner: "o1" }]);
      assert.equal(remaining.changed, true);
      assert.equal(store.getChannel("@drop"), null);

      // Completing the stale running job does not recreate @drop.
      const completed = store.saveChannel(buildResult("@drop", { channelId: "UC_D", date: "2026-10-02", videos: {} }));
      assert.equal(completed, null);
      assert.equal(Object.keys(store.listChannels()).length, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enqueue deduplicates pending/running by handle+kind and allows re-enqueue after terminal", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const j1 = store.enqueue("@a", "initial", { priority: 1 });
      const j2 = store.enqueue("@a", "initial", { priority: 2 });
      assert.equal(j1.id, j2.id);
      assert.deepEqual(j1.item, { priority: 1 });

      const j3 = store.enqueue("@a", "full");
      assert.notEqual(j3.id, j1.id);

      const claimed = store.claim();
      assert.equal(claimed.status, "running");
      const dupWhileRunning = store.enqueue("@a", "initial");
      assert.equal(dupWhileRunning.id, j1.id);

      store.setJob(j1.id, "complete", { result: { ok: true } });
      const j4 = store.enqueue("@a", "initial", { priority: 3 });
      assert.notEqual(j4.id, j1.id);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote request replay acknowledges original job even after terminal status", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const first = store.enqueue("@a", "initial", { requestId: "d1-1" });
      const coalesced = store.enqueue("@a", "initial", { requestId: "d1-2" });
      assert.equal(coalesced.id, first.id);
      store.claim();
      store.setJob(first.id, "complete");
      assert.equal(store.jobForRequest("d1-1").id, first.id);
      assert.equal(store.jobForRequest("d1-2").id, first.id);
      assert.equal(store.enqueue("@a", "initial", { requestId: "d1-1" }).id, first.id);
      assert.equal(store.enqueue("@a", "initial", { requestId: "d1-2" }).id, first.id);
      assert.notEqual(store.enqueue("@a", "initial", { requestId: "d1-3" }).id, first.id);
      assert.equal(store.jobForRequest("missing"), null);
    } finally {
      store.close();
    }
    const reopened = openStore({ root });
    try {
      assert.equal(reopened.jobForRequest("d1-2").status, "complete");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backfills request identities for jobs written before request indexing", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    const old = store.enqueue("@legacy", "refresh", { requestId: "older-d1" });
    store.close();
    const db = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
    try {
      db.exec("DELETE FROM job_requests; DELETE FROM meta WHERE key = 'job_requests_v1'");
    } finally {
      db.close();
    }
    const reopened = openStore({ root });
    try {
      assert.equal(reopened.jobForRequest("older-d1").id, old.id);
      assert.equal(reopened.enqueue("@legacy", "refresh", { requestId: "older-d1" }).id, old.id);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claim singleton lease and crash recovery by process liveness", async () => {
  const root = await tmpRoot();
  let otherDb = null;
  try {
    const store = openStore({ root });
    try {
      store.enqueue("@a", "full");
      store.enqueue("@b", "refresh");
      const claimed = store.claim();
      assert.ok(claimed);
      assert.equal(claimed.status, "running");

      // Even a different queued channel cannot be claimed while this PID lives.
      assert.equal(store.claim(), null);

      // Simulate a dead runner holding the lease via a separate DB connection.
      otherDb = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
      otherDb.prepare(
        "UPDATE jobs SET status='running', claimed_by=999999999, claimed_process='dead', updated_at=? WHERE id=?"
      ).run(nowISO(), claimed.id);

      // Claim recovers the dead lease and returns the same job.
      const recovered = store.claim();
      assert.ok(recovered);
      assert.equal(recovered.id, claimed.id);

      // Simulate a live runner (our own pid) holding the lease.
      otherDb.prepare(
        "UPDATE jobs SET status='running', claimed_by=?, claimed_process='live', updated_at=? WHERE id=?"
      ).run(process.pid, nowISO(), claimed.id);
      assert.equal(store.claim(), null);
    } finally {
      store.close();
      otherDb?.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function nowISO() {
  return new Date().toISOString();
}

test("collected result stays leased while publishing and survives dead-process takeover", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const job = store.enqueue("@a", "full");
      store.claim();

      const collected = store.setJob(job.id, "collected", { result: { videos: { v1: {} } } });
      assert.deepEqual(collected.result, { videos: { v1: {} } });

      // A live publisher blocks every queued job on another store connection.
      store.enqueue("@b", "refresh");
      const other = openStore({ root });
      try {
        assert.equal(other.claim(), null);
        const db = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
        try {
          db.prepare("UPDATE jobs SET claimed_by = 999999999 WHERE id = ?").run(job.id);
          const resumed = other.claim();
          assert.equal(resumed.id, job.id);
          assert.equal(resumed.status, "collected");
          assert.deepEqual(resumed.result, { videos: { v1: {} } });
          assert.equal(store.claim(), null);

          other.setJob(job.id, "publishing");
          assert.equal(store.claim(), null);
          db.prepare("UPDATE jobs SET claimed_by = 999999999 WHERE id = ?").run(job.id);
          const publishing = store.claim();
          assert.equal(publishing.id, job.id);
          assert.equal(publishing.status, "publishing");
          assert.deepEqual(publishing.result, { videos: { v1: {} } });
        } finally {
          db.close();
        }
      } finally {
        other.close();
      }

      // Publication failure returns to collected without collecting again.
      const retry = store.setJob(job.id, "collected", { error: "publish failed", release: true });
      assert.equal(retry.status, "collected");
      assert.equal(retry.error, "publish failed");
      assert.deepEqual(retry.result, { videos: { v1: {} } });
      const resumedLocally = store.claim();
      assert.equal(resumedLocally.id, job.id);
      assert.equal(resumedLocally.status, "collected");
      assert.deepEqual(resumedLocally.result, retry.result);
      store.setJob(job.id, "complete");
      assert.equal(store.claim().handle, "@b");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("getRevision increments on channel and job mutations", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const base = store.getRevision();
      store.saveChannel(buildResult("@ex", { channelId: "UC_R", date: "2026-10-01", videos: {} }));
      assert.equal(store.getRevision(), base + 1);
      store.updateMeta("@ex", { group: "g" });
      assert.equal(store.getRevision(), base + 2);
      const job = store.enqueue("@ex", "full");
      assert.equal(store.getRevision(), base + 3);
      store.claim();
      assert.equal(store.getRevision(), base + 4);
      store.setJob(job.id, "complete");
      assert.equal(store.getRevision(), base + 5);
      store.deleteChannel("@ex");
      assert.equal(store.getRevision(), base + 6);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple store instances serialize writes without corruption", async () => {
  const root = await tmpRoot();
  try {
    const storeA = openStore({ root });
    const storeB = openStore({ root });
    try {
      const job = storeA.enqueue("@multi", "full");
      const claimed = storeB.claim();
      assert.equal(claimed.id, job.id);
      storeA.setJob(job.id, "complete", { result: { ok: true } });
      const listed = storeB.jobs("@multi");
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, "complete");
      assert.deepEqual(listed[0].result, { ok: true });
    } finally {
      storeA.close();
      storeB.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveChannel refuses cross-owner channel identity conflict", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      store.saveChannel(
        buildResult("@alice", { channelId: "UC_shared", date: "2026-10-01", videos: { v1: { title: "A" } } }),
        { owner: "alice" }
      );

      // Same channelId under a different handle with a different owner must fail.
      assert.throws(
        () =>
          store.saveChannel(
            buildResult("@bob", { channelId: "UC_shared", date: "2026-10-02", videos: { v2: { title: "B" } } }),
            { owner: "bob" }
          ),
        (err) => err instanceof ChannelConflictError && err.existingOwner === "alice"
      );

      // Saving without an owner claim succeeds and keeps the existing owner/history.
      const kept = store.saveChannel(
        buildResult("@bob", { channelId: "UC_shared", date: "2026-10-02", videos: { v2: { title: "B" } } })
      );
      assert.equal(kept.info.owner, "alice");
      assert.equal(kept.records.length, 2);

      // Same owner is allowed.
      const same = store.saveChannel(
        buildResult("@alice-team", { channelId: "UC_shared", date: "2026-10-03", videos: {} }),
        { owner: "alice" }
      );
      assert.equal(same.info.owner, "alice");

      // Explicit admin transfer via updateMeta still works.
      store.updateMeta("@alice", { owner: "charlie" });
      assert.equal(store.getChannel("@alice").info.owner, "charlie");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcileConfig permits explicit owner transfer but ignores duplicate identity metadata", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      store.saveChannel(
        buildResult("@old", { channelId: "UC_shared", date: "2026-10-01", videos: {} }),
        { owner: "alice" }
      );
      store.saveChannel(buildResult("@canonical", {
        channelId: "UC_shared", date: "2026-10-02", videos: {},
      }), { owner: "alice" });

      // Old configured handle maps to the canonical channel but is not
      // authority to transfer its owner or recreate a second row.
      const aliasOnly = store.reconcileConfig([{ handle: "@old", owner: "mallory" }]);
      assert.equal(aliasOnly.changed, false);
      assert.deepEqual(Object.keys(store.listChannels()), ["@canonical"]);
      assert.equal(store.getChannel("@canonical").info.owner, "alice");

      // Exact canonical config is authenticated GitHub/admin intent.
      const transfer = store.reconcileConfig([{ handle: "@canonical", owner: "bob", alias: "ally" }]);
      assert.equal(transfer.changed, true);
      assert.equal(store.getChannel("@canonical").info.owner, "bob");
      assert.equal(store.getChannel("ally"), null);
      const revision = store.getRevision();
      assert.deepEqual(store.reconcileConfig([{ handle: "@canonical", owner: "bob", alias: "ally" }]),
        { changed: false, revision });
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publicationSnapshot includes content only for changed channel versions", async () => {
  const root = await tmpRoot();
  try {
    const store = openStore({ root });
    try {
      const avatarResult = buildResult("@a", {
        channelId: "UC_A", date: "2026-10-01", videos: { one: { title: "One", views: 1 } },
      });
      avatarResult.profile.avatar = "avatars/a.jpg";
      avatarResult.profile.avatarRemote = "https://example.com/a.jpg";
      store.saveChannel(avatarResult);
      store.saveChannel(buildResult("@b", {
        channelId: "UC_B", date: "2026-10-01", videos: { two: { title: "Two", views: 2 } },
      }));
      const first = store.publicationSnapshot();
      assert.deepEqual(JSON.parse(first.channels["@a"].content), store.getChannel("@a"));
      assert.deepEqual(JSON.parse(first.channels["@b"].content), store.getChannel("@b"));
      assert.equal(first.channels["@a"].info.avatar, "avatars/a.jpg");
      assert.equal(first.channels["@a"].info.avatarRemote, "https://example.com/a.jpg");

      const unchanged = store.publicationSnapshot(first.channels);
      assert.equal(unchanged.revision, first.revision);
      assert.equal(Object.hasOwn(unchanged.channels["@a"], "content"), false);
      assert.equal(Object.hasOwn(unchanged.channels["@b"], "content"), false);

      store.updateMeta("@a", { group: "review" });
      const changed = store.publicationSnapshot(first.channels);
      assert.ok(changed.channels["@a"].sourceVersion > first.channels["@a"].sourceVersion);
      assert.equal(JSON.parse(changed.channels["@a"].content).info.group, "review");
      assert.equal(Object.hasOwn(changed.channels["@b"], "content"), false);

      store.deleteChannel("@b");
      const afterDelete = store.publicationSnapshot(changed.channels);
      assert.deepEqual(Object.keys(afterDelete.channels), ["@a"]);
      assert.equal(Object.hasOwn(afterDelete.channels["@a"], "content"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opens an existing SQLite schema without versions and publishes its records", async () => {
  const root = await tmpRoot();
  try {
    const db = new DatabaseSync(join(root, "data", "dashboard.sqlite"));
    try {
      db.exec(`CREATE TABLE channels (
        handle TEXT PRIMARY KEY, channel_id TEXT, aliases TEXT NOT NULL,
        info TEXT NOT NULL, records TEXT NOT NULL, deleted_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.prepare("INSERT INTO channels VALUES (?, ?, ?, ?, ?, NULL, ?, ?)").run(
        "@legacy", null, "[]", JSON.stringify({ name: "Legacy" }),
        JSON.stringify([{ date: "2026-10-01", videos: { v1: { title: "Old" } } }]),
        nowISO(), nowISO()
      );
    } finally {
      db.close();
    }
    const store = openStore({ root });
    try {
      const first = store.publicationSnapshot();
      assert.equal(first.channels["@legacy"].sourceVersion, 1);
      assert.equal(JSON.parse(first.channels["@legacy"].content).records[0].videos.v1.title, "Old");
      store.updateMeta("@legacy", { group: "archived" });
      const changed = store.publicationSnapshot(first.channels);
      assert.equal(changed.channels["@legacy"].sourceVersion, 2);
      assert.equal(JSON.parse(changed.channels["@legacy"].content).info.group, "archived");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserveTrackedVideos exported helper behaves as documented", () => {
  const prev = {
    date: "2026-10-01",
    videos: {
      old: { title: "Old", views: 1 },
    },
  };
  const next = {
    date: "2026-10-02",
    videoCountTracked: 0,
    videos: {
      new: { title: "New", views: 2 },
    },
  };
  preserveTrackedVideos(next, prev);
  assert.equal(next.videoCountTracked, 2);
  assert.equal(next.videos.old.staleAt, "2026-10-01");
  assert.equal(next.videos.new.views, 2);
});
