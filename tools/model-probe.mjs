#!/usr/bin/env node
/**
 * SYMBIO · 免费档健康探针 + 有序兜底链（零依赖，纯本地）
 *
 * 用途：在重活开工前，先看清哪些免费模型活着、哪些已死，并给出一条
 *      “免费优先、死模自动跳过”的有序兜底链。对应 AGENTS.md 硬规则第 5 条。
 *
 * 用法：
 *   node tools/model-probe.mjs            # 人读看板
 *   node tools/model-probe.mjs --json     # 机器可读（给上层判定用）
 *   node tools/model-probe.mjs --chain    # 只打印可用兜底链（一行一个）
 *
 * 退出码：始终 0（探针不阻断），判定交给 spend-guard / 调用方。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';

// OFM 数据目录：可用 SYMBIO_OFM_DIR 覆盖；默认取 DSH 用户目录
const OFM_DIR = process.env.SYMBIO_OFM_DIR || path.join(HOME, '.dsh', 'our-free-model');

// 免费优先的有序兜底链（越靠前越优先；全是免费/可零成本尝试的）
const FREE_CHAIN = [
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'mimo-v2.6-flash-free',
  'flint-40b-free',
  'beam-free',
  'pulse-alpha-free',
  'big-pickle',
];
// 付费兜底（免费全挂时才降级；由 spend-guard 决定是否允许）
const PAID_CHAIN = ['glm-5.3-flash', 'deepseek-v4.1-flash', 'step-5-preview'];

// 显式死亡状态（stale 只作新鲜度提示，不判死）
const DEAD_STATES = new Set(['throttled', 'region-blocked', 'unavailable', 'dead', 'blocked', 'deprecated']);

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}
function now() { return Date.now(); }
function ageDays(ms) {
  if (!ms) return null;
  return (now() - ms) / 86400000;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const chainOnly = argv.includes('--chain');

  const catalog = readJson(path.join(OFM_DIR, 'catalog.json'), { entries: [], kiloRows: [], sealIds: [] });
  const avail = readJson(path.join(OFM_DIR, 'availability.json'), { results: {} });
  const stats = readJson(path.join(OFM_DIR, 'stats.json'), { days: {} });

  const results = avail.results || {};
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const kiloIds = (Array.isArray(catalog.kiloRows) ? catalog.kiloRows : []).map((r) => r.id).filter(Boolean);

  // 汇总最近 3 天的失败率（仅作参考，不判死）
  const recentDays = Object.keys(stats.days || {}).sort().slice(-3);
  const failRate = {};
  let totalCalls = 0, totalFailed = 0;
  for (const d of recentDays) {
    const models = stats.days[d]?.models || {};
    for (const [id, m] of Object.entries(models)) {
      const c = Number(m.calls || 0), f = Number(m.failed || 0);
      if (!failRate[id]) failRate[id] = { calls: 0, failed: 0 };
      failRate[id].calls += c; failRate[id].failed += f;
      totalCalls += c; totalFailed += f;
    }
  }
  const overallFailPct = totalCalls ? (totalFailed / totalCalls) * 100 : null;

  function classify(id) {
    const a = results[id];
    if (!a) return { state: 'no-data', dead: false, stale: null, detail: '无探针记录' };
    const st = String(a.state || 'unknown').toLowerCase();
    const dead = DEAD_STATES.has(st) || (a.detail && /deprecated/i.test(a.detail));
    const stale = a.stale === true || (ageDays(a.at) != null && ageDays(a.at) > 7);
    return { state: st, dead, stale, detail: a.detail || '', latencyMs: a.latencyMs };
  }

  // 组成有序链：免费链（catalog 里实际存在的优先，其余补末尾）→ kilo → 付费
  const catalogFree = FREE_CHAIN.filter((id) => entries.includes(id) || !entries.length);
  const extraFree = entries.filter((id) => !FREE_CHAIN.includes(id));
  const orderedFree = [...catalogFree, ...extraFree];
  const chain = [
    ...orderedFree.map((id) => ({ id, tier: 'free' })),
    ...kiloIds.map((id) => ({ id, tier: 'free-kilo' })),
    ...PAID_CHAIN.map((id) => ({ id, tier: 'paid' })),
  ].map((x) => ({ ...x, ...classify(x.id) }));

  const aliveFree = chain.filter((x) => x.tier !== 'paid' && !x.dead && x.state !== 'no-data');
  const dead = chain.filter((x) => x.dead);
  const unknown = chain.filter((x) => x.tier !== 'paid' && !x.dead && x.state === 'no-data');
  const usableChain = chain.filter((x) => !x.dead);

  // catalog 之外的历史/退役死模（不在兜底链内，仅作说明）
  const chainIds = new Set(chain.map((x) => x.id));
  const offCatalogDead = Object.entries(results).filter(([id, a]) => {
    if (chainIds.has(id) || !a || typeof a !== 'object') return false;
    const st = String(a.state || '').toLowerCase();
    return DEAD_STATES.has(st) || (a.detail && /deprecated/i.test(a.detail));
  }).length;

  if (json) {
    console.log(JSON.stringify({
      ofmDir: OFM_DIR,
      overallFailPct: overallFailPct == null ? null : +overallFailPct.toFixed(1),
      aliveFree: aliveFree.map((x) => x.id),
      dead: dead.map((x) => ({ id: x.id, state: x.state, detail: x.detail })),
      offCatalogDead,
      unknown: unknown.map((x) => x.id),
      usableChain: usableChain.map((x) => ({ id: x.id, tier: x.tier, state: x.state })),
    }, null, 2));
    process.exit(0);
  }

  if (chainOnly) {
    for (const x of usableChain) console.log(x.id);
    process.exit(0);
  }

  console.log('\n=== SYMBIO 免费档健康探针 ===\n');
  console.log(`OFM 数据：${OFM_DIR}`);
  if (overallFailPct != null) {
    const flag = overallFailPct >= 15 ? '⚠ 逼近/超过红线 15%' : '正常';
    console.log(`近 3 日整体失败率：${overallFailPct.toFixed(1)}%（${flag}）`);
  } else {
    console.log('近 3 日失败率：无数据');
  }

  console.log('\n--- 免费档 ---');
  for (const x of chain.filter((c) => c.tier !== 'paid')) {
    const mark = x.dead ? '✗ 已死' : x.state === 'no-data' ? '? 无记录' : '✓ 可尝试';
    const stale = x.stale ? '（记录陈旧）' : '';
    console.log(`  ${mark}  ${x.id}  [${x.state}]${stale}`);
    if (x.dead && x.detail) console.log(`         └ ${String(x.detail).slice(0, 90)}`);
  }

  console.log('\n--- 付费兜底（仅在免费全挂且 spend-guard 放行时用） ---');
  for (const x of chain.filter((c) => c.tier === 'paid')) {
    console.log(`  ${x.dead ? '✗ 已死' : '· 备选'}  ${x.id}`);
  }

  console.log('\n--- 有序可用兜底链（复制即用） ---');
  console.log(usableChain.map((x) => x.id).join(' → '));

  if (dead.length) {
    console.log(`\n提示：兜底链内 ${dead.length} 个免费档已死，已自动跳过。`);
  } else {
    console.log('\n提示：兜底链内未发现显式死亡的免费档。');
  }
  if (offCatalogDead) console.log(`（catalog 外另有 ${offCatalogDead} 个历史/退役死模，不在链内，已忽略）`);
  console.log('');
  process.exit(0);
}

main();
