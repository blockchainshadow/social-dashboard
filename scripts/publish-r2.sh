#!/bin/bash
# R2 增量发布（cron/手动通用）
# 用法：bash scripts/publish-r2.sh [--full]
#   默认：JSON/shard 只传变更部分 + 只传 git 感知到的新增/变更头像（日常 cron 用，快）
#   --full：所有 shard/头像全传（首次建桶/修复用，慢）
# 认证：优先 $CLOUDFLARE_API_TOKEN / ~/.config/social-dashboard/cloudflare-api-token（持久，
#   cron 必备）；回退本机 wrangler OAuth（会过期，仅过渡）
# 输出全走 stdout，调用方自行 >> "$LOG" 2>&1
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
# cron 下 PATH 极简，先补 node/wrangler 所在目录（wrangler 自身也是 node 脚本，靠 env 找 node）
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# 持久 API token（cron 无人值守，wrangler OAuth 会过期；文件 600 权限，不进仓库）
# 建法见 docs/系统说明和操作手册-v1.0.md §10：一枚 custom token 同时给 R2 Storage Edit + Account Analytics Read
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  for _tf in "$HOME/.config/social-dashboard/cloudflare-api-token" "$HOME/.config/social-dashboard/cloudflare-token"; do
    if [ -f "$_tf" ]; then CLOUDFLARE_API_TOKEN="$(cat "$_tf")"; export CLOUDFLARE_API_TOKEN; break; fi
  done
fi
R2_BUCKET="${R2_BUCKET:-social-dashboard-data}"
WRANGLER_BIN="${WRANGLER_BIN:-$(command -v wrangler 2>/dev/null || echo "$HOME/.nvm/versions/node/v22.14.0/bin/wrangler")}"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

OVERALL_FAIL=0

put() { # put <本地文件> <远端key> <content-type> [cache-control]
  local cc="${4:-}"
  if [ -n "$cc" ]; then
    "$WRANGLER_BIN" r2 object put "${R2_BUCKET}/$2" --file "$1" --content-type "$3" --cache-control "$cc" --remote >/dev/null 2>&1
  else
    "$WRANGLER_BIN" r2 object put "${R2_BUCKET}/$2" --file "$1" --content-type "$3" --remote >/dev/null 2>&1
  fi
}

filehash() { cat "$@" 2>/dev/null | (md5sum 2>/dev/null || md5 2>/dev/null) | grep -o -E '[0-9a-f]{32}' | head -n 1; }

file_sha256() {
  node -e "
    const fs = require('fs');
    const { createHash } = require('crypto');
    const h = createHash('sha256');
    const file = process.argv[1];
    const s = fs.createReadStream(file);
    s.on('data', c => h.update(c));
    s.on('end', () => console.log(h.digest('hex')));
    s.on('error', e => { console.error(e); process.exit(1); });
  " "$1"
}

file_mtime() {
  local m
  m=$(stat -f %m "$1" 2>/dev/null) || m=$(stat -c %Y "$1" 2>/dev/null) || m=""
  echo "$m"
}

file_size() {
  local s
  s=$(stat -f %z "$1" 2>/dev/null) || s=$(stat -c %s "$1" 2>/dev/null) || s=""
  echo "$s"
}

json_get() {
  node -e "
    const file = process.argv[1];
    const prop = process.argv[2];
    try { const v = JSON.parse(require('fs').readFileSync(file,'utf8'))[prop]; console.log(v === undefined || v === null ? '' : v); }
    catch { console.log(''); }
  " "$1" "$2"
}

echo "[$(date '+%F %T')] publish-r2 开始 (bucket=${R2_BUCKET})"
mkdir -p logs
STATE_DIR="logs/.publish-r2-state"
mkdir -p "$STATE_DIR"

# 独立发布小 JSON；只有上传成功才写 hash，失败下次会重试
publish_plain() {
  local file="$1" key="$2" ct="$3"
  local cur prev hashfile
  [ -f "$file" ] || return 0
  hashfile="$STATE_DIR/$(echo "$key" | tr '/' '-').hash"
  cur=$(filehash "$file")
  prev=$(cat "$hashfile" 2>/dev/null)
  if [ "$FULL" = 0 ] && [ -n "$cur" ] && [ -n "$prev" ] && [ "$cur" = "$prev" ]; then
    echo "  $key 未变更，跳过"
    return 0
  fi
  if put "$file" "$key" "$ct"; then
    echo "$cur" > "$hashfile"
    echo "  $key ok"
  else
    echo "  $key FAIL"
    OVERALL_FAIL=1
    return 1
  fi
}

publish_plain channels.json channels.json "application/json; charset=utf-8"
publish_plain users.json users.json "application/json; charset=utf-8"
publish_plain data/cf-usage.json data/cf-usage.json "application/json; charset=utf-8"
if node scripts/youtube-quota.mjs --snapshot; then
  publish_plain data/youtube-api-usage.json data/youtube-api-usage.json "application/json; charset=utf-8"
