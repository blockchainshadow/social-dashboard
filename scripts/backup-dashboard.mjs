#!/usr/bin/env node
// Backup / restore for dashboard SQLite + channel config.
// Encrypted with AES-256-GCM using a locally generated key.
// Usage:
//   node scripts/backup-dashboard.mjs --backup [--upload] [--root <dir>]
//   node scripts/backup-dashboard.mjs --restore <file> --target <empty-dir> [--force]
//   node scripts/backup-dashboard.mjs --download <object-key> --target <dir> [--bucket <name>]

import {
  readFile,
  writeFile,
  mkdir,
  access,
  readdir,
  stat,
  unlink,
  chmod,
  rm,
  mkdtemp,
  constants,
} from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("SDBK"); // Social Dashboard Backup
const FORMAT_VERSION = 1;
function getKeyFile() {
  if (process.env.SOCIAL_DASHBOARD_BACKUP_KEY) {
    return path.resolve(process.env.SOCIAL_DASHBOARD_BACKUP_KEY);
  }
  return path.join(os.homedir(), ".config", "social-dashboard", "backup-key");
}

const DEFAULT_BUCKET = "social-dashboard-data";
const REMOTE_PREFIX = "backups/dashboard-";
const LOCAL_PREFIX = "dashboard-";
const LOCAL_SUFFIX = ".enc";
const WORKER_BASE = "https://dry-flower-a30f.xyxcliff.workers.dev";

// ---------------------------------------------------------------------------
// Config / secrets
// ---------------------------------------------------------------------------

function assertProjectBucket(bucket) {
  if (bucket !== DEFAULT_BUCKET) {
    throw new Error(`backup Worker is bound to ${DEFAULT_BUCKET}; bucket ${bucket} is not supported`);
  }
}

function getRunnerToken() {
  if (process.env.RUNNER_TOKEN) return process.env.RUNNER_TOKEN;
  const f = path.join(os.homedir(), ".config", "social-dashboard", "runner-token");
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
}

function getBucket() {
  return process.env.R2_BUCKET || DEFAULT_BUCKET;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

async function ensureKey() {
  const keyFile = getKeyFile();
  try {
    await access(keyFile, constants.F_OK);
    await chmod(keyFile, 0o600).catch(() => {});
    return;
  } catch {
    // generate
  }
  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    await writeFile(keyFile, key.toString("base64"), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      await chmod(keyFile, 0o600).catch(() => {});
      return;
    }
    throw err;
  }
  await chmod(keyFile, 0o600).catch(() => {});
}

async function loadKey({ allowGenerate = true } = {}) {
  if (allowGenerate) {
    await ensureKey();
  } else {
    try {
      await access(getKeyFile(), constants.R_OK);
    } catch {
      throw new Error(`backup-key not found: ${getKeyFile()}`);
    }
  }
  const text = await readFile(getKeyFile(), "utf8");
  const buf = Buffer.from(text.trim(), "base64");
  if (buf.length !== 32) throw new Error("backup-key is not 32 bytes");
  return buf;
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256FileSync(p) {
  return sha256Buffer(readFileSync(p));
}

function getCounts(db) {
  const channels = Number(
    db.prepare("SELECT count(*) AS n FROM channels WHERE deleted_at IS NULL").get().n
  );
  const records = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM channels, json_each(records) WHERE deleted_at IS NULL"
      )
      .get().n ?? 0
  );
  const videoSamples = Number(
    db
      .prepare(
        "SELECT sum(json_extract(value, '$.videoCountTracked')) AS n FROM channels, json_each(records) WHERE deleted_at IS NULL"
      )
      .get().n ?? 0
  );
  return { channels, records, videoSamples };
}

function runIntegrityCheck(db) {
  const row = db.prepare("PRAGMA integrity_check").get();
  return row["integrity_check"];
}

function sqlLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function vacuumSnapshot(sourcePath, targetPath) {
  const db = new DatabaseSync(sourcePath, { open: false });
  try {
    db.open();
    db.exec(`VACUUM INTO ${sqlLiteral(targetPath)}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Archive format (compressed, then encrypted)
// [magic:4][version:1][aadLen:4][AAD metadata JSON][iv:12][ciphertext][authTag:16]
// AAD is authenticated but not encrypted; it includes counts and integrity status.
// ---------------------------------------------------------------------------

async function buildArchive({ sqlitePath, channelsPath }) {
  const sqliteBuf = await readFile(sqlitePath);
  const channelsBuf = await readFile(channelsPath);
  const manifest = {
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    files: [
      {
        name: "data/dashboard.sqlite",
        size: sqliteBuf.length,
        sha256: sha256Buffer(sqliteBuf),
      },
      {
        name: "channels.json",
        size: channelsBuf.length,
        sha256: sha256Buffer(channelsBuf),
      },
    ],
  };
  const metaBuf = Buffer.from(JSON.stringify(manifest), "utf8");
  const header = Buffer.allocUnsafe(9);
  MAGIC.copy(header, 0);
  header[4] = FORMAT_VERSION;
  header.writeUInt32BE(metaBuf.length, 5);
  const archive = Buffer.concat([
    header,
    metaBuf,
    sqliteBuf,
    channelsBuf,
  ]);
  return deflateRawSync(archive);
}

function parseArchive(archiveBuffer) {
  const raw = inflateRawSync(archiveBuffer);
  if (raw.length < 9) throw new Error("archive too small");
  if (!raw.subarray(0, 4).equals(MAGIC)) throw new Error("bad archive magic");
  if (raw[4] !== FORMAT_VERSION) throw new Error("unsupported archive version");
  const metaLen = raw.readUInt32BE(5);
  const metaEnd = 9 + metaLen;
  if (raw.length < metaEnd) throw new Error("archive truncated (metadata)");
  const manifest = JSON.parse(raw.subarray(9, metaEnd).toString("utf8"));
  let offset = metaEnd;
  const files = [];
  for (const entry of manifest.files) {
    if (offset + entry.size > raw.length) throw new Error(`archive truncated (${entry.name})`);
    const data = raw.subarray(offset, offset + entry.size);
    offset += entry.size;
    const hash = sha256Buffer(data);
    if (hash !== entry.sha256) throw new Error(`hash mismatch for ${entry.name}`);
    files.push({ name: entry.name, data });
  }
  return { manifest, files };
}

function encryptArchive(archiveBuffer, key, extraMetadata = {}) {
  const iv = randomBytes(12);
  const aad = Buffer.from(
    JSON.stringify({
      version: FORMAT_VERSION,
      ...extraMetadata,
      archiveSha256: sha256Buffer(archiveBuffer),
      cipher: "aes-256-gcm",
    }),
    "utf8"
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(archiveBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const header = Buffer.allocUnsafe(9);
  MAGIC.copy(header, 0);
  header[4] = FORMAT_VERSION;
  header.writeUInt32BE(aad.length, 5);
  return Buffer.concat([header, aad, iv, ciphertext, authTag]);
}

function decryptArchive(encryptedBuffer, key) {
  if (encryptedBuffer.length < 9) throw new Error("encrypted file too small");
  if (!encryptedBuffer.subarray(0, 4).equals(MAGIC)) throw new Error("bad backup magic");
  if (encryptedBuffer[4] !== FORMAT_VERSION) throw new Error("unsupported backup version");
  const aadLen = encryptedBuffer.readUInt32BE(5);
  const aadEnd = 9 + aadLen;
  if (encryptedBuffer.length < aadEnd + 28) throw new Error("encrypted file truncated");
  const aad = encryptedBuffer.subarray(9, aadEnd);
  const metadata = JSON.parse(aad.toString("utf8"));
  const iv = encryptedBuffer.subarray(aadEnd, aadEnd + 12);
  const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
  const ciphertext = encryptedBuffer.subarray(aadEnd + 12, encryptedBuffer.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  decipher.setAAD(aad);
  const archive = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const archiveHash = sha256Buffer(archive);
  if (archiveHash !== metadata.archiveSha256) {
    throw new Error("archive integrity check failed after decrypt");
  }
  return { metadata, archive };
}

// ---------------------------------------------------------------------------
// R2 operations
// ---------------------------------------------------------------------------


async function workerRequest({ path, method = "GET", body }) {
  const token = getRunnerToken();
  if (!token) throw new Error("runner-token is required for remote retention");
  const url = new URL(path, WORKER_BASE).href;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Worker returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Worker error ${res.status}: ${data.error || text.slice(0, 200)}`);
  }
  return data;
}

