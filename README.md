# 社交平台数据看板（YouTube + TikTok）

YouTube 公开数据看板：订阅、播放、点赞、评论趋势，支持频道分组、标签和成员归属。TikTok 采集流程保持原样。

## 访问入口

| 入口 | 地址 | 说明 |
|---|---|---|
| 主站 | https://social-dashboard-9ya.pages.dev/ | Cloudflare Pages；管理操作调用 Worker |
| 备用站 | https://blockchainshadow.github.io/social-dashboard/ | GitHub Pages；同一 Worker、同一 R2 数据 |
| 本地管理 | http://127.0.0.1:8000/ | `node server.mjs`；采集仍在本机执行 |

登录后，顶栏首位显示当前账号。admin 默认查看自己名下频道，点击「全员」切换；成员只能管理自己名下频道。旧账号首次登录必须更换曾公开的旧密码；未换密前管理操作返回 403。

## 数据链路

`channels.json`（Git 配置）→ 本机任务执行器 → `data/dashboard.sqlite`（权威历史与任务）→ R2 索引和按频道分片 → 浏览器。

浏览器先加载频道索引，只下载当前频道历史；切换频道按需加载。YouTube 原始历史只保存在本机 SQLite，发布产物可以重建。`data/youtube-history.json` 仅作旧历史迁移输入，运行时不再写入；`web/` 不复制数据库或完整历史。

- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 运维：[docs/系统说明和操作手册-v1.1.md](docs/系统说明和操作手册-v1.1.md)
- 官方配额研究：[docs/youtube-api-quota-research.md](docs/youtube-api-quota-research.md)

## 新增与刷新

本地及线上均接受 `@handle`、裸 handle、YouTube 主页链接和 `UC…` 频道 ID；Unicode 统一为 NFC。配置先保存，再返回任务，**入队不等于已采集或已发布**。

新增频道先取档案和最近 50 条视频，成功发布后再分页补全上传列表。刷新发现最近上传，同时对已追踪视频按 50 个 ID 一批更新公开统计。任务依次显示排队、采集中、已采集、发布中、完成或失败；只有对应频道分片和索引发布成功后才标记完成。稳定频道 ID 合并别名，重复请求关联同一任务。

公开视频 API 不提供分享数，不能可靠区分 Shorts 或会员视频；未知字段保留 `null`，页面显示「—」。API 未返回的既有视频仍保留并标记最后有效采集日期，不能伪造播放增量。新执行器的 API 或配额失败会保留失败任务，不用网页数据冒充成功。

线上「检查发布」只读取新发布的数据；管理菜单的单频道刷新会提交采集任务，由本机执行。TikTok 刷新仍走原本地流程。

## 命令

要求 Node >= 22.14（`node:sqlite`）。

```bash
node server.mjs
npm test
# 接收远端请求、补采新配置、执行并逐频道发布
node scripts/run-dashboard-jobs.mjs --reconcile --queue-new --run --sync
# 指定频道采集，直接写 SQLite；默认遵循 all 配置
node scripts/fetch-youtube.mjs --only @频道handle
# 强制补齐指定频道
node scripts/fetch-youtube.mjs --only @频道handle --full
# 发布变更分片及索引；--full 用于重传
bash scripts/publish-r2.sh
# 一致性快照、加密并上传；恢复到空目录，不覆盖运行库
npm run backup
node scripts/backup-dashboard.mjs --download backups/dashboard-时间戳.enc --target /path/to/empty-restore
```

`index.html` 是唯一页面来源；修改后运行 `bash scripts/sync-static.sh` 生成 `web/index.html` 小文件镜像。两站代码由 Git push 构建；Worker 单独运行 `npm run deploy`。

## 密钥与额度

YouTube key：`YOUTUBE_API_KEY` 或 `~/.config/social-dashboard/youtube-api-key`，无需 Google OAuth。默认每日 10,000 units（太平洋时间午夜重置）；本机请求前跨进程预留，默认及硬上限 9000。失败请求同样记账；配额耗尽或日志损坏时停止 API，不能清空当日计数绕过限制。顶栏显示的是本机记账，不包含同项目其它客户端。

Worker 用私有 D1 校验密码和随机会话；客户端只保存会话 token，不保存密码哈希。公开历史不等于私有数据访问控制。`users.json` 已停止发布；公开 Git 历史中的旧哈希无法撤回，必须换密。

`RUNNER_TOKEN` 在 Worker secret 及本机 `~/.config/social-dashboard/runner-token`；R2 发布、备份都经 Worker 绑定。加密备份密钥仅在本机 `~/.config/social-dashboard/backup-key`，须另存安全离线副本，丢失则无法恢复。文件权限 600；任何密钥、会话、SQLite、备份及日志不得提交 Git。非回环启动本地服务仍须设置 `DASH_TOKEN`；浏览器管理始终需 Worker 会话。

实际定时任务以 `crontab -l` 为准：watch 每 2 分钟，daily 当前为每日 09:30，用量每小时 17 分。Git 同步锁不覆盖采集；SQLite 活进程租约防止并发执行，发布器另有活 PID 锁，不因耗时超过 15 分钟抢占。
