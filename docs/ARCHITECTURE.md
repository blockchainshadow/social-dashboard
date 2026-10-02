# 系统架构（2026-10-02）

可视化版：`docs/topology.html`。下文是同一内容的文字版，以代码实现为准。

## 1. 分层

```
数据源 → 采集层（本机 Mac）→ 存储层（R2 主 / Git 次）→ 服务层 → 浏览器
```

### ① 数据源

* **YouTube**：有 API key 时先取 `channels.list` + 上传列表最近 50 条 + `videos.list` 精确统计（播放、点赞、公开视频评论数、时长）；再从频道页 `ytInitialData` 补关键词/外链等，`all: true` 时通过 innertube 翻页枚举普通视频和 Shorts，对额外 ID 按 50 条/批用 API 补指标。公开视频接口没有分享数；播放增量需要两次有效快照。API 缺失的视频沿用页面/watch/RSS；API 或配额不可用时回退页面抓取。页面/翻页失败时本轮可能仅有最近 50 条，但合并记录会保留之前追踪的视频及其最后采集日期（页面标记「未更新」，不计算伪造的播放增量）。Shorts 判别来自页面 Shorts 列表；无公开播放量时访问 watch 页尝试识别会员视频。
* **TikTok**：页面内嵌 JSON 直抓 → 失败走 Jina Reader 渲染代理 → 再失败走 Playwright 无头 Chromium。WAF 限制下只能拿档案级（粉丝/获赞/头像），无视频级。

### ② 采集层（本机，cron 驱动）

| 任务 | 周期 | 脚本 | 行为 |
|---|---|---|---|
| watch | 每 2 分钟 | `scripts/watch-local.sh` → `watch-new-channels.mjs` | 只补采 `channels.json` 里尚无快照的新频道；无变化则零提交 |
| daily | 每天 3:00 | `scripts/daily-local.sh` → `fetch-youtube.mjs` | 逐频道抓取，跑完统一推一次 R2；`backups/` 留 30 天滚动 |
| usage | 每小时 17 分 | `scripts/fetch-cf-usage.mjs` | GraphQL 拉用量 → `data/cf-usage.json`，下一轮 watch 顺带推 R2 |

互斥：`.fetch-lock/` 目录锁，15 分钟逃逸。日志：`logs/`（gitignored）。

关键脚本：

* `fetch-youtube.mjs`：`syncChannel`（抓）/ `mergeIntoHistory`（合并）/ `cacheAvatar`（头像落地 `web/avatars/`，SSRF 防护：仅 http(s)、15s 超时、拒文本、限 3MB）/ `saveHistory`（写 `data/youtube-history.json`）。
* `build-dashboard-index.mjs`：从本地完整快照生成 `data/dashboard-index.json`（频道目录、档案和版本）及 `data/channels/*.json`（各频道完整历史）；不改原始快照。
* `publish-r2.sh`：仅在源数据变化后生成/上传变化的频道分片，分片全部成功后才发布索引，失败不更新成功标记；头像只传 `git status` 感知到的新增（`--full` 全传）。另刷新并上传 YouTube API 公开用量快照。认证优先持久 Cloudflare API token，OAuth 仅应急。
* `sync-static.sh`：根目录 ↔ `web/` 镜像同步（`web/` 是遗留副本）。

### ③ 存储层

* **R2（真数据源）**：bucket `social-dashboard-data`。前端读取 `data/dashboard-index.json`、按需读取 `data/channels/<handle-hash>.json?v=<content-hash>`；还有 `avatars/*.jpg`、`channels.json`、`users.json`、`cf-usage.json`、`data/youtube-api-usage.json`。原单体 `data/youtube-history.json` 是旧发布产物，不再更新/请求。公读经 `r2.dev` + CORS `GET,HEAD *`。
* **Git（代码+配置）**：`blockchainshadow/social-dashboard`，`main`。93MB 快照已 `gitignore`（本地文件保留）。`.git` 历史 2.4G（全是旧快照），clone 慢请 `--depth 1`。`v1.0a` 为浮动快照标记。
* **本地**：`data/youtube-history.json` 是不能删的原始历史；`data/dashboard-index.json` 与 `data/channels/` 是可重建的发布产物；`avatars/`、`backups/`、`logs/` 是运行产物。

