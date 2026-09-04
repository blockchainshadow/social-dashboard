#!/bin/bash
# 每 2 分钟：补采新增频道并推送（与每日任务经文件锁互斥，锁空闲即插队执行）
cd "/Users/x/Documents/Default Project" || exit 1
LOG=logs/watch.log
if ! mkdir .fetch-lock 2>/dev/null; then
  if [ -n "$(find .fetch-lock -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rm -rf .fetch-lock && mkdir .fetch-lock || exit 0
  else
    exit 0
  fi
fi
echo $$ > .fetch-lock/pid
trap 'rm -rf .fetch-lock' EXIT
echo "[$(date '+%F %T')] === watch 开始 ===" >> "$LOG"
git pull --rebase origin main >> "$LOG" 2>&1 || echo "pull 失败，继续用本地" >> "$LOG"
/Users/x/.local/bin/node scripts/watch-new-channels.mjs >> "$LOG" 2>&1
if ! git diff --quiet -- data/youtube-history.json channels.json || ! git diff --cached --quiet; then
  git add data/youtube-history.json channels.json web/channels.json web/avatars >> "$LOG" 2>&1
  git commit -m "data: quick snapshot for newly added channels [watch]" >> "$LOG" 2>&1
  git pull --rebase origin main >> "$LOG" 2>&1
  git push origin main >> "$LOG" 2>&1 && git push origin main:v1.0a >> "$LOG" 2>&1 && echo "[$(date '+%F %T')] 已推送" >> "$LOG"
else
  echo "[$(date '+%F %T')] 无变化" >> "$LOG"
fi
