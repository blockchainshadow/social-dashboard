#!/bin/bash
# 每 2 分钟：补采新增频道并推送（与每日任务经文件锁互斥，锁空闲即插队执行）
# 定位仓库根（脚本所在目录的上级），不依赖硬编码绝对路径
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# node 解析：cron 下 PATH 极简，先找 PATH，再找 nvm，最后回退旧路径
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "$HOME/.nvm/versions/node/v22.14.0/bin/node")}"
LOG=logs/watch.log
# 日志轮转（超 20MB 只留末尾 2000 行，防无限膨胀）
for _lf in "$LOG" logs/cron.log; do
  if [ -f "$_lf" ] && [ "$(wc -c < "$_lf" | tr -d ' ')" -gt 20971520 ]; then
    tail -n 2000 "$_lf" > "$_lf.tmp" && mv "$_lf.tmp" "$_lf"
  fi
done
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
"$NODE_BIN" scripts/watch-new-channels.mjs >> "$LOG" 2>&1
bash scripts/sync-static.sh
if ! "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync('channels.json','utf8'));JSON.parse(require('fs').readFileSync('data/youtube-history.json','utf8'))" 2>> "$LOG"; then
  echo "[$(date '+%F %T')] JSON 校验失败，跳过（防止冲突标记入库）" >> "$LOG"
  git rebase --abort 2>/dev/null
  exit 0
fi
# 数据走 R2，仓库只提交配置与小文件
bash scripts/publish-r2.sh >> "$LOG" 2>&1
git add channels.json web/channels.json users.json web/users.json avatars web/avatars >> "$LOG" 2>&1
if ! git diff --cached --quiet; then
  git commit -m "data: quick snapshot for newly added channels [watch]" >> "$LOG" 2>&1
  git pull --rebase --autostash origin main >> "$LOG" 2>&1 || { echo "[$(date '+%F %T')] pull 冲突，中止 rebase 下轮重试" >> "$LOG"; git rebase --abort 2>> "$LOG" || true; git reset -q --hard origin/main 2>/dev/null; exit 0; }
  if git push origin main >> "$LOG" 2>&1; then
    git push origin main:v1.0a >> "$LOG" 2>&1 || echo "[$(date '+%F %T')] push v1.0a 失败" >> "$LOG"
    echo "[$(date '+%F %T')] 已推送" >> "$LOG"
  else
    echo "[$(date '+%F %T')] push main 失败（下轮自动重试）" >> "$LOG"
  fi
else
  echo "[$(date '+%F %T')] 配置无变更（数据已直推 R2）" >> "$LOG"
fi
