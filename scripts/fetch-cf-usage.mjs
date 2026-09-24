#!/usr/bin/env node
// Cloudflare 用量拉取（R2 操作/存储 + Workers 今日请求），写入 data/cf-usage.json
// 用法: node scripts/fetch-cf-usage.mjs
// token 来源（按序）：$CLOUDFLARE_API_TOKEN 或 ~/.config/social-dashboard/cloudflare-token
// token 权限：Account / Account Analytics / Read（dashboard 自建 custom token）
// 定时：cron 每小时跑一次（analytics 有数分钟延迟，跑更频没意义）

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "dae5b22149a323b7771a9cafd1bd1ce3";
const OUT_FILE = path.resolve("data/cf-usage.json");
const FREE = { storageGB: 10, classA: 1_000_000, classB: 10_000_000, workersDay: 100_000 };
const PRICE = { storageGBmo: 0.015, classA_M: 4.5, classB_M: 0.36 };

// token 来源（按序，全自动，无需配置）：
//   1. $CLOUDFLARE_API_TOKEN（如有自建 token 优先）
//   2. ~/.config/social-dashboard/cloudflare-api-token（持久 token，cron 无人值守用）
//   3. 本机 wrangler OAuth 登录态（会过期，仅过渡）
//   4. ~/.config/social-dashboard/cloudflare-token（备用）
async function loadToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  for (const p of [
    path.join(os.homedir(), ".config", "social-dashboard", "cloudflare-api-token"),
    path.join(os.homedir(), ".config", "social-dashboard", "cloudflare-token"),
  ]) {
    try {
      const t = (await readFile(p, "utf8")).trim();
      if (t) return t;
    } catch {}
  }
  for (const p of [
    path.join(os.homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
  ]) {
    try {
      const txt = await readFile(p, "utf8");
      const m = txt.match(/^oauth_token\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    } catch {}
  }
  return "";
}

// actionType -> 计费类别（Delete 系免费；读/列系为 B；其余写入系为 A）
function opClass(actionType) {
  const a = String(actionType ?? "");
  if (/^Delete/i.test(a)) return "free";
  if (/^(List|Head|Get)/i.test(a)) return "B";
  return "A";
}

async function gql(token, query, variables) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (!res.ok || j.errors?.length) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j.data;
}

const iso = (d) => d.toISOString();
const now = new Date();

async function main() {
  const token = await loadToken();
  if (!token) {
    console.error("缺 CLOUDFLARE_API_TOKEN（或 ~/.config/social-dashboard/cloudflare-token），跳过");
    process.exitCode = 2;
    return;
  }
  const dayAgo = iso(new Date(now - 24 * 3600e3));
  const d30Ago = iso(new Date(now - 30 * 24 * 3600e3));
  const d2Ago = iso(new Date(now - 2 * 24 * 3600e3));

  const WQ = `query($accountTag:String!,$since:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
    workersInvocationsAdaptive(filter:{datetime_geq:$since},limit:10000){sum{requests errors}}
  }}}`;
  const OQ = `query($accountTag:String!,$since:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
    r2OperationsAdaptiveGroups(filter:{datetime_geq:$since},limit:10000){sum{requests}dimensions{actionType}}
  }}}`;
  const SQ = `query($accountTag:String!,$since:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
    r2StorageAdaptiveGroups(filter:{datetime_geq:$since},limit:10000){
      max{payloadSize metadataSize objectCount}dimensions{bucketName datetime}
    }
  }}}`;

  const [w, o, s] = await Promise.all([
    gql(token, WQ, { accountTag: ACCOUNT_ID, since: dayAgo }),
    gql(token, OQ, { accountTag: ACCOUNT_ID, since: d30Ago }),
    gql(token, SQ, { accountTag: ACCOUNT_ID, since: d2Ago }),
  ]);

  const acc = (d) => d?.viewer?.accounts?.[0] ?? {};
  let workersToday = 0;
  for (const r of acc(w).workersInvocationsAdaptive ?? []) workersToday += r?.sum?.requests ?? 0;

  let classA = 0, classB = 0;
  for (const r of acc(o).r2OperationsAdaptiveGroups ?? []) {
    const n = r?.sum?.requests ?? 0;
    const c = opClass(r?.dimensions?.actionType);
    if (c === "A") classA += n;
    else if (c === "B") classB += n;
  }

  // 取最新时间点的存储行（按 bucket 去重后加总）
  const rows = acc(s).r2StorageAdaptiveGroups ?? [];
  const latest = new Map();
  for (const r of rows) {
    const b = r?.dimensions?.bucketName ?? "default";
    const t = Date.parse(r?.dimensions?.datetime ?? "") || 0;
    if (!latest.has(b) || t > latest.get(b).t) latest.set(b, { t, r });
  }
  let bytes = 0, objects = 0;
  for (const { r } of latest.values()) {
    bytes += (r?.max?.payloadSize ?? 0) + (r?.max?.metadataSize ?? 0);
    objects += r?.max?.objectCount ?? 0;
  }
  const storageGB = bytes / 1024 ** 3;

  const rawUSD = storageGB * PRICE.storageGBmo + (classA / 1e6) * PRICE.classA_M + (classB / 1e6) * PRICE.classB_M;
  const overFree = storageGB > FREE.storageGB || classA > FREE.classA || classB > FREE.classB;
  const out = {
    updatedAt: now.toISOString(),
    window: { workersHours: 24, opsDays: 30 },
    workers: { requestsToday: workersToday, limit: FREE.workersDay },
    r2: {
      storageGB: Math.round(storageGB * 1000) / 1000,
      storageLimitGB: FREE.storageGB,
      objects,
      classA, classALimit: FREE.classA,
      classB, classBLimit: FREE.classB,
    },
    billing: {
      estimatedUSD: Math.round(rawUSD * 1000) / 1000,
      billableUSD: overFree ? Math.round(rawUSD * 1000) / 1000 : 0,
      note: overFree ? "超出免费额度，按量计费" : "免费额度内",
    },
  };
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`已写入 ${path.relative(process.cwd(), OUT_FILE)}: R2 ${out.r2.storageGB}GB/${objects}obj A=${classA} B=${classB} workers24h=${workersToday} 预估$${out.billing.estimatedUSD}`);
}

await main();
