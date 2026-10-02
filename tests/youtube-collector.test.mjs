import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  syncChannelInitial,
  syncChannelFull,
  syncChannelRefresh,
  apiVideo,
} from "../scripts/fetch-youtube.mjs";

import { tmpdir } from "node:os";

test("collector functions fail fast without API key", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "collector-no-key-"));
  const originalHome = process.env.HOME;
  const originalKey = process.env.YOUTUBE_API_KEY;
  process.env.HOME = home;
  delete process.env.YOUTUBE_API_KEY;
  try {
    await assert.rejects(syncChannelInitial("@test"), /YOUTUBE_API_KEY/);
    await assert.rejects(syncChannelFull("@test"), /YOUTUBE_API_KEY/);
    await assert.rejects(syncChannelRefresh("@test"), /YOUTUBE_API_KEY/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = originalKey;
    await rm(home, { recursive: true, force: true });
  }
});

test("apiVideo maps statistics and treats zero comments as 0", () => {
  const v = apiVideo({
    snippet: { title: "T", publishedAt: "2026-10-01T12:00:00Z" },
    statistics: { viewCount: "1234", likeCount: "75", commentCount: "0" },
    contentDetails: { duration: "PT2M3S" },
  });
  assert.equal(v.views, 1234);
  assert.equal(v.likes, 75);
  assert.equal(v.comments, 0);
  assert.equal(v.durationSec, 123);
  assert.equal(v.shorts, null);
  assert.equal(v.approx, false);
});

test("apiVideo leaves missing stats as null (private metrics)", () => {
  const v = apiVideo({
    snippet: { title: "T", publishedAt: "2026-10-01T12:00:00Z" },
    statistics: { viewCount: "100" },
    contentDetails: { duration: "PT1M" },
  });
  assert.equal(v.views, 100);
  assert.equal(v.likes, null);
  assert.equal(v.comments, null);
});

test("unclassified videos do not falsely claim Shorts or members-only status", () => {
  const v = apiVideo({ snippet: { title: "unknown" }, statistics: {} });
  assert.equal(v.shorts, null);
  assert.equal(v.membersOnly, null);
});
