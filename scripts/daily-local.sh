#!/bin/bash
# YouTube 每日采集：每频道独立提交推送（与 watch 任务经文件锁互斥，新增频道不再排队）
cd "/Users/x/Documents/Default Project" || exit 1
NODE_BIN="${NODE_BIN:-/Users/x/.local/bin/node}"
LOG=logs/youtube-daily.log
mkdir -p logs backups

acquire_lock() {
  for i in 1 2 3 4 5; do
    if mkdir .fetch-lock 2>/dev/null; then echo $$ > .fetch-lock/pid; return 0; fi
    if [ -n "$(find .fetch-lock -maxdepth 0 -mmin +15 2>/dev/null)" ]; then rm -rf .fetch-lock; continue; fi
    sleep $((RANDOM % 15 + 5))
  done
  return 1
}
release_lock() { rm -rf .fetch-lock 2>/dev/null; }
trap release_lock EXIT

commit_push() {
  local msg="$1"
  git pull --rebase --autostash origin main >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] pull 失败，继续" >> "$LOG"
  bash scripts/sync-static.sh
  git add data/youtube-history.json avatars web/data/youtube-history.json channels.json web/channels.json users.json web/users.json 2>/dev/null
  if ! git diff --cached --quiet; then
    git commit -m "$msg" >> "$LOG" 2>&1
    git pull --rebase --autostash origin main >> "$LOG" 2>&1
    if git push origin main >> "$LOG" 2>&1; then
      git push origin main:v1.0a >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] push v1.0a 失败" >> "$LOG"
    else
      echo "[$(date '+%F %T')] push main 失败（下轮自动重试）" >> "$LOG"
    fi
  fi
}

echo "[$(date '+%F %T')] === 每日采集开始 ===" >> "$LOG"
git pull --rebase --autostash origin main >> "$LOG" 2>&1 || true

HANDLES=$("$NODE_BIN" -e "const c=require(process.cwd()+'/channels.json');console.log(c.filter(x=>(x.platform??'youtube')==='youtube').map(x=>x.handle).join('\n'))" 2>>"$LOG")
FAIL=0
while IFS= read -r H; do
  [ -z "$H" ] && continue
  acquire_lock || { echo "[$(date '+%F %T')] $H 跳过（锁占用）" >> "$LOG"; continue; }
  echo "[$(date '+%F %T')] === $H ===" >> "$LOG"
  "$NODE_BIN" scripts/fetch-youtube.mjs --only "$H" >> "$LOG" 2>&1 || FAIL=1
  commit_push "data: snapshot $H [daily $(date +%F)]"
  release_lock
done <<< "$HANDLES"

if [ -f data/youtube-history.json ]; then
  cp data/youtube-history.json "backups/youtube-history-$(date +%F).json"
  ls -t backups/youtube-history-*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
fi
echo "[$(date '+%F %T')] === 每日采集结束 (fail=$FAIL) ===" >> "$LOG"