function objectUrl(objectKey) {
  if (!isOwnBackupKey(objectKey)) throw new Error(`not a dashboard backup key: ${objectKey}`);
  return `${WORKER_BASE}/internal/backup-object?key=${encodeURIComponent(objectKey)}`;
}

async function uploadToWorker(localFile, objectKey, { bucket }) {
  assertProjectBucket(bucket);
  const token = getRunnerToken();
  if (!token) throw new Error("runner-token is required for backup upload");
  const size = (await stat(localFile)).size;
  const response = await fetch(objectUrl(objectKey), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    },
    body: createReadStream(localFile),
    duplex: "half",
  });
  if (!response.ok) throw new Error(`backup upload failed (HTTP ${response.status})`);
  const data = await response.json();
  if (data?.ok !== true) throw new Error("backup upload was not confirmed by Worker");
}

async function downloadFromWorker(objectKey, localFile, { bucket }) {
  assertProjectBucket(bucket);
  const token = getRunnerToken();
  if (!token) throw new Error("runner-token is required for backup download");
  const response = await fetch(objectUrl(objectKey), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`backup download failed (HTTP ${response.status})`);
  if (!response.body) throw new Error("backup download had no body");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(localFile, { flags: "wx", mode: 0o600 }));
}

function isOwnBackupKey(key) {
  return String(key).startsWith(REMOTE_PREFIX) && String(key).endsWith(LOCAL_SUFFIX);
}

