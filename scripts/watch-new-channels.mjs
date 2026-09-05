#!/usr/bin/env node
// 增量补充采集：检测 channels.json 中尚未入库的新频道，直接全量抓取
// 由 launchd 每 2 分钟调用（watch-local.sh）；新频道添加后一次抓完，无需依赖每日任务补齐
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
    item.all = true; // 新频道直接全量抓取，添加即完整
    const result = await syncChannel(item);
    const { ch, safeName } = mergeIntoHistory(history, result);
    if (result.profile.avatar?.startsWith("http")) {
      const remote = result.profile.avatar;
      ch.info.avatar = (await cacheAvatar(remote, safeName)) ?? remote;
      ch.info.avatarRemote = remote;
    }
    dirty = true;
    console.log(`✓ ${item.handle} 全量入库`);
  } catch (e) {
    console.error(`✗ ${item.handle}: ${e0(e)}`);
  }
}
if (!dirty) process.exit(1);
await saveHistory(history);
await writeConfig(channels);
console.log("快速快照已写入");
