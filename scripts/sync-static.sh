#!/bin/bash
# 根目录 index.html 是唯一页面来源；web/ 仅同步小文件镜像，数据库和分片永不复制。
set -e
cd "$(dirname "$0")/.." || exit 1
mkdir -p web/avatars
for image in avatars/*.jpg avatars/*.png avatars/*.webp; do
  [ -f "$image" ] || continue
  cp -f "$image" web/avatars/
done
if [ -f channels.json ]; then cp -f channels.json web/channels.json; fi
if [ -f index.html ]; then
  node <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync('index.html', 'utf8');
const moduleImport = 'from "./assets/dashboard-client.mjs';
if (!source.includes(moduleImport)) throw new Error('root dashboard module import not found');
const mirror = source.replace(moduleImport, 'from "../assets/dashboard-client.mjs');
fs.writeFileSync('web/index.html', mirror);
NODE
fi
