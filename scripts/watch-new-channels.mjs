#!/usr/bin/env node
// 增量补充采集：检测 channels.json 中尚未入库的新频道，快速抓取（首页+RSS）
// 由 launchd 每 5 分钟调用（watch-local.sh）；全量补齐仍由每日 9:30 任务负责
import { syncChannel, mergeIntoHistory, loadHistory, saveHistory, readConfig, writeConfig, cacheAvatar } from "./fetch-youtube.mjs";

const e0 = (e) => String(e?.message ?? e).slice(0, 160);

const history = await loadHistory();
const channels = await readConfig();
const fresh = channels.filter((c) => {
  const h = c.handle.startsWith("@") ? c.handle : "@" + c.handle;
  return !history.channels[h];
});
if (fresh.length === 0) {
  console.log("无新增频道");
  process.exit(0);
}
console.log(`发现新增频道: ${fresh.map((c) => c.handle).join(", ")}`);

let dirty = false;
for (const item of fresh) {
  try {
    const result = await syncChannel(item); // 无 all 标记 → 快速模式
    const { ch, safeName } = mergeIntoHistory(history, result);
    if (result.profile.avatar?.startsWith("http")) {
      const remote = result.profile.avatar;
      ch.info.avatar = (await cacheAvatar(remote, safeName)) ?? remote;
      ch.info.avatarRemote = remote;
    }
    if (!item.all) item.all = true; // 标记全量，交给每日 9:30 任务补齐历史
    dirty = true;
    console.log(`✓ ${item.handle} 快速入库`);
  } catch (e) {
    console.error(`✗ ${item.handle}: ${e0(e)}`);
  }
}
if (!dirty) process.exit(1);
await saveHistory(history);
await writeConfig(channels);
console.log("快速快照已写入");
