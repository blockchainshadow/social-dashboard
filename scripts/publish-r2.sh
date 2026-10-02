#!/bin/bash
# Incremental R2 publisher: immutable content-addressed shards and avatars first, index last.
set -u -o pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "$HOME/.nvm/versions/node/v22.14.0/bin/node")}"
FULL=0
JOBS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --jobs-only) JOBS_ONLY=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p logs
STATE_DIR=logs/.publish-r2-state
mkdir -p "$STATE_DIR"

# One publisher at a time: a live PID is never stolen (manual publish cannot race index).
LOCK_DIR=logs/.publish-r2-lock
acquire_lock() {
  local i pid
  for ((i=0; i<120; i++)); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK_DIR/pid"
      return 0
    fi
    pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    sleep 1
  done
  echo "publisher lock busy; refusing concurrent index upload" >&2
  return 1
}
acquire_lock || exit 1
trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

put() {
  if [ -n "${4:-}" ]; then
    "$NODE_BIN" scripts/r2-object.mjs put "$1" "$2" "$3" "$4"
  else
    "$NODE_BIN" scripts/r2-object.mjs put "$1" "$2" "$3"
  fi
}
file_hash() {
  shasum -a 256 "$1" | cut -d ' ' -f 1
}
publish_plain() {
  local file="$1" key="$2" content_type="$3" cache="${4:-}" current previous state
  if [ ! -f "$file" ]; then
    echo "Missing publication file: $file" >&2
    return 1
  fi
  state="$STATE_DIR/$(printf '%s' "$key" | tr '/' '-').hash"
  current=$(file_hash "$file") || return 1
  previous=$(cat "$state" 2>/dev/null || true)
  if [ "$FULL" -eq 0 ] && [ -n "$previous" ] && [ "$current" = "$previous" ]; then return 0; fi
  put "$file" "$key" "$content_type" "$cache" || return 1
  printf '%s\n' "$current" > "$state"
  echo "  published $key"
}

# Completion status is published after the corresponding shard/index succeeded.
if [ "$JOBS_ONLY" -eq 1 ]; then
  publish_plain data/dashboard-jobs.json data/dashboard-jobs.json 'application/json; charset=utf-8'
  exit $?
fi
if [ ! -f data/dashboard.sqlite ]; then
  echo 'Missing authoritative data/dashboard.sqlite; refusing publication' >&2
  exit 1
fi

echo "[$(date '+%F %T')] dashboard publish start"
publish_plain channels.json channels.json 'application/json; charset=utf-8' || exit 1
if [ -f data/cf-usage.json ]; then
  publish_plain data/cf-usage.json data/cf-usage.json 'application/json; charset=utf-8' || exit 1
fi
publish_plain data/dashboard-jobs.json data/dashboard-jobs.json 'application/json; charset=utf-8' || exit 1
"$NODE_BIN" scripts/youtube-quota.mjs --snapshot || exit 1
publish_plain data/youtube-api-usage.json data/youtube-api-usage.json 'application/json; charset=utf-8' || exit 1

# Upload every changed avatar before the index can refer to it. Hash state catches
# changes even when the image was already committed to git.
for file in web/avatars/* avatars/*; do
  [ -f "$file" ] || continue
  base=${file##*/}
  case "$base" in
    *.jpg|*.png|*.webp) ;;
    *) continue ;;
  esac
  if [ "$file" = "avatars/$base" ] && [ -f "web/avatars/$base" ]; then continue; fi
  case "$base" in
    *.png) content_type=image/png ;;
    *.webp) content_type=image/webp ;;
    *) content_type=image/jpeg ;;
  esac
  publish_plain "$file" "avatars/$base" "$content_type" || {
    echo "Avatar upload failed; index not published: $base" >&2
    exit 1
  }
done

REVISION=$("$NODE_BIN" -e "import('./scripts/dashboard-store.mjs').then(({openStore}) => { const s=openStore(); try { console.log(s.getRevision()); } finally { s.close(); } }).catch(e => { console.error(e); process.exitCode=1; })") || exit 1
STATE="$STATE_DIR/dashboard-state.json"
PREVIOUS=$("$NODE_BIN" -e "try { console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).publishedRevision ?? ''); } catch { console.log(''); }" "$STATE") || exit 1
if [ "$FULL" -eq 0 ] && [ -n "$PREVIOUS" ] && [ "$REVISION" = "$PREVIOUS" ]; then
  echo "  dashboard revision $REVISION unchanged"
  exit 0
fi
"$NODE_BIN" scripts/build-dashboard-index.mjs || exit 1
[ -f data/dashboard-index.json ] || { echo 'Builder produced no index' >&2; exit 1; }

# No shell interpolation for object keys: the node helper streams directly to the
# Worker R2 binding. Persist state only after every shard and index succeeds.
"$NODE_BIN" - "$FULL" "$STATE" "$REVISION" <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const full = process.argv[2] === '1';
const statePath = process.argv[3];
const revision = Number(process.argv[4]);
const index = JSON.parse(fs.readFileSync('data/dashboard-index.json', 'utf8'));
let previous = {};
try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
const versions = previous.channels ?? {};
function put(file, key, cache) {
  const result = spawnSync(process.execPath,
    ['scripts/r2-object.mjs', 'put', file, key, 'application/json; charset=utf-8', cache],
    { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`R2 upload failed: ${key} (exit ${result.status})`);
}
try {
  let uploaded = 0;
  for (const [handle, entry] of Object.entries(index.channels)) {
    if (!full && versions[handle] === entry.version) continue;
    put(entry.path, entry.path, 'public, max-age=31536000, immutable');
    uploaded++;
  }
  const hash = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync('data/dashboard-index.json')).digest('hex');
  if (full || previous.indexHash !== hash || uploaded > 0) {
    put('data/dashboard-index.json', 'data/dashboard-index.json', 'no-store');
  }
  const channels = {};
  for (const [handle, entry] of Object.entries(index.channels)) channels[handle] = entry.version;
  const next = { publishedRevision: revision, indexHash: hash, channels };
  fs.writeFileSync(`${statePath}.${process.pid}.tmp`, JSON.stringify(next));
  fs.renameSync(`${statePath}.${process.pid}.tmp`, statePath);
  console.log(`  dashboard index ready (shards=${uploaded})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
NODE
