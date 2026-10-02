#!/usr/bin/env node
// Authoritative SQLite-backed dashboard store (node:sqlite, WAL).
// Synchronous API so callers can use it without awaiting open.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const VALID_KINDS = new Set(["initial", "full", "refresh"]);
const VALID_STATUSES = new Set([
  "queued",
  "running",
  "collected",
  "publishing",
  "complete",
  "failed",
]);

function nowISO() {
  return new Date().toISOString();
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: invalid JSON (${e.message})`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityKey(handle) {
  const value = String(handle).normalize("NFC");
  return value.startsWith("@") ? value.toLowerCase() : value;
}

function isIdentityAlias(alias) {
  return typeof alias === "string" &&
    (/^@[\p{L}\p{M}\p{N}_.\-·]{1,40}$/u.test(alias) || /^UC[\w-]{22}$/.test(alias));
}

function validateHistory(history, filename) {
  if (!isObject(history) || !isObject(history.channels)) {
    throw new Error(`${filename}: expected object with channels object`);
  }
  for (const [handle, channel] of Object.entries(history.channels)) {
    if (!handle || !isObject(channel) || !isObject(channel.info) || !Array.isArray(channel.records)) {
      throw new Error(`${filename}: invalid channel ${handle}`);
    }
    for (const record of channel.records) {
      if (!isObject(record) || typeof record.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !isObject(record.videos)) {
        throw new Error(`${filename}: invalid record in ${handle}`);
      }
      const date = new Date(`${record.date}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== record.date) {
        throw new Error(`${filename}: invalid record date in ${handle}`);
      }
      for (const video of Object.values(record.videos)) {
        if (!isObject(video)) throw new Error(`${filename}: invalid video in ${handle}/${record.date}`);
      }
    }
  }
}

function json(value) {
  return JSON.stringify(value);
}

function isAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processToken() {
  return `${os.hostname()}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export class ChannelConflictError extends Error {
  code = "CHANNEL_CONFLICT";
  constructor(message, { existingHandle, existingOwner } = {}) {
    super(message);
    this.existingHandle = existingHandle;
    this.existingOwner = existingOwner;
  }
}

function sanitizeJob(row) {
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    status: row.status,
    item: row.item ? parseJson(row.item, `job#${row.id} item`) : {},
    result: row.result ? parseJson(row.result, `job#${row.id} result`) : null,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Merge missing videos from a previous record into the new record.
export function preserveTrackedVideos(record, previous) {
  if (!previous?.videos) return record;
  for (const [id, video] of Object.entries(previous.videos)) {
    if (!Object.hasOwn(record.videos, id)) {
      record.videos[id] = { ...video, staleAt: video.staleAt ?? previous.date };
    }
  }
  record.videoCountTracked = Object.keys(record.videos).length;
  return record;
}

// Combine old records (from zero or more existing rows) with the incoming
// records. Same-day incoming records replace old ones, but missing videos are
// preserved with staleAt pointing at the previous record's date.
function mergeRecordArrays(incomingRecords, ...oldArrays) {
  const byDate = new Map();
  for (const arr of oldArrays) {
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec?.date) continue;
      const existing = byDate.get(rec.date);
      if (existing) {
        // Unlikely: two records for the same date; union stale videos.
        preserveTrackedVideos(existing, rec);
      } else {
        byDate.set(rec.date, structuredClone(rec));
      }
    }
  }
  for (const rec of incomingRecords ?? []) {
    if (!rec?.date) continue;
    // Find the most recent old record with date <= this record to carry forward
    // videos that have disappeared (marked as staleAt).
    let previous = null;
    for (const [date, oldRec] of byDate) {
      if (date <= rec.date && (!previous || date > previous.date)) previous = oldRec;
    }
    if (previous) {
      preserveTrackedVideos(rec, previous);
    }
    byDate.set(rec.date, rec);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mergeInfo(existing = {}, profile = {}, about = {}, meta = {}) {
  const out = structuredClone(existing);

  const profileFields = [
    "name",
    "channelId",
    "canonicalUrl",
    "description",
    "rssUrl",
    "avatar",
    "avatarRemote",
    "isFamilySafe",
    "availableCountryCodes",
  ];
  for (const key of profileFields) {
    if (profile[key] !== undefined && profile[key] !== null) out[key] = profile[key];
  }
  if (Array.isArray(profile.keywords) && profile.keywords.length) out.keywords = profile.keywords;
  if (out.avatar?.startsWith("http")) out.avatarRemote = out.avatar;

  if (about.country) out.country = about.country;
  if (about.joinedDate) out.joinedDate = about.joinedDate;
  if (Array.isArray(about.links) && about.links.length) out.links = about.links;

  if (typeof meta.alias === "string" && meta.alias.trim()) out.alias = meta.alias.trim().slice(0, 50);
  else if (meta.alias === "" || meta.alias === null || meta.alias === false) delete out.alias;

  if (typeof meta.group === "string" && meta.group.trim()) out.group = meta.group.trim().slice(0, 30);
  else if (meta.group === "" || meta.group === null || meta.group === false) delete out.group;

  if (Array.isArray(meta.tags)) {
    const tags = [...new Set(meta.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
    if (tags.length) out.tags = tags;
    else delete out.tags;
  }

  if (typeof meta.owner === "string" && meta.owner.trim()) out.owner = meta.owner.trim();
  // owner is intentionally retained when not supplied.

  return out;
}

function openStore({ root = process.cwd() } = {}) {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "dashboard.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  if (db.prepare("PRAGMA journal_mode").get().journal_mode.toLowerCase() !== "wal") {
    db.close();
    throw new Error(`SQLite WAL unavailable: ${dbPath}`);
  }
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  function secureSqliteFiles() {
    for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(filename)) chmodSync(filename, 0o600);
    }
  }
  secureSqliteFiles();

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0'), ('imported', '0');

    CREATE TABLE IF NOT EXISTS channels (
      handle TEXT PRIMARY KEY,
      channel_id TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      info TEXT NOT NULL DEFAULT '{}',
      records TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_channels_channel_id ON channels(channel_id);
    CREATE INDEX IF NOT EXISTS idx_channels_deleted ON channels(deleted_at);

    CREATE TABLE IF NOT EXISTS aliases (
      alias TEXT PRIMARY KEY,
      handle TEXT NOT NULL REFERENCES channels(handle) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_handle ON aliases(handle);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      item TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      claimed_by INTEGER,
      claimed_process TEXT,
      CHECK (kind IN ('initial', 'full', 'refresh')),
      CHECK (status IN ('queued', 'running', 'collected', 'publishing', 'complete', 'failed'))
    );
    CREATE TABLE IF NOT EXISTS job_requests (
      request_id TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_handle_status ON jobs(handle, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
  `);
  const hasVersion = () => db.prepare("PRAGMA table_info(channels)").all()
    .some((column) => column.name === "version");
  if (!hasVersion()) {
    try {
      db.exec("ALTER TABLE channels ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    } catch (error) {
      // Another process may have completed this one-time schema migration.
      if (!hasVersion()) throw error;
    }
  }
  secureSqliteFiles();

  // DatabaseSync has no .transaction() method in Node v22, so we manage
  // transactions manually. Methods do not nest transactions; this helper
  // simply guarantees COMMIT/ROLLBACK pairing for the current operation.
  function runInTx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      secureSqliteFiles();
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  const stmts = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("UPDATE meta SET value = ? WHERE key = ?"),
    bumpRevision: db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'"),

    getChannelByHandle: db.prepare("SELECT * FROM channels WHERE handle = ?"),
    getChannelsById: db.prepare("SELECT * FROM channels WHERE channel_id = ? AND deleted_at IS NULL"),
    resolveHandle: db.prepare("SELECT handle, deleted_at FROM channels WHERE handle = ?"),
    resolveById: db.prepare("SELECT handle FROM channels WHERE channel_id = ? AND deleted_at IS NULL"),
    resolveAlias: db.prepare("SELECT handle FROM aliases WHERE alias = ?"),
    insertAlias: db.prepare("INSERT OR REPLACE INTO aliases (alias, handle, created_at) VALUES (?, ?, ?)"),
    deleteAliasesForHandle: db.prepare("DELETE FROM aliases WHERE handle = ?"),
    hasRecords: db.prepare(
      "SELECT json_array_length(records) > 0 AS present FROM channels WHERE handle = ? AND deleted_at IS NULL"
    ),

    insertChannel: db.prepare(
      "INSERT INTO channels (handle, channel_id, aliases, info, records, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)"
    ),
    updateChannel: db.prepare(
      "UPDATE channels SET channel_id = ?, aliases = ?, info = ?, records = ?, deleted_at = NULL, updated_at = ?, version = version + 1 WHERE handle = ?"
    ),
    softDeleteChannel: db.prepare("UPDATE channels SET deleted_at = ?, updated_at = ? WHERE handle = ?"),

    getJobsByHandleStatus: db.prepare(
      "SELECT * FROM jobs WHERE handle = ? AND kind = ? AND status IN ('queued','running','collected','publishing') ORDER BY id LIMIT 1"
    ),
    insertJob: db.prepare(
      "INSERT INTO jobs (handle, kind, status, item, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)"
    ),
    getJobById: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    getJobByRequest: db.prepare(
      "SELECT jobs.* FROM job_requests JOIN jobs ON jobs.id = job_requests.job_id WHERE job_requests.request_id = ?"
    ),
    mapRequestToJob: db.prepare("INSERT INTO job_requests(request_id, job_id) VALUES(?, ?)"),
    getLeasedJobs: db.prepare("SELECT id, status, claimed_by FROM jobs WHERE status IN ('running','collected','publishing') ORDER BY id"),
    getNextQueued: db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1"),
    claimJob: db.prepare(
      "UPDATE jobs SET status = 'running', claimed_at = ?, claimed_by = ?, claimed_process = ?, updated_at = ? WHERE id = ? AND status = 'queued'"
    ),
    takeOverJob: db.prepare(
      "UPDATE jobs SET claimed_at = ?, claimed_by = ?, claimed_process = ?, updated_at = ? WHERE id = ? AND status IN ('collected','publishing')"
    ),
    requeueDeadJob: db.prepare(
      "UPDATE jobs SET status = 'queued', claimed_at = NULL, claimed_by = NULL, claimed_process = NULL, updated_at = ? WHERE id = ?"
    ),
    updateJob: db.prepare(
      "UPDATE jobs SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error), updated_at = ?, claimed_at = ?, claimed_by = ?, claimed_process = ? WHERE id = ?"
    ),
    listChannels: db.prepare("SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY handle"),
    listJobs: db.prepare("SELECT * FROM jobs ORDER BY created_at ASC, id ASC"),
    listJobsByHandle: db.prepare("SELECT * FROM jobs WHERE handle = ? ORDER BY created_at ASC, id ASC"),
  };
  if (stmts.getMeta.get("job_requests_v1")?.value !== "1") {
    runInTx(() => {
      db.exec(`INSERT OR IGNORE INTO job_requests(request_id, job_id)
        SELECT json_extract(item, '$.requestId'), id FROM jobs
        WHERE json_valid(item) AND json_type(item, '$.requestId') = 'text'
          AND length(trim(json_extract(item, '$.requestId'))) > 0
        ORDER BY id`);
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('job_requests_v1', '1')").run();
    });
  }


  function getRevision() {
    return Number(stmts.getMeta.get("revision").value);
  }

  function setImported() {
    stmts.setMeta.run("1", "imported");
  }

  function importHistoryIfPresent() {
    const imported = stmts.getMeta.get("imported").value;
    if (imported === "1") return;
    const historyFile = join(dataDir, "youtube-history.json");
    if (!existsSync(historyFile)) {
      setImported();
      return;
    }
    const raw = readFileSync(historyFile, "utf8");
    const history = parseJson(raw, historyFile);
    validateHistory(history, historyFile);

    runInTx(() => {
      for (const [handle, ch] of Object.entries(history.channels)) {
        const created = nowISO();
        stmts.insertChannel.run(
          handle,
          ch.info.channelId ?? null,
          "[]",
          json(ch.info),
          json(ch.records),
          created,
          created
        );
      }
      stmts.bumpRevision.run();
      setImported();
    });
  }

  importHistoryIfPresent();
  // One-time cleanup for DBs imported by the earlier alias scheme: info.alias
  // is a display label, never a second identity. Keep real prior handles/IDs.
  if (stmts.getMeta.get("identity_aliases_v2")?.value !== "1") {
    runInTx(() => {
      let changed = false;
      db.prepare("DELETE FROM aliases").run();
      for (const row of db.prepare("SELECT handle, aliases, info FROM channels").all()) {
        const stored = parseJson(row.aliases, `channel ${row.handle} aliases`);
        const display = parseJson(row.info, `channel ${row.handle} info`).alias;
        const filtered = stored.filter((alias) => isIdentityAlias(alias) && alias !== display);
        if (json(filtered) !== row.aliases) {
          db.prepare("UPDATE channels SET aliases = ? WHERE handle = ?").run(json(filtered), row.handle);
          changed = true;
        }
        for (const alias of filtered) stmts.insertAlias.run(identityKey(alias), row.handle, nowISO());
      }
      if (changed) stmts.bumpRevision.run();
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('identity_aliases_v2', '1')").run();
    });
  }

  function resolveCanonical(handle) {
    if (!handle) return null;
    const key = identityKey(handle);
    const active = stmts.resolveHandle.get(handle);
    if (active && !active.deleted_at) return active.handle;
    if (/^UC[\w-]{22}$/.test(key)) {
      const byId = stmts.resolveById.get(key);
      if (byId) return byId.handle;
    }
    const alias = stmts.resolveAlias.get(key);
    const target = alias && stmts.resolveHandle.get(alias.handle);
    if (target && !target.deleted_at) return target.handle;
    if (key.startsWith("@")) {
      for (const row of db.prepare("SELECT handle FROM channels WHERE deleted_at IS NULL").iterate()) {
        if (identityKey(row.handle) === key) return row.handle;
      }
    }
    return null;
  }

  function getChannel(handle) {
    const canonical = resolveCanonical(handle);
    if (!canonical) return null;
    const row = stmts.getChannelByHandle.get(canonical);
    if (!row || row.deleted_at) return null;
    return {
      info: parseJson(row.info, `channel ${canonical} info`),
      records: parseJson(row.records, `channel ${canonical} records`),
    };
  }

  function hasRecords(handle) {
    const canonical = resolveCanonical(handle);
    return canonical ? Boolean(stmts.hasRecords.get(canonical)?.present) : false;
  }

  function listChannels() {
    const out = {};
    for (const row of stmts.listChannels.iterate()) {
      out[row.handle] = {
        info: parseJson(row.info, `channel ${row.handle} info`),
        records: parseJson(row.records, `channel ${row.handle} records`),
      };
    }
    return out;
  }

  function syncAliasesForHandle(canonical, aliasList) {
    stmts.deleteAliasesForHandle.run(canonical);
    const seen = new Set([canonical]);
    for (const alias of aliasList) {
      if (!isIdentityAlias(alias)) continue;
      const a = identityKey(alias);
      if (seen.has(a)) continue;
      seen.add(a);
      stmts.insertAlias.run(a, canonical, nowISO());
    }
  }

  function saveChannel(result, meta = {}) {
    return runInTx(() => {
      const inputHandle = result.handle;
      if (!inputHandle) throw new Error("saveChannel: result.handle required");
      const resolved = resolveCanonical(inputHandle);
      const canonicalHandle = resolved ?? inputHandle;
      const profile = result.profile ?? {};
      const about = result.about ?? {};
      const incomingRecords = Array.isArray(result.record)
        ? result.record
        : result.record
        ? [result.record]
        : [];
      const channelId = profile.channelId ?? null;

      // Prevent resurrection of deliberately deleted channels.
      const deleted = db.prepare("SELECT handle FROM channels WHERE handle = ? AND deleted_at IS NOT NULL").get(inputHandle);
      if (deleted && !resolved) return null;

      // A known prior handle stays mapped to the existing canonical row.
      const byHandle = stmts.getChannelByHandle.get(canonicalHandle);
      const byIds = channelId ? stmts.getChannelsById.all(channelId) : [];
      const byId = byIds[0] ?? null;

      const matches = new Map();
      if (byHandle && !byHandle.deleted_at) matches.set(byHandle.handle, byHandle);
      for (const row of byIds) matches.set(row.handle, row);

      const oldRecordArrays = [];
      let mergedInfo = {};
      const oldHandles = [];
      for (const row of matches.values()) {
        oldRecordArrays.push(parseJson(row.records, `channel ${row.handle} records`));
        const existingInfo = parseJson(row.info, `channel ${row.handle} info`);
        // Security: a different nonempty owner on the same channel identity is a
        // conflict. Explicit owner transfers go through updateMeta (admin API).
        if (existingInfo.owner && (
          (meta.owner && existingInfo.owner !== meta.owner) ||
          (mergedInfo.owner && existingInfo.owner !== mergedInfo.owner)
        )) {
          throw new ChannelConflictError(
            `channel ${inputHandle} conflicts with existing owner ${existingInfo.owner} on ${row.handle}`,
            { existingHandle: row.handle, existingOwner: existingInfo.owner }
          );
        }
        // Shallow-merge existing info so owner/avatar/links/etc. are retained.
        mergedInfo = { ...mergedInfo, ...existingInfo };
        if (row.handle !== canonicalHandle) oldHandles.push(row.handle);
      }

      const records = mergeRecordArrays(incomingRecords, ...oldRecordArrays);
      const info = mergeInfo(mergedInfo, profile, about, meta);

      // Keep the best available stable channel id (incoming wins, then existing).
      const effectiveChannelId = channelId ?? byHandle?.channel_id ?? byId?.channel_id ?? null;

      const aliasSet = new Set();
      for (const h of oldHandles) aliasSet.add(h);
      if (inputHandle !== canonicalHandle) aliasSet.add(inputHandle);
      for (const row of matches.values()) {
        for (const a of parseJson(row.aliases, `channel ${row.handle} aliases`)) aliasSet.add(a);
      }
      const aliases = [...aliasSet].filter(isIdentityAlias);

      const now = nowISO();
      const infoJson = json(info);
      const recordsJson = json(records);
      const aliasesJson = json(aliases);
      let changed = false;
      if (byHandle && !byHandle.deleted_at) {
        if (byHandle.info !== infoJson || byHandle.records !== recordsJson) {
          stmts.updateChannel.run(effectiveChannelId, aliasesJson, infoJson, recordsJson, now, canonicalHandle);
          changed = true;
        } else if (byHandle.channel_id !== effectiveChannelId || byHandle.aliases !== aliasesJson) {
          db.prepare("UPDATE channels SET channel_id = ?, aliases = ?, updated_at = ? WHERE handle = ?")
            .run(effectiveChannelId, aliasesJson, now, canonicalHandle);
          changed = true;
        }
      } else {
        stmts.insertChannel.run(canonicalHandle, effectiveChannelId, aliasesJson, infoJson, recordsJson, now, now);
        changed = true;
      }
      for (const oldHandle of oldHandles) {
        db.prepare("DELETE FROM channels WHERE handle = ?").run(oldHandle);
        changed = true;
      }
      if (changed) {
        syncAliasesForHandle(canonicalHandle, aliases);
        stmts.bumpRevision.run();
      }
      return getChannel(canonicalHandle);
    });
  }

  function updateMeta(handle, meta) {
    return runInTx(() => {
      const canonical = resolveCanonical(handle);
      if (!canonical) return null;
      const row = stmts.getChannelByHandle.get(canonical);
      const info = mergeInfo(parseJson(row.info, `channel ${canonical} info`), {}, {}, meta);
      if (row.info !== json(info)) {
        db.prepare("UPDATE channels SET info = ?, version = version + 1, updated_at = ? WHERE handle = ?")
          .run(json(info), nowISO(), canonical);
        stmts.bumpRevision.run();
      }
      return getChannel(canonical);
    });
  }

  function deleteChannel(handle) {
    return runInTx(() => {
      const canonical = resolveCanonical(handle);
      if (!canonical) return false;
      const now = nowISO();
      stmts.softDeleteChannel.run(now, now, canonical);
      stmts.deleteAliasesForHandle.run(canonical);
      db.prepare("DELETE FROM aliases WHERE alias = ?").run(canonical);
      stmts.bumpRevision.run();
      return true;
    });
  }

  function reconcileConfig(config) {
    return runInTx(() => {
      const desired = new Map();
      for (const input of Array.isArray(config) ? config : []) {
        const entry = typeof input === "string" ? { handle: input } : input;
        if (!entry || (entry.platform ?? "youtube") !== "youtube" || !entry.handle) continue;
        const handle = resolveCanonical(entry.handle) ?? entry.handle;
        const exact = identityKey(entry.handle) === identityKey(handle);
        const previous = desired.get(handle);
        if (!previous || (exact && !previous.exact)) desired.set(handle, { entry, exact });
      }

      let changed = false;
      const now = nowISO();
      const getConfigRow = db.prepare(
        "SELECT handle, channel_id, info, deleted_at FROM channels WHERE handle = ?"
      );
      const updateInfo = db.prepare(
        "UPDATE channels SET info = ?, deleted_at = NULL, updated_at = ?, version = version + 1 WHERE handle = ?"
      );
      for (const [handle, { entry, exact }] of desired) {
        const existing = getConfigRow.get(handle);
        // An old identity alias keeps its canonical channel alive but cannot
        // transfer ownership or override metadata. The exact configured handle
        // is deliberate GitHub/admin intent and may explicitly transfer owner.
        if (existing && !exact) continue;
        const info = mergeInfo(existing ? parseJson(existing.info, `channel ${handle} info`) : {}, {}, {}, {
          alias: entry.alias ?? "",
          group: entry.group ?? "",
          tags: entry.tags ?? [],
          owner: entry.owner,
        });
        if (existing) {
          if (existing.info !== json(info) || existing.deleted_at) {
            updateInfo.run(json(info), now, handle);
            changed = true;
          }
        } else {
          stmts.insertChannel.run(handle, null, "[]", json(info), "[]", now, now);
          changed = true;
        }
      }

      for (const row of db.prepare("SELECT handle FROM channels WHERE deleted_at IS NULL").all()) {
        if (!desired.has(row.handle)) {
          stmts.softDeleteChannel.run(now, now, row.handle);
          stmts.deleteAliasesForHandle.run(row.handle);
          changed = true;
        }
      }
      if (changed) stmts.bumpRevision.run();
      return { changed, revision: getRevision() };
    });
  }

  function jobForRequest(requestId) {
    if (typeof requestId !== "string" || !requestId.trim()) return null;
    const row = stmts.getJobByRequest.get(requestId.trim());
    return row ? sanitizeJob(row) : null;
  }

  function enqueue(handle, kind, item = {}) {
    if (!VALID_KINDS.has(kind)) throw new Error(`enqueue: invalid kind ${kind}`);
    const canonical = resolveCanonical(handle) ?? handle;
    const requestId = typeof item?.requestId === "string" ? item.requestId.trim() : "";
    return runInTx(() => {
      if (requestId) {
        const replay = stmts.getJobByRequest.get(requestId);
        if (replay) return sanitizeJob(replay);
      }
      const existing = stmts.getJobsByHandleStatus.get(canonical, kind);
      if (existing) {
        if (requestId) stmts.mapRequestToJob.run(requestId, existing.id);
        return sanitizeJob(existing);
      }
      const now = nowISO();
      const id = stmts.insertJob.run(canonical, kind, json(item), now, now).lastInsertRowid;
      if (requestId) stmts.mapRequestToJob.run(requestId, id);
      stmts.bumpRevision.run();
      return sanitizeJob(stmts.getJobById.get(id));
    });
  }

  function jobs(handle) {
    const rows = handle ? stmts.listJobsByHandle.all(handle) : stmts.listJobs.all();
    return rows.map(sanitizeJob);
  }

  function claim() {
    return runInTx(() => {
      const leased = stmts.getLeasedJobs.all();
      // One lease across all processes and phases, including publication.
      if (leased.some((row) => isAlive(row.claimed_by))) return null;

      let recovered = false;
      let resume = null;
      for (const row of leased) {
        if (row.status === "running") {
          stmts.requeueDeadJob.run(nowISO(), row.id);
          recovered = true;
        } else if (!resume) {
          resume = row;
        }
      }
      if (resume) {
        const now = nowISO();
        stmts.takeOverJob.run(now, process.pid, processToken(), now, resume.id);
        stmts.bumpRevision.run();
        // Preserve phase and collected result: never re-run the collector.
        return sanitizeJob(stmts.getJobById.get(resume.id));
      }

      const next = stmts.getNextQueued.get();
      if (!next) {
        if (recovered) stmts.bumpRevision.run();
        return null;
      }
      const now = nowISO();
      stmts.claimJob.run(now, process.pid, processToken(), now, next.id);
      stmts.bumpRevision.run();
      return sanitizeJob(stmts.getJobById.get(next.id));
    });
  }

  function setJob(id, status, fields = {}) {
    if (!VALID_STATUSES.has(status)) throw new Error(`setJob: invalid status ${status}`);
    return runInTx(() => {
      const row = stmts.getJobById.get(id);
      if (!row) return false;
      const now = nowISO();
      const clearLease = status === "complete" || status === "failed" || status === "queued" ||
        (fields.release === true && row.claimed_by === process.pid);
      const result = fields.result !== undefined ? json(fields.result) : null;
      const error = fields.error !== undefined && fields.error !== null ? String(fields.error) : null;
      stmts.updateJob.run(
        status,
        result,
        error,
        now,
        clearLease ? null : row.claimed_at,
        clearLease ? null : row.claimed_by,
        clearLease ? null : row.claimed_process,
        id
      );
      stmts.bumpRevision.run();
      return sanitizeJob(stmts.getJobById.get(id));
    });
  }

  const publicationRows = db.prepare(
    "SELECT handle, info, version FROM channels WHERE deleted_at IS NULL ORDER BY handle"
  );
  const publicationRecords = db.prepare(
    "SELECT records FROM channels WHERE handle = ? AND version = ? AND deleted_at IS NULL"
  );

  function publicationSnapshot(previous = {}) {
    db.exec("BEGIN");
    try {
      const revision = getRevision();
      const channels = {};
      for (const row of publicationRows.iterate()) {
        const sourceVersion = Number(row.version);
        const channel = { info: parseJson(row.info, `channel ${row.handle} info`), sourceVersion };
        if (previous?.[row.handle]?.sourceVersion !== sourceVersion) {
          const records = publicationRecords.get(row.handle, sourceVersion)?.records;
          if (records === undefined) throw new Error(`channel ${row.handle} changed during publication snapshot`);
          channel.content = `{"info":${row.info},"records":${records}}`;
        }
        channels[row.handle] = channel;
      }
      db.exec("COMMIT");
      secureSqliteFiles();
      return { revision, channels };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function counts() {
    const channels = Number(
      db.prepare("SELECT count(*) AS n FROM channels WHERE deleted_at IS NULL").get().n
    );
    const records = Number(
      db.prepare(
        "SELECT count(*) AS n FROM channels, json_each(records) WHERE deleted_at IS NULL"
      ).get().n ?? 0
    );
    const videoSamples = Number(
      db.prepare(
        "SELECT sum(json_extract(value, '$.videoCountTracked')) AS n FROM channels, json_each(records) WHERE deleted_at IS NULL"
      ).get().n ?? 0
    );
    return { channels, records, videoSamples, bytes: statSync(dbPath).size };
  }

  function exportHistory() {
    return {
      updatedAt: nowISO(),
      channels: listChannels(),
    };
  }

  function close() {
    db.close();
  }

  return {
    resolveHandle: resolveCanonical,
    hasRecords,
    getChannel,
    listChannels,
    saveChannel,
    updateMeta,
    deleteChannel,
    reconcileConfig,
    enqueue,
    jobForRequest,
    jobs,
    claim,
    setJob,
    getRevision,
    publicationSnapshot,
    counts,
    exportHistory,
    close,
  };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
  const migrate = args.includes("--migrate");
  const exportFlag = args.includes("--export");
  const countsFlag = args.includes("--counts");

  const store = openStore({ root });
  try {
    if (migrate) {
      console.log(
        JSON.stringify({ ok: true, revision: store.getRevision(), counts: store.counts() })
      );
    } else if (countsFlag) {
      console.log(JSON.stringify(store.counts()));
    } else if (exportFlag) {
      console.log(JSON.stringify(store.exportHistory(), null, 2));
    } else {
      console.log(JSON.stringify({ ok: true, revision: store.getRevision() }));
    }
  } finally {
    store.close();
  }
}

const isDirectRun =
  process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();

export { openStore };