### ④ 服务层

| 服务 | 地址 | 构建/更新 | 读写 |
|---|---|---|---|
| Cloudflare Pages（主） | `social-dashboard-9ya.pages.dev` | 接 GitHub，push 自动构建；无构建命令，输出 `/` | 只读（无后端，`/api/*` 404 → 前端自动静态模式） |
| GitHub Pages（备） | `…github.io/social-dashboard/` | legacy 构建，`main`/`/` | 只读，同读 R2 |
| 本地 `server.mjs` | `127.0.0.1:8000` | 手动 `node server.mjs` | 可写：`POST /api/channels`、`POST /api/refresh`、`DELETE /api/channels/…`、`POST /api/channel-meta` |

Pages 单文件 25MiB 上限是数据必须放 R2 的根本原因。

### ⑤ 浏览器（三种模式）

* **A 本地服务**：`127.0.0.1:8000/web/`，`/api/health` 通 → 管理菜单可见，可增删账号。
* **B 静态站**：两个公网域名，`/api` 不通 → 静态模式，管理菜单隐藏，分组/标签由 `channels.json`（R2）补充。
* **C 调试覆盖**：`?data=<R2地址>` 临时切源；`localStorage dash-data-base` 持久覆盖。默认 `window.DATA_BASE_URL` 即 R2 公读。

顶栏 `☁️` 徽标：读 R2 `cf-usage.json`，显示 `存储占比% · 对象数 · $账单`；任一维度超 80% 黄、超 90% 红；文件缺失自动隐藏。`YT API` 徽标：读 R2 `data/youtube-api-usage.json`，显示本机已预留的当日调用数/上限和百分比，沿用同一颜色阈值，暂停或快照缺失/过期标红。

公网按钮「检查发布」只更新 R2 索引/分片，不发起采集；「发布于」是索引时间，当前频道的最后采集日期单独显示在视频表旁。本地服务按钮「数据刷新」才会调用 `/api/refresh` 抓取频道。

## 2. 免费额度与红线（2026-09 实测口径）

R2：10GB 存储 / A 类 100 万 / B 类 1000 万 / 月，流出免费。Workers：日 10 万次。Pages：月 500 构建。

YouTube Data API 默认 10,000 units/天（太平洋时间午夜重置）；有上传视频的频道通常从 3 units 起（`channels.list`、`playlistItems.list`、`videos.list` 各 1），全量页枚举的更多视频每 50 个 ID 再增加 1 unit。`youtube-quota.mjs` 按太平洋时间日期在 `logs/.yt-quota-YYYY-MM-DD` 计数，请求前跨进程锁定并预留，失败请求也计入；本机上限默认 9000、硬上限 9000。Google 返回 quotaExceeded 时写入 `logs/.yt-quota-blocked-YYYY-MM-DD` 停用当日 API；配额/锁出错则 fail closed，走页面抓取。过期锁不能自动抢占，确认进程退出后方可人工清除。**只保证本机本脚本的预算**：同项目其它客户端的请求或项目配额变更不可见，须在 Google Cloud 控制台核对与设限。详见 `docs/youtube-api-quota-research.md`。

R2 公网读取延迟仍影响首屏，但索引约 129KB，只下载当前频道历史而非每次拉取 111MB 单体快照。注意频道分片随内容增长；单频道数据量大时仍可能需要进一步拆分。

## 3. 密钥面

* 前端零密钥；R2 公读无密钥。R2 发布脚本优先读取本机持久 Cloudflare API token；wrangler OAuth 仅作应急回退。
* YouTube API key 从 `YOUTUBE_API_KEY` 或 `~/.config/social-dashboard/youtube-api-key` 读取；公开数据无需 OAuth。无 key 时使用页面抓取；公开用量文件仅含聚合计数，不含密钥。
* `gh` token 走系统钥匙串。
* 远端开 `server.mjs` 必须设 `DASH_TOKEN`，否则拒绝启动（代码硬门槛）。