async function listRemoteBackups() {
  const data = await workerRequest({ path: "/internal/backups" });
  if (!Array.isArray(data.objects)) throw new Error("backup Worker returned invalid object list");
  const objects = data.objects;
  return objects
    .filter((o) => isOwnBackupKey(o.key))
    .map((o) => ({
      key: String(o.key),
      uploaded: o.uploaded,
      size: Number(o.size || 0),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function deleteRemoteObject(objectKey) {
  if (!isOwnBackupKey(objectKey)) {
    throw new Error(`refusing to delete non-backup object: ${objectKey}`);
  }
  const data = await workerRequest({
    path: "/internal/backup-delete",
    method: "POST",
    body: { key: objectKey },
  });
  if (!data.ok) {
    throw new Error(`remote delete failed for ${objectKey}`);
  }
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

async function rotateLocal(backupsDir, keep) {
  let entries;
  try {
    entries = await readdir(backupsDir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (!name.startsWith(LOCAL_PREFIX) || !name.endsWith(LOCAL_SUFFIX)) continue;
    const p = path.join(backupsDir, name);
    const st = await stat(p);
    files.push({ path: p, mtime: st.mtimeMs });
  }
  files.sort((a, b) => a.mtime - b.mtime);
  const removed = [];
  while (files.length > keep) {
    const oldest = files.shift();
    await unlink(oldest.path);
    removed.push(oldest.path);
  }
  return removed;
}

async function rotateRemote(keep) {
  const objects = await listRemoteBackups();
  const removed = [];
  while (objects.length > keep) {
    const oldest = objects.shift();
    await deleteRemoteObject(oldest.key);
    removed.push(oldest.key);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function backup({
  root = process.cwd(),
  upload = false,
  localDir = path.join(root, "backups"),
  keepLocal = 7,
  keepRemote = 30,
  bucket = getBucket(),
} = {}) {
  if (upload) assertProjectBucket(bucket);
  const dbPath = path.join(root, "data", "dashboard.sqlite");
  const channelsPath = path.join(root, "channels.json");

  await access(dbPath, constants.R_OK);
  await access(channelsPath, constants.R_OK);

  const stamp = `${new Date().toISOString().replace(/[:T]/g, "-").replace("Z", "")}-${randomBytes(4).toString("hex")}`;
  const fileName = `${LOCAL_PREFIX}${stamp}${LOCAL_SUFFIX}`;
  const localFile = path.join(localDir, fileName);

  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const tmpDir = await mkdtemp(path.join(tmpdir(), "dash-backup-"));
  const snapshotPath = path.join(tmpDir, "snapshot.sqlite");

  try {
    await vacuumSnapshot(dbPath, snapshotPath);

    const snapshotDb = new DatabaseSync(snapshotPath, { open: false });
    let integrity;
    let counts;
    try {
      snapshotDb.open();
      integrity = runIntegrityCheck(snapshotDb);
      counts = getCounts(snapshotDb);
    } finally {
      snapshotDb.close();
    }

    if (integrity !== "ok") {
      throw new Error(`source integrity check failed: ${integrity}`);
    }

    const archive = await buildArchive({
      sqlitePath: snapshotPath,
      channelsPath,
    });
    const key = await loadKey({ allowGenerate: true });
    const encrypted = encryptArchive(archive, key, {
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
      integrityCheck: integrity,
      counts,
      sourceDb: "data/dashboard.sqlite",
      sourceChannels: "channels.json",
    });

    await writeFile(localFile, encrypted, { mode: 0o600, flag: "wx" });

    const removedLocal = await rotateLocal(localDir, keepLocal);

    let remoteKey = null;
    let removedRemote = [];
    if (upload) {
      remoteKey = `${REMOTE_PREFIX}${stamp}${LOCAL_SUFFIX}`;
      await uploadToWorker(localFile, remoteKey, { bucket });
      removedRemote = await rotateRemote(keepRemote);
    }

    return {
      localFile,
      remoteKey,
      counts,
      integrityCheck: integrity,
      removedLocal,
      removedRemote,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Restore / download
// ---------------------------------------------------------------------------

async function ensureEmptyTarget(target, force) {
  const dbPath = path.join(target, "data", "dashboard.sqlite");
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      await access(p, constants.F_OK);
      throw new Error(`refusing to overwrite existing database file: ${p}`);
    } catch (err) {
      if (err.message.startsWith("refusing to overwrite")) throw err;
    }
  }

  let entries;
  try {
    entries = await readdir(target);
  } catch {
    await mkdir(target, { recursive: true });
    return;
  }
  const relevant = entries.filter((e) => e !== "." && e !== "..");
  if (relevant.length > 0 && !force) {
    throw new Error(`target directory is not empty: ${target}`);
  }
}

async function restore({ file, target, force = false }) {
  await ensureEmptyTarget(target, force);
  const encrypted = await readFile(file);
  const key = await loadKey({ allowGenerate: false });
  const { metadata, archive } = decryptArchive(encrypted, key);
  const { manifest, files } = parseArchive(archive);

  const sqliteEntry = files.find((f) => f.name === "data/dashboard.sqlite");
  const channelsEntry = files.find((f) => f.name === "channels.json");
  if (!sqliteEntry || !channelsEntry) {
    throw new Error("archive missing required files");
  }

  const targetDbDir = path.join(target, "data");
  await mkdir(targetDbDir, { recursive: true });
  const targetDb = path.join(targetDbDir, "dashboard.sqlite");
  const targetChannels = path.join(target, "channels.json");

  await writeFile(targetDb, sqliteEntry.data);
  await writeFile(targetChannels, channelsEntry.data);

  const verifyDb = new DatabaseSync(targetDb, { open: false });
  let integrity;
  let counts;
  try {
    verifyDb.open();
    integrity = runIntegrityCheck(verifyDb);
    counts = getCounts(verifyDb);
  } finally {
    verifyDb.close();
  }

  if (integrity !== "ok") {
    throw new Error(`restored database integrity check failed: ${integrity}`);
  }
  const expectedCounts = metadata.counts || manifest.counts;
  if (expectedCounts) {
    if (counts.channels !== expectedCounts.channels || counts.records !== expectedCounts.records) {
      throw new Error(
        `restored counts mismatch: got ${JSON.stringify(counts)}, expected ${JSON.stringify(
          expectedCounts
        )}`
      );
    }
  }

  return { target, metadata, manifest, counts, integrityCheck: integrity };
}

async function download({ object, target, bucket = getBucket() }) {
  assertProjectBucket(bucket);
  if (!isOwnBackupKey(object)) throw new Error(`not a dashboard backup key: ${object}`);
  await ensureEmptyTarget(target, false);
  const tmpDir = await mkdtemp(path.join(tmpdir(), "dash-download-"));
  const localFile = path.join(tmpDir, path.basename(object));
  try {
    await downloadFromWorker(object, localFile, { bucket });
    return await restore({ file: localFile, target, force: false });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Backup dashboard SQLite + channel config (AES-256-GCM encrypted).

Key file: ${getKeyFile()}

Usage:
  node scripts/backup-dashboard.mjs --backup [options]
  node scripts/backup-dashboard.mjs --restore <file> --target <dir> [--force]
  node scripts/backup-dashboard.mjs --download <r2-object-key> --target <dir> [options]

Options:
  --backup                 Create local encrypted snapshot (default action).
  --upload                 Also upload to R2.
  --root <dir>             Project root (default cwd).
  --local-dir <dir>        Local backup directory (default <root>/backups).
  --keep-local <n>         Keep this many local backups (default 7).
  --keep-remote <n>        Keep this many remote backups (default 30).
  --bucket <name>          R2 bucket (default social-dashboard-data).
  --restore <file>         Decrypt and verify backup into --target.
  --download <object>      Download object from R2, then restore into --target.
  --target <dir>           Restore target directory.
  --force                  Allow restore into non-empty target.
  --help                   Show this help.`);
}

function parseArgs(argv) {
  const args = {
    backup: false,
    upload: false,
    restore: null,
    download: null,
    target: null,
    force: false,
    root: process.cwd(),
    localDir: null,
    keepLocal: 7,
    keepRemote: 30,
    bucket: getBucket(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--backup":
        args.backup = true;
        break;
      case "--upload":
        args.upload = true;
        break;
      case "--restore":
        args.restore = next();
        break;
      case "--download":
        args.download = next();
        break;
      case "--target":
        args.target = next();
        break;
      case "--force":
        args.force = true;
        break;
      case "--root":
        args.root = next();
        break;
      case "--local-dir":
        args.localDir = next();
        break;
      case "--keep-local":
        args.keepLocal = Number(next());
        break;
      case "--keep-remote":
        args.keepRemote = Number(next());
        break;
      case "--bucket":
        args.bucket = next();
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.backup && !args.restore && !args.download) {
    args.backup = true;
  }
  if (args.localDir == null) {
    args.localDir = path.join(args.root, "backups");
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.restore) {
    if (!args.target) throw new Error("--target is required for restore");
    const result = await restore({
      file: args.restore,
      target: args.target,
      force: args.force,
    });
    console.log(`restored to ${result.target}`);
    console.log(`counts channels=${result.counts.channels} records=${result.counts.records}`);
    console.log(`integrity ${result.integrityCheck}`);
    return;
  }

  if (args.download) {
    if (!args.target) throw new Error("--target is required for download");
    const result = await download({
      object: args.download,
      target: args.target,
      bucket: args.bucket,
    });
    console.log(`downloaded and restored to ${result.target}`);
    console.log(`counts channels=${result.counts.channels} records=${result.counts.records}`);
    console.log(`integrity ${result.integrityCheck}`);
    return;
  }

  const result = await backup({
    root: args.root,
    upload: args.upload,
    localDir: args.localDir,
    keepLocal: args.keepLocal,
    keepRemote: args.keepRemote,
    bucket: args.bucket,
  });
  console.log(`backup ${result.localFile}`);
  if (result.remoteKey) console.log(`uploaded r2://${args.bucket}/${result.remoteKey}`);
  console.log(`counts channels=${result.counts.channels} records=${result.counts.records}`);
  console.log(`integrity ${result.integrityCheck}`);
  if (result.removedLocal.length) console.log(`rotated local: ${result.removedLocal.join(", ")}`);
  if (result.removedRemote.length) console.log(`rotated remote: ${result.removedRemote.join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

export {
  backup,
  restore,
  download,
  ensureKey,
  loadKey,
  buildArchive,
  parseArchive,
  encryptArchive,
  decryptArchive,
  vacuumSnapshot,
  getCounts,
};
