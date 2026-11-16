#!/usr/bin/env node
// tools/lib/review.mjs —— 交付审核闸（把门下省那套审核协议装进 SYMBIO）
//
// 放 lib/ 而不是 tools/ 根：面板把 tools/*.mjs 列成「可点工具」且契约测试硬断言 6 个，
// readdir 不递归（见 tools/dev/selftest.mjs 的注释）。审核闸是内部工序，不是给人点的按钮。
//
// 来源：E:/个人助理/门下省/审核/ 的 17 份审核记录 + 3 份驳回单 + 1 份重做复核。
// 三省六部的 R1/R2/R4（字数 / 字段 / 落盘）SYMBIO 已经用程序闸做掉了；
// 真正缺的是 R3 ——「内容是否只出自源文档、有没有模型自己补的推断」。
// 这一道就是 R3 的程序化近似，且**零网络调用**。
//
// 为什么不照抄门下省的「读全文 + 人工回溯行号」：那套要 20 分钟、靠一个 agent 自觉，
// 放进无人循环里等于每篇材料都白等一次。这里只保留它最有价值的两件东西：
//   ① 实测数值而非肉眼估算  ② 驳回单必须写清「不合格项 / 缺什么 / 怎么改」
//
// 口径纪律（11-10 A/B 实测得出）：压缩比 >1:3 时 Jaccard 相似度会失效
// （对本源 0.035、对最像的反例 0.082），所以**不用文本相似度判归属**。
// 只用可核验的数字/版本号能否在源材料里回溯。
//
// 用法：
//   node tools/lib/review.mjs --card <卡片.md> --source <原文.md> [--json]
//   node tools/lib/review.mjs --card <卡片.md> --source <原文.md> --min-grounding 0.8
//
// 模块导出：stripMeta / evidence / reviewCard / buildRetryDirective / appendReviewLog

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { root, flag, has, nowStamp, readJson, writeJsonAtomic } from './common.mjs';

export const REVIEW_LOG = 'memory/20-scenes/knowledge-digest/审核台账.json';
export const DEFAULT_MIN_GROUNDING = 0.8;
export const DEFAULT_MIN_UNEXPLAINED = 3;

// ── 只审正文，不审元数据 ────────────────────────────────────────────────────
// 卡片的 frontmatter（旧卡）与「- 来源 / - 摄入时间 / - 密级」三行（新卡）都是代码
// 补进去的，不是模型写的。把里面的日期、路径、编号当「来源外数值」会全是误报。
// 标题行也可能带日期（2026-09-27-xxx），一并剥掉。
const META_LINE = /^[-*]\s*(来源|摄入时间|密级|主题标签|更新时间|状态|written_to|url|date|ingested)[：:]/i;

