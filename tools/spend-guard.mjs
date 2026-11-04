#!/usr/bin/env node
/**
 * SYMBIO · 预算硬闸 + 免费优先判定（零依赖，纯本地）
 *
 * 背景（本对话已查实）：DSH 0.2.1 原生不读取 config.cost.dailyBudgetCNY 这类
 * 配置闸门。所以“硬闸”不能靠配置，必须靠“工具 + 开工前纪律”落地——
 * 本脚本就是那个工具：付费调用前先跑它，STOP 就中止，GO/CAUTION 才继续。
 *
 * 用法：
 *   node tools/spend-guard.mjs                      # 人读判定
 *   node tools/spend-guard.mjs --json               # 机器可读
 *   node tools/spend-guard.mjs --record 0.12        # 记一笔花费(CNY)，累计到今日台账
 *   node tools/spend-guard.mjs --record 0.12 --fail # 记一笔“失败调用”（不计费但计失败）
 *
 * 退出码：0 = GO / CAUTION（放行）；2 = STOP（必须中止付费调用）
 *
 * 台账：memory/10-shared/花费台账.json（人可读、可手改、可提交）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'symbio.config.json');
const LEDGER_PATH = path.join(ROOT, 'memory', '10-shared', '花费台账.json');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const OFM_DIR = process.env.SYMBIO_OFM_DIR || path.join(HOME, '.dsh', 'our-free-model');

const DEAD_STATES = new Set(['throttled', 'region-blocked', 'unavailable', 'dead', 'blocked', 'deprecated']);

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const asFail = argv.includes('--fail');
  const recIdx = argv.indexOf('--record');

  const cfg = readJson(CFG_PATH, {});
  const cost = cfg.cost || {};
  const budget = Number(cost.dailyBudgetCNY ?? 5);
  const failRateRedline = Number(cost.failRateRedlinePct ?? 15);
  const noDispatchAboveCpu = Number(cost.noDispatchAboveCpuPercent ?? 90);

  // 台账
  let ledger = readJson(LEDGER_PATH, { version: 1, days: {} });
  if (!ledger.days) ledger.days = {};
  const t = today();
  if (!ledger.days[t]) ledger.days[t] = { spendCNY: 0, calls: 0, failures: 0, entries: [] };

  // --- 记账模式 ---
  if (recIdx >= 0) {
    const amt = Number(argv[recIdx + 1] || 0);
    const day = ledger.days[t];
    if (asFail) {
      day.failures = (day.failures || 0) + 1;
      day.entries.push({ at: new Date().toISOString(), type: 'fail', amountCNY: 0 });
      console.log(`已记失败 1 次；今日失败 ${day.failures}`);
    } else {
      day.spendCNY = +(Number(day.spendCNY || 0) + amt).toFixed(4);
      day.calls = (day.calls || 0) + 1;
      day.entries.push({ at: new Date().toISOString(), type: 'spend', amountCNY: amt });
      console.log(`已记账 +¥${amt.toFixed(4)}；今日累计 ¥${day.spendCNY} / ¥${budget}`);
    }
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
    process.exit(0);
  }

  const day = ledger.days[t];
  const spend = Number(day.spendCNY || 0);
  const pct = budget > 0 ? spend / budget : 0;

  // 免费档健康（只对 catalog 内“在编模型”下判断，避免把历史/退役模型算进来）
  const avail = readJson(path.join(OFM_DIR, 'availability.json'), { results: {} });
  const results = avail.results || {};
  const catalog = readJson(path.join(OFM_DIR, 'catalog.json'), { entries: [], kiloRows: [] });
  const candidates = [
    ...(Array.isArray(catalog.entries) ? catalog.entries : []),
    ...(Array.isArray(catalog.kiloRows) ? catalog.kiloRows.map((r) => r.id).filter(Boolean) : []),
  ];
  const candSet = new Set(candidates);
  const dead = [];
  let alive = 0;
  let offCatalogDead = 0;
  for (const [id, a] of Object.entries(results)) {
    if (!a || typeof a !== 'object') continue;
    const st = String(a.state || 'unknown').toLowerCase();
    const isDead = DEAD_STATES.has(st) || (a.detail && /deprecated/i.test(a.detail));
    if (candSet.has(id)) {
      if (isDead) dead.push(id);
      else alive += 1;
    } else if (isDead) {
      offCatalogDead += 1;
    }
  }

  // 近 3 日失败率（来自 stats，仅参考）
  const stats = readJson(path.join(OFM_DIR, 'stats.json'), { days: {} });
  const days = Object.keys(stats.days || {}).sort().slice(-3);
  let calls = 0, failed = 0;
  for (const d of days) {
    for (const m of Object.values(stats.days[d]?.models || {})) {
      calls += Number(m.calls || 0);
      failed += Number(m.failed || 0);
    }
  }
  const failPct = calls ? (failed / calls) * 100 : null;

  // 判定
  let verdict = 'GO';
  const reasons = [];

  if (pct >= 1) {
    verdict = 'STOP';
    reasons.push(`预算已耗尽：今日 ¥${spend.toFixed(2)} ≥ ¥${budget}，硬闸触发，付费调用必须中止`);
  } else if (pct >= 0.8) {
    verdict = 'CAUTION';
    reasons.push(`预算接近上限：今日 ¥${spend.toFixed(2)} / ¥${budget}（${(pct * 100).toFixed(0)}%），优先免费档`);
  }

  if (failPct != null && failPct >= failRateRedline) {
    if (verdict === 'GO') verdict = 'CAUTION';
    reasons.push(`最近失败率 ${failPct.toFixed(1)}% ≥ 红线 ${failRateRedline}%，免费档可能在抖，先切兜底链`);
  }

  if (alive === 0 && dead.length > 0) {
    if (verdict === 'GO') verdict = 'CAUTION';
    reasons.push(`免费档全部死亡（${dead.length} 个），只能付费兜底或等网络恢复`);
  }

  const out = {
    verdict,
    date: t,
    spendCNY: +spend.toFixed(2),
    budgetCNY: budget,
    usedPercent: +(pct * 100).toFixed(1),
    failPct: failPct == null ? null : +failPct.toFixed(1),
    freeAlive: alive,
    freeDead: dead.length,
    offCatalogDead,
    deadModels: dead,
    noDispatchAboveCpuPercent: noDispatchAboveCpu,
    reasons,
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(verdict === 'STOP' ? 2 : 0);
  }

  console.log('\n=== SYMBIO 预算硬闸 ===\n');
  console.log(`日期：${t}    判定：${verdict}`);
  console.log(`今日花费：¥${out.spendCNY} / ¥${budget}（${out.usedPercent}%）`);
  if (failPct != null) console.log(`近 3 日整体失败率（含死模重试）：${out.failPct}%`);
  console.log(`免费档（在编）：可用 ${alive} 个；已死 ${dead.length} 个`);
  if (dead.length) console.log(`已死：${dead.slice(0, 6).join(', ')}${dead.length > 6 ? ' …' : ''}`);
  if (offCatalogDead) console.log(`（另有 ${offCatalogDead} 个已退役/历史模型已死，不在兜底链内，已忽略）`);
  if (reasons.length) {
    console.log('\n判定依据：');
    for (const r of reasons) console.log(`  · ${r}`);
  }

  if (verdict === 'STOP') {
    console.log('\n→ STOP：不得再发起任何付费模型调用。先跑 model-probe 走免费兜底链，或明日再来。\n');
  } else if (verdict === 'CAUTION') {
    console.log('\n→ CAUTION：可以干，但优先免费档；每笔付费调用后记账。\n');
  } else {
    console.log('\n→ GO：预算与健康均正常。\n');
  }
  console.log('提示：付费调用后跑 `node tools/spend-guard.mjs --record <金额>` 记账。\n');
  process.exit(verdict === 'STOP' ? 2 : 0);
}

main();
