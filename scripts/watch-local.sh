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
git pull --rebase --autostash origin main >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] pull 失败，继续用本地" >> "$LOG"
/Users/x/.local/bin/node scripts/watch-new-channels.mjs >> "$LOG" 2>&1
bash scripts/sync-static.sh
if ! git diff --quiet -- data/youtube-history.json channels.json users.json || ! git diff --cached --quiet; then
  git add data/youtube-history.json avatars web/data/youtube-history.json channels.json web/channels.json users.json web/users.json >> "$LOG" 2>&1
  git commit -m "data: quick snapshot for newly added channels [watch]" >> "$LOG" 2>&1
  if ! /Users/x/.local/bin/node -e "JSON.parse(require('fs').readFileSync('channels.json','utf8'));JSON.parse(require('fs').readFileSync('data/youtube-history.json','utf8'))" 2>> "$LOG"; then
    echo "[$(date '+%F %T')] JSON 校验失败，跳过提交（防止冲突标记入库）" >> "$LOG"
    git rebase --abort 2>/dev/null
    exit 0
  fi
  git pull --rebase --autostash origin main >> "$LOG" 2>&1 || { echo "[$(date '+%F %T')] pull 冲突，中止 rebase 下轮重试" >> "$LOG"; git rebase --abort 2>> "$LOG" || true; git reset -q --hard origin/main 2>/dev/null; exit 0; }
  if git push origin main >> "$LOG" 2>&1; then
    git push origin main:v1.0a >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] push v1.0a 失败" >> "$LOG"
    echo "[$(date '+%F %T')] 已推送" >> "$LOG"
  else
    echo "[$(date '+%F %T')] push main 失败（下轮自动重试）" >> "$LOG"
  fi
else
  echo "[$(date '+%F %T')] 无变化" >> "$LOG"
fi
