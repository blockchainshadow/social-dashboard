#!/usr/bin/env node
// 从 data/youtube-history.json 生成 dashboard 索引与按频道分片
// 输出：
//   - data/dashboard-index.json  （小索引：updatedAt + channels[handle].{info,path,version}）
//   - data/channels/${sha256(handle).slice(0,24)}.json  （单个频道的完整 {info,records}）
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';

const SRC = 'data/youtube-history.json';
const OUT_DIR = 'data/channels';
const INDEX_PATH = 'data/dashboard-index.json';

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function build() {
  if (!(await exists(SRC))) {
    console.error(`[build-dashboard-index] 源文件不存在：${SRC}，跳过`);
    process.exit(0);
  }

  const raw = await readFile(SRC, 'utf8');
  const data = JSON.parse(raw);
  const handles = Object.keys(data.channels || {}).sort();

  await mkdir(OUT_DIR, { recursive: true });

  const index = {
    updatedAt: data.updatedAt || new Date().toISOString(),
    channels: {},
  };

  for (const handle of handles) {
    const channel = data.channels[handle];
    const content = JSON.stringify(channel);
    const hash = sha256(handle).slice(0, 24);
    const version = sha256(content).slice(0, 16);
    const path = `data/channels/${hash}.json`;
    const shardPath = `${OUT_DIR}/${hash}.json`;

    // 只有内容变化才写盘，减少无意义的 I/O
    let needWrite = true;
    if (await exists(shardPath)) {
      const existing = await readFile(shardPath, 'utf8');
      if (existing === content) needWrite = false;
    }
    if (needWrite) {
      await writeFile(shardPath, content, 'utf8');
    }

    index.channels[handle] = {
      info: channel.info,
      path,
      version,
    };
  }

  const indexContent = JSON.stringify(index);
  let needWriteIndex = true;
  if (await exists(INDEX_PATH)) {
    const existing = await readFile(INDEX_PATH, 'utf8');
    if (existing === indexContent) needWriteIndex = false;
  }
  if (needWriteIndex) {
    await writeFile(INDEX_PATH, indexContent, 'utf8');
  }

  console.log(`[build-dashboard-index] channels=${handles.length} index=${INDEX_PATH}`);
}

build().catch((err) => {
  console.error('[build-dashboard-index] 失败:', err);
  process.exit(1);
});
