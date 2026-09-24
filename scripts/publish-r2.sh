#!/bin/bash
# R2 增量发布（cron/手动通用）
# 用法：bash scripts/publish-r2.sh [--full]
#   默认：JSON 全传 + 只传 git 感知到的新增/变更头像（日常 cron 用，快）
#   --full：头像全传（首次建桶/修复用，慢）
# 认证：优先 $CLOUDFLARE_API_TOKEN / ~/.config/social-dashboard/cloudflare-api-token（持久，
#   cron 必备）；回退本机 wrangler OAuth（会过期，仅过渡）
# 输出全走 stdout，调用方自行 >> "$LOG" 2>&1
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

put() { # put <本地文件> <远端key> <content-type>
  "$WRANGLER_BIN" r2 object put "${R2_BUCKET}/$2" --file "$1" --content-type "$3" --remote >/dev/null 2>&1
}

filehash() { cat "$@" 2>/dev/null | (md5sum 2>/dev/null || md5 2>/dev/null) | grep -o -E '[0-9a-f]{32}' | head -n 1; }

echo "[$(date '+%F %T')] publish-r2 开始 (bucket=${R2_BUCKET})"
mkdir -p logs
HASH_FILE="logs/.publish-r2-hash"
CUR=$(filehash data/youtube-history.json channels.json users.json data/cf-usage.json)
if [ "$FULL" = 0 ] && [ -n "$CUR" ] && [ -f "$HASH_FILE" ] && [ "$CUR" = "$(cat "$HASH_FILE" 2>/dev/null)" ]; then
  echo "  json 未变更，跳过上传"
else
  [ -f data/youtube-history.json ] && { put data/youtube-history.json data/youtube-history.json "application/json; charset=utf-8" && echo "  json ok" || echo "  json FAIL"; }
  [ -f channels.json ] && { put channels.json channels.json "application/json; charset=utf-8" && echo "  channels ok" || echo "  channels FAIL"; }
  [ -f users.json ] && { put users.json users.json "application/json; charset=utf-8" && echo "  users ok" || echo "  users FAIL"; }
  [ -f data/cf-usage.json ] && { put data/cf-usage.json cf-usage.json "application/json; charset=utf-8" && echo "  usage ok" || echo "  usage FAIL"; }
  [ -n "$CUR" ] && echo "$CUR" > "$HASH_FILE"
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
echo "[$(date '+%F %T')] publish-r2 结束 avatars=${N} fail=${FAIL}"