else
  echo "  YouTube 用量快照 FAIL，跳过发布"
  OVERALL_FAIL=1
fi

# Dashboard：大历史拆成索引 + 按频道分片；source 字节未变且已有成功 state 时跳过 build/upload
DASH_STATE="$STATE_DIR/dashboard-state.json"
if [ -f data/youtube-history.json ]; then
  SRC_HASH=$(file_sha256 data/youtube-history.json)
  SRC_MTIME=$(file_mtime data/youtube-history.json)
  SRC_SIZE=$(file_size data/youtube-history.json)
  PREV_HASH=$(json_get "$DASH_STATE" sourceHash)

  DASH_SKIP=0
  if [ "$FULL" = 0 ] && [ -n "$PREV_HASH" ] && [ "$SRC_HASH" = "$PREV_HASH" ]; then
    DASH_SKIP=1
    echo "  dashboard source 未变更，跳过 build/upload"
  fi

  if [ "$DASH_SKIP" = 0 ]; then
    if node scripts/build-dashboard-index.mjs; then
      if [ -f data/dashboard-index.json ]; then
        node - "$FULL" "$DASH_STATE" "$R2_BUCKET" "$WRANGLER_BIN" "$SRC_HASH" "$SRC_MTIME" "$SRC_SIZE" <<'NODE'
const fs = require('fs');
const { execSync } = require('child_process');
const full = process.argv[2] === '1';
const statePath = process.argv[3];
const bucket = process.argv[4];
const wrangler = process.argv[5];
const srcHash = process.argv[6];
const srcMtime = parseInt(process.argv[7], 10) || 0;
const srcSize = parseInt(process.argv[8], 10) || 0;

function put(local, key, ct, cc) {
  let cmd = `"${wrangler}" r2 object put "${bucket}/${key}" --file "${local}" --content-type "${ct}" --remote`;
  if (cc) cmd += ` --cache-control "${cc}"`;
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const idx = JSON.parse(fs.readFileSync('data/dashboard-index.json', 'utf8'));
let prev = {};
try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')).channels || {}; } catch {}

let uploaded = 0, failed = 0;
for (const [handle, entry] of Object.entries(idx.channels)) {
  if (!full && prev[handle] === entry.version) continue;
  if (put(entry.path, entry.path, 'application/json; charset=utf-8', 'public, max-age=31536000, immutable')) {
    uploaded++;
  } else {
    failed++;
    console.error(`  shard FAIL: ${handle} -> ${entry.path}`);
  }
}

if (failed > 0) {
  console.log(`  dashboard shard FAIL=${failed}，跳过索引发布`);
  process.exit(2);
}

if (put('data/dashboard-index.json', 'data/dashboard-index.json', 'application/json; charset=utf-8', 'no-store')) {
  const nextChannels = {};
  for (const [h, e] of Object.entries(idx.channels)) nextChannels[h] = e.version;
  fs.writeFileSync(statePath, JSON.stringify({
    sourceHash: srcHash,
    sourceMtime: srcMtime,
    sourceSize: srcSize,
    channels: nextChannels,
  }, null, 2));
  console.log(`  dashboard index ok (shards=${uploaded})`);
} else {
  console.log('  dashboard index FAIL');
  process.exit(3);
}
NODE
        DASH_EXIT=$?
        if [ "$DASH_EXIT" -ne 0 ]; then
          echo "  dashboard publish exit=$DASH_EXIT"
          OVERALL_FAIL=1
        fi
      fi
    else
      echo "  dashboard build FAIL"
      OVERALL_FAIL=1
    fi
  fi
else
  echo "  data/youtube-history.json 不存在，跳过 dashboard 发布"
fi

if [ "$FULL" = 1 ]; then
  LIST=$(for f in web/avatars/*.jpg; do [ -e "$f" ] && basename "$f"; done | sort -u)
else
  LIST=$(git status --porcelain -- avatars web/avatars 2>/dev/null | awk '{print $2}' | sed 's/^"//;s/"$//' | while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && basename "$f"; done | sort -u)
fi
N=0; FAIL=0
for b in $LIST; do
  SRC="web/avatars/$b"; [ -f "$SRC" ] || SRC="avatars/$b"; [ -f "$SRC" ] || continue
  if put "$SRC" "avatars/$b" "image/jpeg"; then N=$((N + 1)); else FAIL=$((FAIL + 1)); echo "  avatar FAIL: $b"; fi
done
[ "$FAIL" -gt 0 ] && OVERALL_FAIL=1
echo "[$(date '+%F %T')] publish-r2 结束 avatars=${N} fail=${FAIL}"
exit $OVERALL_FAIL
