#!/bin/bash
# YouTube 每日本地采集 + 数据备份 + Pages 自动推送（由 launchd 调度）
cd "/Users/x/Documents/Default Project" || exit 1
NODE_BIN="${NODE_BIN:-/Users/x/.local/bin/node}"
mkdir -p logs backups

echo "[$(date '+%F %T')] === 每日采集开始 ===" >> logs/youtube-daily.log
"$NODE_BIN" scripts/fetch-youtube.mjs >> logs/youtube-daily.log 2>&1
EXIT_CODE=$?

# 数据备份，保留最近 30 份
if [ -f data/youtube-history.json ]; then
  cp data/youtube-history.json "backups/youtube-history-$(date +%F).json"
  ls -t backups/youtube-history-*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
fi

echo "[$(date '+%F %T')] === 采集结束 (exit=$EXIT_CODE) ===" >> logs/youtube-daily.log

# 提交并推送数据到 GitHub（Pages 从 main 根目录自动更新）
if [ "$EXIT_CODE" -eq 0 ] && [ -f data/youtube-history.json ]; then
  # 先同步远程（必须在改写部署文件之前，避免工作区脏导致 rebase 失败）
  git pull --rebase origin main >> logs/youtube-daily.log 2>&1 \
    || echo "[$(date '+%F %T')] pull --rebase 失败，继续尝试提交推送" >> logs/youtube-daily.log

  # 同步 Pages 部署文件（根目录副本）：头像 + 数据 + 频道配置
  if [ -d web/avatars ]; then
    cp web/avatars/*.jpg avatars/ 2>/dev/null
  fi
  cp data/youtube-history.json web/data/youtube-history.json 2>/dev/null
  cp channels.json web/channels.json 2>/dev/null

  git add data/ avatars/ channels.json users.json web/data/ web/avatars/ web/channels.json web/users.json
  if ! git diff --cached --quiet; then
    git commit -m "chore(data): youtube snapshot $(date -u +%F)" >> logs/youtube-daily.log 2>&1
    if git push origin main >> logs/youtube-daily.log 2>&1; then
      echo "[$(date '+%F %T')] 推送成功" >> logs/youtube-daily.log
    else
      echo "[$(date '+%F %T')] 推送失败（网络问题，数据保留在本地，次日重试）" >> logs/youtube-daily.log
    fi
  else
    echo "[$(date '+%F %T')] 无数据变化，跳过提交" >> logs/youtube-daily.log
  fi
else
  echo "[$(date '+%F %T')] 采集失败，跳过推送" >> logs/youtube-daily.log
fi
