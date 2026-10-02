# 社交平台数据看板（YouTube + TikTok）

YouTube 公开数据看板：订阅、播放、点赞趋势 + 分组/标签管理。

## 线上地址

| 入口 | 地址 | 说明 |
|---|---|---|
| 主站（Cloudflare Pages） | `https://social-dashboard-9ya.pages.dev/` | Git push 自动构建，纯静态只读 |
| 备用（GitHub Pages） | `https://blockchainshadow.github.io/social-dashboard/` | 同读一份 R2 数据 |
| 本地管理 | `http://127.0.0.1:8000/web/` | `node server.mjs`，可增删账号、刷新 |

> 静态站先读取小型频道索引，再只下载当前频道的历史分片；切换频道时按需加载并复用已加载的数据。admin 登录后点 `🌍 全员` 查看全部频道。

## 数据链路（一句话）

本机 cron 采集 → 直推 Cloudflare R2（真数据源）→ 浏览器从 R2 读；Git 仓库只存代码/配置/头像。

* 可视化拓扑：`docs/topology.html`（双击打开）
* 架构细节：`docs/ARCHITECTURE.md`
* 运维手册（cron / R2 / Pages / 排障）：`docs/OPERATIONS.md`

## YouTube 混合采集

`scripts/fetch-youtube.mjs` 优先用 YouTube Data API 获取频道统计及最近 50 条视频的精确数据；频道页提供关键词、外链及视频列表，`channels.json` 中 `all: true` 时继续翻页枚举普通视频和 Shorts。列表里其余视频按 50 个 ID 一批从 API 补齐播放、点赞、时间、时长等；API 未返回的视频沿用页面/watch/RSS 数据。频道页或翻页失败时，本次可能仅抓到 API 最近 50 条，但合并快照会保留先前已追踪的视频；旧视频显示「未更新」及最后采集日期，不表示本次刷新了它们的指标。API 不可用或达到脚本配额上限时回退页面采集；日志会提示降级。

看完整的视频列表：在页面上方选择频道，再点「终身」。默认「7天」仅展示范围内发布的视频。线上「数据刷新」只检查 R2 已发布的新快照，**不会**发起全量采集；全量采集需在本机确保该频道配置 `all: true` 后运行 `node scripts/fetch-youtube.mjs --only @频道handle`，再运行 `bash scripts/publish-r2.sh`。本机服务的「数据刷新」会重新采集该频道；如果 YouTube 翻页失败，既有视频仍保留但指标标记「未更新」。

密钥从 `YOUTUBE_API_KEY` 或 `~/.config/social-dashboard/youtube-api-key` 读取，不需要 Google OAuth。YouTube Data API 默认每太平洋时间自然日 10,000 units；`channels.list`、`playlistItems.list`、`videos.list` 每请求各 1 unit，失败请求也计入。脚本在发送请求前通过 `logs/.yt-quota-YYYY-MM-DD` 和目录锁跨进程预留，`YT_QUOTA_CAP` 默认为 9000、最高 9000（留 1000 units 余量）；太平洋时间午夜重置。达到上限、Google 报配额耗尽、计数文件损坏或锁超时即停用 API，回退页面采集。异常退出留下的 `logs/.yt-quota-lock-YYYY-MM-DD` 不会自动抢锁：确认所有采集进程已退出后才能手动移除该锁，**不要**清空当天计数/阻断文件。官方来源见 `docs/youtube-api-quota-research.md`。

顶栏 `YT API` 徽标展示当天本机已预留/上限及百分比，和 Cloudflare 用量同样按超过 80% 变黄、超过 90% 变红，暂停时直接变红；`bash scripts/publish-r2.sh` 更新并发布 `data/youtube-api-usage.json`（只有日期、计数、上限、暂停状态和更新时间，不含密钥）。此限制仅涵盖**本机运行此脚本**的请求：同一 Google Cloud 项目若有其它客户端或更低的实际配额，脚本无法代它们记账，须在 Google Cloud 控制台核对项目额度/其它用量并设置相应限制。

## 页面数据发布

本机 `data/youtube-history.json` 是唯一原始历史数据，不能删除。`node scripts/build-dashboard-index.mjs` 从它生成 `data/dashboard-index.json` 与 `data/channels/*.json`（生成物不进 Git）；`bash scripts/publish-r2.sh` 仅上传变更的频道分片，**最后上传索引**。首次部署必须先确认索引及分片发布成功，再发布新版 `index.html`；发布失败会返回非零码，下次自动重试。`--full` 可补传全部分片。

静态站每次打开只检查索引；频道分片 URL 按内容版本缓存，点击「数据刷新」也只检查索引是否变更，不再下载整份历史。若本地使用静态服务器预览，先生成索引；本地服务默认仍从 R2 读取已发布数据。

## 本地开发

```bash
node server.mjs            # 127.0.0.1:8000，管理 API 全开（仅回环）
node server.mjs 8000       # 同上，显式端口
```

* 非回环访问必须设 `DASH_TOKEN`（见 `server.mjs` 顶部注释）。
* 定时任务见 `crontab -l`：watch（2min）、daily（3:00）、用量（每小时 17 分）。
