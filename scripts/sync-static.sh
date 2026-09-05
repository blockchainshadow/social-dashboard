#!/bin/bash
# 根目录 = Pages 服务目录（线上唯一读取来源）；web/ 为遗留镜像副本，由本脚本统一同步
cd "/Users/x/Documents/Default Project" || exit 1
[ -d web/avatars ] && cp -f web/avatars/*.jpg avatars/ 2>/dev/null
[ -f data/youtube-history.json ] && cp -f data/youtube-history.json web/data/youtube-history.json
[ -f channels.json ] && cp -f channels.json web/channels.json
[ -f users.json ] && cp -f users.json web/users.json
exit 0
