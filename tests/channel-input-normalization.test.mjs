import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeYouTubeHandle } from "../assets/channel-input.mjs";

describe("normalizeYouTubeHandle", () => {
  it("accepts @handle", () => {
    assert.equal(normalizeYouTubeHandle("@mkbhd"), "@mkbhd");
  });

  it("adds @ to bare handle", () => {
    assert.equal(normalizeYouTubeHandle("mkbhd"), "@mkbhd");
  });

  it("accepts UC id", () => {
    assert.equal(normalizeYouTubeHandle("UCBa659QWEk1AI4Tg--mrJ2A"), "UCBa659QWEk1AI4Tg--mrJ2A");
  });

  it("extracts @handle from youtube.com/@ URL", () => {
    assert.equal(normalizeYouTubeHandle("https://www.youtube.com/@mkbhd"), "@mkbhd");
  });

  it("extracts UC id from /channel/ URL", () => {
    assert.equal(normalizeYouTubeHandle("https://youtube.com/channel/UCBa659QWEk1AI4Tg--mrJ2A"), "UCBa659QWEk1AI4Tg--mrJ2A");
  });

  it("rejects unsupported hosts", () => {
    assert.equal(normalizeYouTubeHandle("https://youtu.be/@mkbhd"), null);
  });

  it("rejects malformed URLs", () => {
    assert.equal(normalizeYouTubeHandle("https://youtube.com/@mkbhd/extra"), null);
  });

  it("normalizes unicode to NFC", () => {
    // é as e + combining acute -> NFC é
    const input = "https://youtube.com/@e\u0301tude";
    const out = normalizeYouTubeHandle(input);
    assert.equal(out, "@étude");
    assert.equal(out.normalize("NFC"), out);
  });

  it("accepts CJK handles", () => {
    assert.equal(normalizeYouTubeHandle("@小明视频"), "@小明视频");
  });

  it("rejects empty input", () => {
    assert.equal(normalizeYouTubeHandle(""), null);
    assert.equal(normalizeYouTubeHandle("   "), null);
    assert.equal(normalizeYouTubeHandle(null), null);
  });

  it("rejects invalid characters", () => {
    assert.equal(normalizeYouTubeHandle("@bad handle!"), null);
  });
});
