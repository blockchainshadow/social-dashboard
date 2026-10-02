import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIntoHistory } from "../scripts/fetch-youtube.mjs";

test("刷新仅抓到最近视频时保留此前视频及最后采集日期", () => {
  const old = {
    date: "2026-10-01",
    videoCountTracked: 2,
    videos: {
      recent: { title: "新视频", views: 10, published: "2026-10-01" },
      older: { title: "旧视频", views: 500, published: "2025-01-01" },
    },
  };
  const history = { channels: { "@example": { info: {}, records: [old] } } };
  const fresh = {
    date: "2026-10-02", videoCountTracked: 1,
    videos: { recent: { title: "新视频", views: 20, published: "2026-10-01" } },
  };
  mergeIntoHistory(history, { handle: "@example", profile: {}, about: {}, record: fresh });
  assert.equal(fresh.videoCountTracked, 2);
  assert.equal(fresh.videos.recent.views, 20);
  assert.equal(fresh.videos.recent.staleAt, undefined);
  assert.deepEqual(fresh.videos.older, { ...old.videos.older, staleAt: "2026-10-01" });
  assert.equal(old.videos.older.staleAt, undefined);

  const again = {
    date: "2026-10-02", videoCountTracked: 1,
    videos: { recent: { title: "新视频", views: 22, published: "2026-10-01" } },
  };
  mergeIntoHistory(history, { handle: "@example", profile: {}, about: {}, record: again });
  assert.equal(history.channels["@example"].records.length, 2);
  assert.equal(again.videoCountTracked, 2);
  assert.equal(again.videos.older.staleAt, "2026-10-01");
});