export function stripMeta(markdown) {
  let text = String(markdown ?? '');
  // 顶部 YAML frontmatter（旧卡有，新卡没有）
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const lines = text.split('\n').filter((l) => {
    const t = l.trim();
    if (META_LINE.test(t)) return false;
    if (/^#\s+/.test(t)) return false;             // 标题
    return true;
  });
  return lines
    .join('\n')
    // 日期 / 出处行号是「标注」不是「事实数值」，不参与回溯
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\bL\d+(?:\s*[-–~]\s*\d+)?\b/gi, ' ')
    .replace(/\b(?:PR|issue)\s*#?\d+\b/gi, ' ');
}

// ── 可核验记号 ─────────────────────────────────────────────────────────────
// 抓数字串与版本号，规范化后比较：1.20 与 1.2、007 与 7 视为同一个。
// 多段版本号（0.1.3 / 2.8.0）整体保留，不能用 Number() 压。
const VERSION_RE = /\b\d+(?:\.\d+){2,}\b/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

function normToken(s) {
  if (/^\d+(?:\.\d+)+$/.test(s) && (s.match(/\./g) || []).length >= 2) return s; // 版本号
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/** 返回 { tokens: Set, raw: string[] } —— 只收数字/版本号，专名另算（见 identifiers）。 */
export function evidence(text) {
  const clean = String(text ?? '');
  const tokens = new Set();
  const raw = [];
  for (const m of clean.matchAll(VERSION_RE)) {
    tokens.add(m[0]);
    raw.push(m[0]);
  }
  // 版本号占掉的区间先抹掉，避免 0.1.3 又被拆成 0.1 / 3
  const rest = clean.replace(VERSION_RE, ' ');
  for (const m of rest.matchAll(NUMBER_RE)) {
    const t = normToken(m[0]);
    if (t.length < 2 && !t.includes('.')) continue; // 个位数（要点编号 1. 2.）不算证据
    tokens.add(t);
    raw.push(m[0]);
  }
  return { tokens, raw };
}

/** 低频英文专名，口径与 autopilot 的 anchors() 一致；只作报告，不作驳回依据。 */
export function identifiers(text) {
  const raw = [...String(text ?? '').matchAll(/[A-Za-z][A-Za-z0-9_.\-]{3,}/g)].map((m) => m[0].toLowerCase());
  const cnt = new Map();
  for (const w of raw) cnt.set(w, (cnt.get(w) || 0) + 1);
  return new Set([...cnt].filter(([w, c]) => c <= 2 && w.length >= 4).map(([w]) => w));
}

// ── 核心判定 ────────────────────────────────────────────────────────────────
/**
 * @param {object}   p
 * @param {string}   p.card          已拼好元数据的卡片 markdown
 * @param {string}   p.sourceText    原始材料（发给出网前的 outbound）
 * @param {string[]} [p.reasons]     外部闸（归属/结构）已有的不合格理由
 * @param {number}   [p.minGrounding]
 * @param {number}   [p.minUnexplained]
 */
export function reviewCard({
  card,
  sourceText,
  reasons = [],
  minGrounding = DEFAULT_MIN_GROUNDING,
  minUnexplained = DEFAULT_MIN_UNEXPLAINED,
} = {}) {
  const cardBody = stripMeta(card);
  const srcBody = stripMeta(sourceText);
  const c = evidence(cardBody);
  const s = evidence(srcBody);

  const unexplained = [...c.tokens].filter((t) => !s.tokens.has(t));
  const grounding = c.tokens.size ? (c.tokens.size - unexplained.length) / c.tokens.size : 1;
  // 源文数字有多少被卡片留住——只作信息量报告，**不作判据**：
  // 材料越长、压缩越狠，这个数天然越低，拿它判不合格会误杀所有长文。
  const kept = [...s.tokens].filter((t) => c.tokens.has(t)).length;
  const sourceCoverage = s.tokens.size ? kept / s.tokens.size : 1;

  // 两条判据各管一件事，别混：
  //   数字回溯 → 有没有「材料外补出来的数值」（门下省 R3）
  //   专名回溯 → 有没有「挂错材料」（autopilot.checkAttribution 的同款口径）
  // 实测踩过：个税原文有 64 个数字，30/10 这类常见数全都在，错配卡片数字居然 100% 命中
  // ——纯数字回溯会假阴性，必须配一条专名。反过来中文材料专名少时，数字才是主力。
  const cardIds = identifiers(cardBody);
  const srcIds = identifiers(srcBody);
  const srcFlat = srcBody.toLowerCase();
  const idHit = [...cardIds].filter((w) => srcFlat.includes(w));
  const idGrounding = cardIds.size ? idHit.length / cardIds.size : 1;

  // 证据不足就如实说判不出，不猜。真机踩过：中文材料里数字很少（一份只有 2 个），
  // 写死「至少 3 个未命中才驳回」会让短卡**全部**漏过去。所以阈值要看比例，
  // 源文只要有 2 个可核验记号就够判「卡片里的数一个都对不上」这种强反例。
  const enoughEvidence = c.tokens.size >= 2 && s.tokens.size >= 2;
  const numericFail = enoughEvidence && (
    (unexplained.length >= minUnexplained && grounding < minGrounding) ||
    (c.tokens.size >= 2 && grounding < 0.5)   // 短卡兜底：过半对不上，比例比个数可靠
  );
  // 卡片自带 2 个以上低频专名、源文一个都找不到 → 挂错材料的证据已经够了，
  // 不要求源文也有 3 个专名（中文材料常一个都没有，那个门槛会让错配整批漏过去）。
  // 外部已经报了归属问题就不重复报（autopilot 的 checkAttribution 会传进来）。
  const ownershipFail =
    cardIds.size >= 2 && idHit.length === 0 &&
    !reasons.some((r) => r.startsWith('归属'));
  const indeterminate = !enoughEvidence && cardIds.size < 2 && !ownershipFail;

  const all = [...reasons];
  if (numericFail) {
    all.push(
      `来源外数值：卡片出现 ${unexplained.length} 个源材料中找不到的数值（${unexplained.slice(0, 8).join('、')}${unexplained.length > 8 ? '…' : ''}），可回溯率 ${(grounding * 100).toFixed(0)}%`
    );
  }
  if (ownershipFail) {
    all.push(
      `归属存疑：卡片里 ${cardIds.size} 个材料独有专名（${[...cardIds].slice(0, 5).join('、')}）在源材料中一个都没有，疑似挂错材料`
    );
  }

  return {
    ok: all.length === 0,
    verdict: all.length === 0 ? (indeterminate ? 'PASS（证据不足，未判）' : 'PASS') : 'REJECT',
    reasons: all,
    numericFail,
    ownershipFail,
    indeterminate,
    idGrounding: Number(idGrounding.toFixed(4)),
    cardIdentifiers: cardIds.size,
    grounding: Number(grounding.toFixed(4)),
    sourceCoverage: Number(sourceCoverage.toFixed(4)),
    cardTokens: c.tokens.size,
    sourceTokens: s.tokens.size,
    unexplained,
    identifiers: [...identifiers(cardBody)].slice(0, 20),
    at: nowStamp().iso,
  };
}

// ── 门下省式驳回单 ──────────────────────────────────────────────────────────
// 三省六部 11-05 那三份驳回单的结构：「不合格项 / 缺什么 / 怎么改 / 依据」。
// 关键不是「你不合格」，是「改哪几处、别动其他地方」——盲重跑缺的就是这一段。
export function buildRetryDirective({ result, extraReasons = [], card = '', sourceText = '' } = {}) {
  const r = result ?? reviewCard({ card, sourceText, reasons: extraReasons });
  const reasons = [...new Set([...extraReasons, ...r.reasons])];
  if (!reasons.length) return '';

  const lines = [
    '【交付审核驳回单 · 定向重做】',
    '上一版产物未通过落卡前复核。以下不合格项由本地程序实测得出，不是猜测。只改列出的地方，不要重写整张卡。',
    '',
    '## 不合格项',
    ...reasons.map((x) => `- ${x}`),
    '',
    '## 缺什么',
    '- 卡片内容必须只出自给定材料；不得补充材料外的事实、数值、结论或推断。',
    '- 卡片必须有可跳转的小节结构，且总字数不超过卡片上限。',
    '',
    '## 怎么改',
  ];
  let n = 1;
  if (r.numericFail || r.unexplained?.length) {
    lines.push(
      `${n++}. 逐条删掉或改正来源外数值（${(r.unexplained || []).slice(0, 8).join('、')}）；确需保留的，必须能在材料中找到对应表述。`
    );
  }
  if (reasons.some((x) => x.startsWith('结构'))) {
    lines.push(`${n++}. 用二级标题写全四个小节：## 一句话结论 / ## 要点 / ## 值得记的原文片段 / ## 标签；要点逐条以「- 」开头。`);
  }
  if (reasons.some((x) => x.startsWith('归属'))) {
    lines.push(`${n++}. 只消化本次给定的材料，不要混入上一次回答或其它材料的内容；保留材料里独有的专名与版本号。`);
  }
  lines.push(`${n++}. 其余已达标的段落保持原样，不要输出卡片以外的任何话。`);
  lines.push('', '## 依据', `- 审核口径：数字/版本号回溯（不用文本相似度）；可回溯率 ${(r.grounding * 100).toFixed(0)}%，源文记号留存 ${(r.sourceCoverage * 100).toFixed(0)}%。`);
  lines.push('- 复核方式：本地只读复核，零网络调用。');
  return lines.join('\n');
}

// ── 审核台账（可查，不参与预算） ────────────────────────────────────────────
export async function appendReviewLog(record, rootDir = root()) {
  const file = path.join(rootDir, REVIEW_LOG);
  const data = (await readJson(file, { records: [] })) ?? { records: [] };
  if (!Array.isArray(data.records)) data.records = [];
  data.records.push(record);
  // 只留最近 200 条：台账是「可查」不是「归档」，别让它长成一个新的记忆负担
  if (data.records.length > 200) data.records = data.records.slice(-200);
  await writeJsonAtomic(file, data);
  return file;
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cardPath = flag(args, 'card');
  const sourcePath = flag(args, 'source');
  if (!cardPath || !sourcePath) {
    console.error('用法：node tools/lib/review.mjs --card <卡片.md> --source <原文.md> [--json]');
    process.exit(2);
  }
  const [card, sourceText] = await Promise.all([
    fs.readFile(path.resolve(cardPath), 'utf8'),
    fs.readFile(path.resolve(sourcePath), 'utf8'),
  ]);
  const min = Number(flag(args, 'min-grounding'));
  const r = reviewCard({
    card,
    sourceText,
    minGrounding: Number.isFinite(min) && min > 0 ? min : DEFAULT_MIN_GROUNDING,
  });
  if (has(args, 'json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`结论：${r.verdict}`);
    console.log(`可回溯率 ${(r.grounding * 100).toFixed(0)}%（卡片 ${r.cardTokens} 个记号 / 源文 ${r.sourceTokens} 个）`);
    console.log(`源文记号留存 ${(r.sourceCoverage * 100).toFixed(0)}%（仅报告，不判据）`);
    console.log(`专名回溯 ${(r.idGrounding * 100).toFixed(0)}%（卡片 ${r.cardIdentifiers} 个低频专名）`);
    if (r.indeterminate) console.log('材料可核验记号不足，本次复核降级为只报告，不做驳回判定');
    if (r.unexplained.length) console.log(`来源外数值：${r.unexplained.slice(0, 12).join('、')}`);
    for (const x of r.reasons) console.log(`- ${x}`);
    if (!r.ok) console.log('\n' + buildRetryDirective({ result: r }));
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('[review] 复核失败：', e.message);
    process.exitCode = 3;
  });
}

export const __filename = fileURLToPath(import.meta.url);
