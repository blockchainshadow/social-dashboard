#!/bin/bash
# R2 全量同步（手动用；日常 cron 调 publish-r2.sh 增量版）
# 前提：同一用户跑过一次 `wrangler login`
# 用法：./scripts/upload-r2.sh
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
bash scripts/publish-r2.sh --full
