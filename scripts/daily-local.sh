#!/bin/bash
# Daily YouTube refresh, incremental R2 publication, and encrypted offsite backup.
# Git config lock never covers the collector or backup; SQLite owns its runner lease.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "$HOME/.nvm/versions/node/v22.14.0/bin/node")}"
LOG=logs/youtube-daily.log
mkdir -p logs backups

for file in "$LOG" logs/cron.log; do
  if [ -f "$file" ] && [ "$(wc -c < "$file" | tr -d ' ')" -gt 20971520 ]; then
    tail -n 2000 "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
done

take_lock() {
  local i pid
  for ((i=0; i<10; i++)); do
    if mkdir .git-sync-lock 2>/dev/null; then
      echo "$$" > .git-sync-lock/pid
      return 0
    fi
    pid=$(cat .git-sync-lock/pid 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f .git-sync-lock/pid
      rmdir .git-sync-lock 2>/dev/null || true
      continue
    fi
    sleep 1
  done
  return 1
}
release_lock() { rm -f .git-sync-lock/pid; rmdir .git-sync-lock 2>/dev/null || true; }

STATUS=0
echo "[$(date '+%F %T')] === daily 开始 ===" >> "$LOG"
if take_lock; then
  git pull --rebase --autostash origin main >> "$LOG" 2>&1 || { echo "git pull failed; collecting with local config" >> "$LOG"; STATUS=1; }
  release_lock
else
  echo "git sync busy; collecting with local config" >> "$LOG"
fi

"$NODE_BIN" scripts/run-dashboard-jobs.mjs --root "$PWD" --reconcile --queue-refresh --run --publish --sync >> "$LOG" 2>&1 || STATUS=1
# Back up the authoritative SQLite snapshot even if one channel or publication failed.
"$NODE_BIN" scripts/backup-dashboard.mjs --backup --upload >> "$LOG" 2>&1 || STATUS=1

if take_lock; then
  if "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync('channels.json','utf8'))" >> "$LOG" 2>&1; then
    bash scripts/sync-static.sh >> "$LOG" 2>&1 || STATUS=1
    git add -- channels.json web/channels.json >> "$LOG" 2>&1 || STATUS=1
    if ! git diff --cached --quiet -- channels.json web/channels.json; then
      git commit --only -m "config: sync channels [daily]" -- channels.json web/channels.json >> "$LOG" 2>&1 || STATUS=1
      git pull --rebase --autostash origin main >> "$LOG" 2>&1 || STATUS=1
      if [ "$STATUS" -eq 0 ]; then
        git push origin main >> "$LOG" 2>&1 || STATUS=1
      fi
    fi
  else
    echo "channels.json invalid; no config commit" >> "$LOG"
    STATUS=1
  fi
  release_lock
else
  echo "git sync busy; config commit deferred" >> "$LOG"
fi
echo "[$(date '+%F %T')] === daily 结束 ===" >> "$LOG"
exit "$STATUS"
