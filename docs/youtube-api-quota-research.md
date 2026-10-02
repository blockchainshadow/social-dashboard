# YouTube Data API v3 官方配额研究

> 研究日期：2026-10-02  
> 研究范围：官方配额/计费/分页/扩容规则，仅引用 YouTube 官方文档，不涉及密钥或用户数据。

## 1. 默认每日配额

- **10,000 units/天**：启用 YouTube Data API 的项目，默认“所有其他端点”合计配额为 **10,000 单位/天**。[^1][^2]
- **两个独立桶**：
  - `search.list` 有独立的 **100 次/天** 配额桶，每次调用消耗 1 单位。[^2]
  - `videos.insert` 也有独立的 **100 次/天** 配额桶，每次调用消耗 1 单位。[^2]
- 配额使用情况在 Google Cloud Console 的 **Quotas** 页面查看。[^1][^2]

## 2. 目标方法单次请求成本

| 方法 | 配额成本 | 官方来源 |
|---|---|---|
| `channels.list` | **1 unit/次** | [Channels: list](https://developers.google.com/youtube/v3/docs/channels/list)[^3] |
| `playlistItems.list` | **1 unit/次** | [PlaylistItems: list](https://developers.google.com/youtube/v3/docs/playlistItems/list)[^4] |
| `videos.list` | **1 unit/次** | [Videos: list](https://developers.google.com/youtube/v3/docs/videos/list)[^5] |

> 注：这些成本属于“所有其他端点”池，与 `search.list`、`videos.insert` 的独立 100 次/天桶不同。

完整配额成本表可参考官方 [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)。

## 3. 分页规则与配额影响

### 3.1 通用分页机制

- 列表方法通过 `pageToken` 翻页；响应中的 `nextPageToken` / `prevPageToken` 用于请求下一页/上一页。[^3][^4][^5]
- **每一页都是一次独立 API 请求**，均需按该方法的成本计费。官方明确说明：如果调用返回多页结果（如 `search.list`），每多请求一页都会再次产生估计配额成本。[^2]

### 3.2 单页最大结果数

| 方法 | `maxResults` 范围 | 默认值 | 说明 |
|---|---|---|---|
| `channels.list` | 0 – 50 | 5 | [^3] |
| `playlistItems.list` | 0 – 50 | 5 | [^4] |
| `videos.list` | 1 – 50 | 5 | 仅与 `myRating` 联用；与 `id` 联用时 `maxResults` / `pageToken` 不受支持。[^5] |

### 3.3 实际采集估算示例

假设使用 `maxResults=50` 翻页：

- 采集 1 个频道的信息：1 次 `channels.list` → **1 unit**
- 采集该频道上传列表 1000 个视频：1000 / 50 = 20 次 `playlistItems.list` → **20 units**
- 拉取这 1000 个视频的元数据：按 `id` 批量，每次最多 50 个 ID，需 20 次 `videos.list` → **20 units**

合计约 **41 units**（千视频级）。在不触发 `search.list` 的情况下，10,000 units/天 大约可支撑约 **24 万视频** 的完整元数据拉取（粗略上限，实际受并发与频道路由影响）。

## 4. 失败请求是否计费

- 官方明确：**“Every API request, even if invalid, will cost at least one quota point.”**[^2]
- 也就是说，所有 API 请求——包括无效请求——都会消耗至少 1 单位配额。
- **不确定点**：文档未专门说明因“配额已耗尽（`quotaExceeded`）”而被拒绝的请求是否再扣 1 单位。按“every API request”字面理解，失败请求仍会计费，但这一点未在错误码章节中单独确认。

## 5. 配额重置时间

- **每日配额在太平洋时间（PT）午夜重置**（“Daily quotas reset at midnight Pacific Time (PT)”）。[^2]
- 北京时间（CST/UTC+8）约为次日 15:00/16:00，取决于夏令时。

## 6. 扩容/申请额外配额

- 超出默认配额需要提交 **Audit and Quota Extension Form** 并通过合规审计。[^1]
- 申请前提：证明项目符合 [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/developer-policies)。[^1]
- 流程：
  1. 填写 [YouTube API Services - Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form)。
  2. YouTube API Services 团队会联系项目负责人。
  3. 若 12 个月内已完成合规审计但还需更多配额，可再次提交同一表单申请额外扩展。[^1]
- **条件性/不确定性**：
  - 额外配额并非自动 granted，需人工审核。
  - 大型项目/商业用途必须提供使用场景说明并证明无滥用风险。
  - 项目控制权变更（并购、股权转让等）必须提交 Change of Control Form。[^1]

## 7. 关键结论与注意事项

1. **免费额度**：默认 10,000 units/天 + `search.list` 100 次/天 + `videos.insert` 100 次/天。
2. **本项目常用读取方法成本**：`channels.list`、`playlistItems.list`、`videos.list` 均为 **1 unit/请求**。
3. **分页即多请求**：翻页不会降低单请求成本，每页都按 1 unit（或对应方法成本）计费。
4. **失败也扣配额**：无效/失败请求至少扣 1 unit。
5. **重置时区**：太平洋时间午夜（PT）。
6. **扩容非自动**：需提交审计表单、证明合规，由 YouTube 团队审批。

## 参考来源

[^1]: [Quota and Compliance Audits | YouTube Data API](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)（最后更新 2026-09-14 UTC）
[^2]: [Quota Calculator | YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost)（最后更新 2026-09-15 UTC）
[^3]: [Channels: list | YouTube Data API](https://developers.google.com/youtube/v3/docs/channels/list)（最后更新 2026-09-14 UTC）
[^4]: [PlaylistItems: list | YouTube Data API](https://developers.google.com/youtube/v3/docs/playlistItems/list)（最后更新 2026-10-02）
[^5]: [Videos: list | YouTube Data API](https://developers.google.com/youtube/v3/docs/videos/list)（最后更新 2026-09-14 UTC）
