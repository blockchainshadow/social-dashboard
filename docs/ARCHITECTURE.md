# 系统架构（2026-10-02）

## 1. 权威与边界

```text
浏览器 → Worker（D1 私有鉴权 / Git 配置 CAS / 任务请求）
                  ↓                  ↓
               R2 配置          本机任务执行器 → YouTube API
                                       ↓
                           SQLite 权威历史与任务（WAL）
                                       ↓
                          不可变频道分片 → 最后发布索引 → 浏览器
```

- Git 的 `channels.json` 是频道意图、分组、标签、归属的权威配置；Worker 使用 GitHub 内容 SHA 冲突重读，不用过期 R2 配置决定授权。
- `data/dashboard.sqlite` 是 YouTube 历史及本机任务的唯一写源。旧 JSON 仅一次性导入；导入校验失败则拒绝，不能导入半份历史。
- R2 只保存公开目录、频道分片、头像、用量与经过裁剪的任务状态；AES-256-GCM 加密备份也存 R2。原始 SQLite、明文凭据和密钥不发布。
- TikTok 仍使用原来的采集器、JSON 历史及本地刷新流程，未迁入 YouTube 执行器。

## 2. 本机事务与身份

`dashboard-store.mjs` 同步事务 API 使用 SQLite WAL、外键和 busy timeout；数据库及 WAL/SHM 为 600，父目录为 700。每频道一行历史 JSON，写入与版本提升在同一事务内；不是全量 JSON 文件覆盖。

官方 channel ID 是稳定身份，handle/URL/ID 只是输入或别名。同一 channel ID 合并既有历史及别名；跨所有者冲突拒绝，不能借别名夺取频道。配置删除保留 tombstone，正在采集的旧任务不能复活已删除频道。管理员显式转移归属通过配置同步生效。

同日有效记录替换并保留未返回的既有视频；保留视频带最后有效采集日期。未知统计不填零，不从陈旧值制造播放增量。每频道内容版本仅在档案/历史改变时提升；配置协调及任务变化不要求读取全部历史。

## 3. 任务执行与发布

新增：`initial`（档案及最近 50 条）→ 写 SQLite → 发布头像和频道分片 → 最后发布索引 → 完成状态 → `full`（分页全部上传列表）。普通刷新发现最近上传，并按 50 个视频 ID 批量更新已追踪视频。API 未返回公开视频、配额失败或发布失败不能冒充成功。

状态：`queued → running → collected → publishing → complete`；采集错误为 `failed`。`collected/publishing` 重试只发布已保存结果，不重新采集。租约覆盖采集和发布，活 PID 永不按固定时长抢占；死进程可接管，发布错误显式释放。远端 request ID 在事务内去重，确认响应丢失后重放仍映射原任务（包含已完成任务）。

`publicationSnapshot` 在一致性读事务中返回各频道的版本和元数据，仅带有变化频道的原始内容。构建器生成 `data/channels/<24位内容摘要>.json`，索引引用内容寻址分片；未变频道不重新序列化。发布器有独立活 PID 锁；头像、必要分片全部上传成功后才上传 `data/dashboard-index.json`，成功标记只在最后写入。`--jobs-only` 只更新公开任务状态。

主要入口：

| 文件 | 职责 |
|---|---|
| `scripts/dashboard-store.mjs` | 迁移、事务历史、别名、版本、租约、请求去重 |
| `scripts/fetch-youtube.mjs` | initial/full/refresh API 采集，视频 50 ID 批量统计 |
| `scripts/run-dashboard-jobs.mjs` | 远端请求领取、阶段顺序、重试及状态快照 |
| `scripts/build-dashboard-index.mjs` | 增量频道分片及索引 |
| `scripts/publish-r2.sh`、`scripts/r2-object.mjs` | 经 Worker R2 绑定流式上传、索引最后发布 |
| `scripts/backup-dashboard.mjs` | SQLite 一致性快照、加密、保留、下载恢复 |
| `assets/dashboard-client.mjs` | 唯一浏览器会话、管理传输、任务轮询 |
| `assets/channel-input.mjs` | 浏览器、本地服务、Worker 共用 YouTube 输入规范 |

## 4. 服务与页面

Cloudflare Pages 和 GitHub Pages 是静态页面，不运行采集器；两站都向 `https://dry-flower-a30f.xyxcliff.workers.dev` 登录及提交管理操作。本地服务代理同一鉴权，并触发本机任务；非回环启动仍要求 `DASH_TOKEN`，不能用其替代普通浏览器会话。线上 TikTok 刷新返回原本地流程提示，不伪造任务完成。

`index.html` 是唯一页面源码，`sync-static.sh` 单向生成 `web/index.html` 小文件镜像并调整相对模块路径；不复制完整历史或数据库。GitHub Pages 的子路径通过相对模块 URL 支持。

浏览器先读取小型索引，再按需加载当前频道历史，复用内容版本缓存。索引时间是「发布于」，视频明细另有最后有效采集时间；「检查发布」不触发采集。当前账号固定排在顶栏首位；管理员默认自己频道，「全员」切换全部。**公开数据仍可直接读取，成员过滤不是数据保密机制。**

## 5. 鉴权与秘密

私有 D1 校验密码，成功后签发 8 小时随机会话，只存 token SHA-256 摘要。每个管理请求由 Worker 校验会话、版本、角色和最新频道归属；退出删除会话，换密提升账号版本并撤销该账号所有会话。

旧公开 SHA-256 密码哈希迁入私有 D1，成功明文登录后升级 PBKDF2-SHA256（100,000 次）并强制换密；换密前管理返回 403。`users.json` 不再发布，旧 `{username, pass}` 请求不接受。旧 Git 历史无法撤回，旧密码必须更换。

`GH_TOKEN` 和 `RUNNER_TOKEN` 是 Worker secrets。采集器 token 只在本机 600 文件及 Worker 中，内部发布接口只允许指定公开路径，不能读写凭据或删除任意 R2 对象。YouTube key 与备份加密密钥也只存本机 600 文件；备份密钥须另存安全离线副本。Worker 部署与持续采集/上传认证分开。

## 6. 调度与成本

watch 每 2 分钟同步配置、接收请求及补采新频道；daily 当前为每日 09:30，批量刷新后创建远端加密备份；用量每小时 17 分。以 `crontab -l` 为准。Git PID 锁仅覆盖 Git 操作，不挡采集；原 `.fetch-lock` 15 分钟抢占机制已不再使用。

YouTube 默认 10,000 units/太平洋时间日；`youtube-quota.mjs` 请求前跨进程预留，本机默认及硬上限 9000，失败请求也计入。计数或锁损坏、Google 配额耗尽时停止 API；不能删除当日计数绕过。API 分类不可靠的 Shorts/会员字段保持未知。官方费用及字段说明见 `youtube-api-quota-research.md`；本机记账不包含同一项目其它客户端。

R2 免费额 10GB、A 类 100 万/月、B 类 1000 万/月，流出免费；Workers/Pages 以控制台实际套餐为准。首屏只下当前频道，但单频道历史仍可能较大。备份默认本地保留 7 份、远端 30 份；离线恢复不覆盖非空目录或运行库。
