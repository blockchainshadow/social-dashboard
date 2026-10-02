import { test } from "node:test";
import assert from "node:assert/strict";
import { apiVideo } from "../scripts/fetch-youtube.mjs";

test("videos.list statistics 的评论数进入公开明细，包括零条评论", () => {
  const video = apiVideo({
    snippet: { title: "示例", publishedAt: "2026-10-01T12:00:00Z" },
    statistics: { viewCount: "1234", likeCount: "75", commentCount: "0" },
    contentDetails: { duration: "PT2M3S" },
  });
  assert.equal(video.views, 1234);
  assert.equal(video.likes, 75);
  assert.equal(video.durationSec, 123);
  assert.equal(video.comments, 0);
  assert.equal(apiVideo({ statistics: {} }).comments, null);
});
