# 社交平台数据看板（YouTube + TikTok）

53 个 YouTube 频道的公开数据看板：订阅、播放、点赞趋势 + 分组/标签管理。

## 线上地址

| 入口 | 地址 | 说明 |
|---|---|---|
| 主站（Cloudflare Pages） | `https://social-dashboard-9ya.pages.dev/` | Git push 自动构建，纯静态只读 |
| 备用（GitHub Pages） | `https://blockchainshadow.github.io/social-dashboard/` | 同读一份 R2 数据 |
| 本地管理 | `http://127.0.0.1:8000/web/` | `node server.mjs`，可增删账号、刷新 |

> 静态站首次打开需下载约 93MB 全量快照（约半分钟），属正常。admin 登录后点 `🌍 全员` 查看全部频道。

## 数据链路（一句话）

本机 cron 采集 → 直推 Cloudflare R2（真数据源）→ 浏览器从 R2 读；Git 仓库只存代码/配置/头像。

* 可视化拓扑：`docs/topology.html`（双击打开）
* 架构细节：`docs/ARCHITECTURE.md`
* 运维手册（cron / R2 / Pages / 排障）：`docs/OPERATIONS.md`

## 本地开发

```bash
node server.mjs            # 127.0.0.1:8000，管理 API 全开（仅回环）
node server.mjs 8000       # 同上，显式端口
```

* 非回环访问必须设 `DASH_TOKEN`（见 `server.mjs` 顶部注释）。
* 定时任务见 `crontab -l`：watch（2min）、daily（3:00）、用量（每小时 17 分）。
