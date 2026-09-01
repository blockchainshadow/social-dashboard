#!/bin/bash
# YouTube 每日本地采集 + 数据备份（由 launchd 调度）
cd "/Users/x/Documents/Default Project" || exit 1
mkdir -p logs backups

echo "[$(date '+%F %T')] === 每日采集开始 ===" >> logs/youtube-daily.log
node scripts/fetch-youtube.mjs >> logs/youtube-daily.log 2>&1
EXIT_CODE=$?

# 数据备份，保留最近 30 份
if [ -f data/youtube-history.json ]; then
  cp data/youtube-history.json "backups/youtube-history-$(date +%F).json"
  ls -t backups/youtube-history-*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
fi

echo "[$(date '+%F %T')] === 采集结束 (exit=$EXIT_CODE) ===" >> logs/youtube-daily.log
