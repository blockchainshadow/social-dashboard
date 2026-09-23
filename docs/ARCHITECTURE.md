# 系统架构（2026-09-24 现状）

可视化版：`docs/topology.html`。下文是同一内容的文字版，以代码实现为准。

## 1. 分层

```
数据源 → 采集层（本机 Mac）→ 存储层（R2 主 / Git 次）→ 服务层 → 浏览器
```

### ① 数据源

* **YouTube**：频道页 `ytInitialData`（档案 + 首屏视频）→ innertube `browse` 翻页补全（普通 + Shorts）→ `watch` 页精确播放/点赞/时长 → RSS 校准发布时间。反爬：UA + `bpctr` + 重试。
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
* `publish-r2.sh`：增量发布。`data/*.json` 等三份 JSON 做整体 hash，未变 0.2s 跳过；头像只传 `git status` 感知到的新增（`--full` 全传）。认证复用本机 wrangler OAuth，无密钥。
* `sync-static.sh`：根目录 ↔ `web/` 镜像同步（`web/` 是遗留副本）。

### ③ 存储层

* **R2（真数据源）**：bucket `social-dashboard-data`。keys：`data/youtube-history.json`（约 93MB）、`avatars/*.jpg`（54 个，约 5MB）、`channels.json`、`users.json`、`cf-usage.json`。公读经 `r2.dev` + CORS `GET,HEAD *`。现状 0.096GB / 57 对象。
* **Git（代码+配置）**：`blockchainshadow/social-dashboard`，`main`。93MB 快照已 `gitignore`（本地文件保留）。`.git` 历史 2.4G（全是旧快照），clone 慢请 `--depth 1`。`v1.0a` 为浮动快照标记。
* **本地**：`data/`、`avatars/`、`backups/`、`logs/`（运行产物，均 ignore）。

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

顶栏 `☁️` 徽标：读 R2 `cf-usage.json`，显示 `存储占比% · 对象数 · $账单`；任一维度超 80% 黄、超 90% 红；文件缺失自动隐藏。

## 2. 免费额度与红线（2026-09 实测口径）

R2：10GB 存储 / A 类 100 万 / B 类 1000 万 / 月，流出免费。Workers：日 10 万次。Pages：月 500 构建。

现状用量全部 <1%（R2 0.96% · 预估 $0.002 · 账单 $0）。风险排序：① r2.dev 公网限速（人多换自定义域）② 93MB 首屏下载（人多拆包：`summary.json` + 按频道懒加载）③ LFS 已否决（93MB 日更 10 天烧穿 1GB 配额）。

## 3. 密钥面

* 前端零密钥；R2 公读无密钥。
* wrangler OAuth token 存本机（`~/Library/Preferences/.wrangler/config/default.toml`），cron 同用户复用；`gh` token 走系统钥匙串。
* 远端开 `server.mjs` 必须设 `DASH_TOKEN`，否则拒绝启动（代码硬门槛）。
