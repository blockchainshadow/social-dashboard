import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const builder = fileURLToPath(new URL("../scripts/build-dashboard-index.mjs", import.meta.url));

test("dashboard index loads the selected channel and reflects changed and removed channels", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dashboard-index-"));
  try {
    await mkdir(path.join(dir, "data"));
    const source = path.join(dir, "data/youtube-history.json");
    const mkbhd = { info: { name: "MKBHD", owner: "alex" }, records: [{ date: "2026-10-01", subscribers: 21300000, videos: { first: { views: 42 } } }] };
    const small = { info: { name: "Small" }, records: [{ date: "2026-10-01", videos: {} }] };
    await writeFile(source, JSON.stringify({ updatedAt: "2026-10-01T00:00:00Z", channels: { "@mkbhd": mkbhd, "@small": small } }));
    execFileSync(process.execPath, [builder], { cwd: dir });
    const first = JSON.parse(await readFile(path.join(dir, "data/dashboard-index.json"), "utf8"));
    assert.deepEqual(Object.keys(first.channels), ["@mkbhd", "@small"]);
    assert.equal(first.channels["@mkbhd"].info.owner, "alex");
    const firstFile = path.join(dir, first.channels["@mkbhd"].path);
    assert.deepEqual(JSON.parse(await readFile(firstFile, "utf8")), mkbhd);

    const changed = { ...mkbhd, records: [{ ...mkbhd.records[0], subscribers: 21400000 }] };
    await writeFile(source, JSON.stringify({ updatedAt: "2026-10-02T00:00:00Z", channels: { "@mkbhd": changed } }));
    execFileSync(process.execPath, [builder], { cwd: dir });
    const next = JSON.parse(await readFile(path.join(dir, "data/dashboard-index.json"), "utf8"));
    assert.deepEqual(Object.keys(next.channels), ["@mkbhd"]);
    assert.equal(next.channels["@mkbhd"].path, first.channels["@mkbhd"].path);
    assert.notEqual(next.channels["@mkbhd"].version, first.channels["@mkbhd"].version);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, next.channels["@mkbhd"].path), "utf8")), changed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
