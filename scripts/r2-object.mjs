#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function putObject(file, key, contentType, cacheControl = 'no-store') {
  const bucket = process.env.R2_BUCKET ?? 'social-dashboard-data';
  if (bucket !== 'social-dashboard-data') throw new Error('当前 Worker 仅绑定 social-dashboard-data');
  const token = (process.env.DASHBOARD_RUNNER_TOKEN ?? await readFile(path.join(os.homedir(), '.config/social-dashboard/runner-token'), 'utf8')).trim();
  if (!token) throw new Error('未配置 runner-token');
  const size = (await stat(file)).size;
  if (size > 100 * 1024 * 1024) throw new Error(`对象超过 Worker 单次上传限制：${key}`);
  const relay = process.env.DASHBOARD_RELAY ?? 'https://dry-flower-a30f.xyxcliff.workers.dev';
  const stream = createReadStream(file);
  try {
    const response = await fetch(`${relay}/internal/publication-object?key=${encodeURIComponent(key)}`, {
      method: 'PUT', duplex: 'half', body: Readable.toWeb(stream),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Cache-Control': cacheControl, 'Content-Length': String(size) },
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`R2 发布 ${key} 失败（HTTP ${response.status}）：${result.error ?? '未确认写入'}`);
    return { key, bytes: size };
  } finally { stream.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, file, key, contentType, cacheControl] = process.argv.slice(2);
    if (command !== 'put' || !file || !key || !contentType) throw new Error('用法：node scripts/r2-object.mjs put <文件> <对象key> <content-type> [cache-control]');
    console.log(JSON.stringify(await putObject(file, key, contentType, cacheControl)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
