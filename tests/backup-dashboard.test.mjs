import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolate the backup key to a temp home dir so tests never touch ~/.config.
const home = mkdtempSync(path.join(tmpdir(), "backup-test-home-"));
process.env.HOME = home;
mkdirSync(path.join(home, ".config", "social-dashboard"), { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(home, ".config", "social-dashboard", "backup-key"),
  randomBytes(32).toString("base64"),
  { mode: 0o600 }
);

const {
  backup,
  restore,
  buildArchive,
  parseArchive,
  encryptArchive,
  decryptArchive,
} = await import("../scripts/backup-dashboard.mjs");

after(async () => {
  await rm(home, { recursive: true, force: true });
});

async function makeProject(root, { channels = [{ platform: "youtube", handle: "@mkbhd" }] } = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "channels.json"), JSON.stringify(channels));
  const { openStore } = await import("../scripts/dashboard-store.mjs");
  const store = openStore({ root });
  try {
    for (const ch of channels) {
      const name = ch.handle.startsWith("@") ? ch.handle.slice(1) : ch.handle;
      store.saveChannel({
        handle: ch.handle,
        profile: { name, owner: ch.owner ?? "test" },
        about: {},
        record: [
          {
            date: "2026-10-01",
            videoCountTracked: 1,
            videos: { v1: { views: 100 } },
          },
          {
            date: "2026-10-02",
            videoCountTracked: 2,
            videos: { v1: { views: 100 }, v2: { views: 200 } },
          },
        ],
        source: "test",
      });
    }
  } finally {
    store.close();
  }
  return root;
}

async function readCounts(dbPath) {
  const { getCounts } = await import("../scripts/backup-dashboard.mjs");
  const db = new DatabaseSync(dbPath, { open: false });
  try {
    db.open();
    return getCounts(db);
  } finally {
    db.close();
  }
}

test("backup creates encrypted file and restore recovers counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  const target = await mkdtemp(path.join(tmpdir(), "bk-target-"));
  try {
    await makeProject(root);
    const result = await backup({
      root,
      upload: false,
      localDir: path.join(root, "backups"),
    });
    assert.ok(result.localFile.endsWith(".enc"));
    assert.equal(result.counts.channels, 1);
    assert.equal(result.counts.records, 2);
    assert.equal(result.counts.videoSamples, 3);
    assert.equal(result.integrityCheck, "ok");

    const enc = await readFile(result.localFile);
    const text = enc.toString("binary");
    assert.ok(!text.includes("MKBHD"), "encrypted file must not contain plaintext channel name");
    assert.ok(!text.includes("@mkbhd"), "encrypted file must not contain plaintext handle");

    const restoreResult = await restore({ file: result.localFile, target });
    assert.equal(restoreResult.counts.channels, 1);
    assert.equal(restoreResult.counts.records, 2);
    assert.equal(restoreResult.counts.videoSamples, 3);

    const restoredDb = path.join(target, "data", "dashboard.sqlite");
    const counts = await readCounts(restoredDb);
    assert.deepEqual(counts, { channels: 1, records: 2, videoSamples: 3 });

    const restoredChannels = JSON.parse(await readFile(path.join(target, "channels.json"), "utf8"));
    assert.equal(restoredChannels[0].handle, "@mkbhd");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite non-empty target without --force", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  const target = await mkdtemp(path.join(tmpdir(), "bk-target-"));
  try {
    await makeProject(root);
    const result = await backup({ root, upload: false, localDir: path.join(root, "backups") });
    await writeFile(path.join(target, "existing.txt"), "x");
    await assert.rejects(
      () => restore({ file: result.localFile, target }),
      /target directory is not empty/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("local rotation keeps only the newest N backups", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  try {
    await makeProject(root);
    const backupsDir = path.join(root, "backups");
    for (let i = 0; i < 5; i++) {
      const r = await backup({ root, upload: false, localDir: backupsDir, keepLocal: 3 });
      assert.equal(r.removedLocal.length, i >= 3 ? 1 : 0);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const files = (await readdir(backupsDir)).filter((f) => f.endsWith(".enc"));
    assert.equal(files.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive roundtrip preserves file hashes and rejects wrong key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  try {
    await makeProject(root);
    const archive = await buildArchive({
      sqlitePath: path.join(root, "data", "dashboard.sqlite"),
      channelsPath: path.join(root, "channels.json"),
    });
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const wrongKey = Buffer.from("00000000000000000000000000000000", "utf8");
    const encrypted = encryptArchive(archive, key, { createdAt: new Date().toISOString() });

    const { archive: decrypted } = decryptArchive(encrypted, key);
    assert.deepEqual(decrypted, archive);

    const { files } = parseArchive(decrypted);
    assert.equal(files.length, 2);

    assert.throws(() => decryptArchive(encrypted, wrongKey));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite existing database even with --force", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  const target = await mkdtemp(path.join(tmpdir(), "bk-target-"));
  try {
    await makeProject(root);
    const result = await backup({ root, upload: false, localDir: path.join(root, "backups") });
    await mkdir(path.join(target, "data"), { recursive: true });
    await writeFile(path.join(target, "data", "dashboard.sqlite"), "existing");
    await assert.rejects(
      () => restore({ file: result.localFile, target, force: true }),
      /refusing to overwrite existing database file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("restore fails when backup key is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bk-root-"));
  const target = await mkdtemp(path.join(tmpdir(), "bk-target-"));
  const emptyHome = await mkdtemp(path.join(tmpdir(), "bk-empty-home-"));
  try {
    await makeProject(root);
    const result = await backup({ root, upload: false, localDir: path.join(root, "backups") });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const script = path.join(__dirname, "..", "scripts", "backup-dashboard.mjs");
    const env = { ...process.env, HOME: emptyHome };
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [script, "--restore", result.localFile, "--target", target],
          { env }
        ),
      /backup-key/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test("backup script CLI exits cleanly on --help", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const script = path.join(__dirname, "..", "scripts", "backup-dashboard.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--help"]);
  assert.ok(stdout.includes("--backup"));
  assert.ok(stdout.includes("--restore"));
  assert.ok(stdout.includes("--download"));
});
