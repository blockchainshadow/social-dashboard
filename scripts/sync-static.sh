#!/bin/bash
# 根目录 = Pages 服务目录（线上唯一读取来源）；web/ 为遗留镜像副本，由本脚本统一同步
# 定位仓库根（脚本所在目录的上级），不依赖硬编码绝对路径
cd "$(dirname "$0")/.." || exit 1
[ -d web/avatars ] && cp -f web/avatars/*.jpg avatars/ 2>/dev/null
[ -f data/youtube-history.json ] && cp -f data/youtube-history.json web/data/youtube-history.json
[ -f channels.json ] && cp -f channels.json web/channels.json
[ -f users.json ] && cp -f users.json web/users.json
# 双入口页面保持一致（根 index.html 与 web/index.html 内容相同）
[ -f index.html ] && cp -f index.html web/index.html
exit 0
