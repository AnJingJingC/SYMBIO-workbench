// autopilot.mjs —— 挂监听 + 外部免费算力的无人循环（作者机制清单最后一项的落地）
//
// 链路：memory/50-inbox/*.md（宿主随手丢长文）
//   → load-gate（CPU/内存过高不派活）
//   → pii-scan（三道结局：拦下进 _blocked/；判不出则整轮不外发；只有"判过了"才继续）
//   → 免费 AI 桥消化（豆包等，要求 ≤1200 字知识卡片格式）
//   → 自检三闸：归属（挂错材料）/ 结构（不像卡片）/ 复核（数字与专名能否回溯）
//     不过就带驳回单定向重做一次，仍不过进 _failed/（宁可不落，也不落一张假的）
//   → tools/intake.mjs 确定性落卡 + 索引重建
//   → 原文移 _done/（失败 _failed/，超长 _too-long/）
//
// 用法：
//   node tools/autopilot.mjs --once              # 只处理现有文件后退出（点测用）
//   node tools/autopilot.mjs                     # 常驻监听（默认 30s 扫描 + fs.watch 即时触发）
//   node tools/autopilot.mjs --interval 60000 --site qianwen
//
// 诚实边界（先读再跑）：
//   1. 依赖伴生桥在线且目标站点已登录（额度耗尽 = 桥报 not-logged-in，本工具不代登录，
//      按"失败"计数，3 次进 _failed/）。启动桥：cd shell && npm run bridge
//   2. 桥 question 上限 4000 字 → 单段消化按 BODY_CAP=2800 字留余量；超过就按段落
//      切块（每块 ≤2800），逐块提要点后**再问一次**合并成一张卡。段数上限 MAX_CHUNKS=6，
//      再多（>16800 字）进 _too-long/ 交宿主决定怎么切。代价是多段材料要多花 1+N 次额度。
//   3. 消化质量 = 桥的输出质量。落卡前只做格式与字数闸，不做事实核查。
//   4. 本工具只动 memory/50-inbox/ 与 knowledge-digest/cards/，不碰其他记忆层。

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beat, clearBeat, pruneBeats } from './lib/heartbeat.mjs';
// 交付审核闸（门下省协议）：本地复核 + 定向驳回单，零网络调用。
// 放 lib/ 是为了不进面板工具箱——契约测试硬断言 tools 只有 6 个可点工具。
import { reviewCard, buildRetryDirective, appendReviewLog } from './lib/review.mjs';
// 外形收口：砍掉「## 标签」之后被桥顺带刮进来的站点 UI 文案。见 lib/card-shape.mjs。
import { trimTailAfterTags } from './lib/card-shape.mjs';
import { parseScan, decideEgress } from './lib/pii-gate.mjs';

const execFileP = promisify(execFile);

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
};
const ONCE = args.includes('--once');
const INTERVAL_MS = Math.max(10_000, Number(flag('interval')) || 30_000);
// 默认站点按**实测稳定性**选，不按偏好选。
// 2026-11-10 台账数据：deepseek 10 次调用失败 4（40%，全是 empty-answer 首帧 30000ms 超时），
// qianwen 5 次 0 失败；且每次失败要白等 30 秒才切站，等于把整轮耗时翻倍。
// 所以主站让给 qianwen，deepseek 降到备用第一位（它成功率不稳定，但通了就快）。
// 不赌单点：主站失败就按下面的顺序自动换站重试。
// 显式 --site 仍然优先，换站链也会自动跳过它（所以列表留全四站，filter 负责剔除）。
const SITE = flag('site') || 'qianwen';
const FALLBACK_SITES = ['deepseek', 'qianwen', 'doubao', 'zhipu'].filter((s) => s !== SITE);
const ROOT = process.env.SYMBIO_HOME || 'E:/SYMBIO';
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';
const INBOX = path.join(ROOT, 'memory/50-inbox');
const DONE = path.join(INBOX, '_done');
const BLOCKED = path.join(INBOX, '_blocked');
const FAILED = path.join(INBOX, '_failed');
const TOOLONG = path.join(INBOX, '_too-long');

// 隐私闸判不出结论时置位。它不是"这一份跳过"，而是**整轮停止外发**：
// 扫描器崩了是系统性问题，后面每一份都会同样判不出，继续跑等于批量泄。
let EGRESS_HALT = '';
const BODY_CAP = 2800;          // 桥 4000 字上限 − 指令余量
// 卡片字数上限：**从配置读**，别在代码里写死 1200——改了配置的人会以为生效了。
const CARD_CAP = await (async () => {
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/symbio.config.json'), 'utf8'));
    return Number(cfg?.limits?.cardMaxChars) || 1200;
  } catch {
    return 1200;
  }
})();
const MAX_CHUNKS = 6;           // 分段上限：再多就不值得（额度与合并质量都撑不住）
const MAX_FAILS = 3;

const log = (...m) => console.log(`[autopilot ${new Date().toISOString()}]`, ...m);

// 亮灯用的活动心跳。TTL 给到 240s：桥消化一张卡实测 8~25s，冷启动重试可能到 70s，
// 面板若 90s 就判灭，会出现"明明还在跑，灯却灭了"的假象。
const BEAT_SCENE = 'knowledge-digest';
const BEAT_TTL = 240_000;
const beatHere = (phase, detail) => beat({ scene: BEAT_SCENE, phase, detail, ttlMs: BEAT_TTL, rootDir: ROOT });

// ── 免费桥的用量记账 ────────────────────────────────────────────────────────
// 桥不吃钱，所以以前台账里一个数都没有：跑了几百次，看起来像"从没调用过"。
// 但调用次数、失败数、各站分布是真实发生的事，也是换站策略好不好使的唯一证据。
// 记进花费台账的 days[date].free（钱仍然独立：free 不参与预算判定）。
const LEDGER = path.join(ROOT, 'memory/10-shared/花费台账.json');
const FREE = { calls: 0, failed: 0, bySite: {} };
function countFree(site, ok) {
  const s = site || 'unknown';
  FREE.calls += 1;
  if (!ok) FREE.failed += 1;
  const row = FREE.bySite[s] || (FREE.bySite[s] = { calls: 0, failed: 0 });
  row.calls += 1;
  if (!ok) row.failed += 1;
}
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
async function recordFreeUsage() {
  if (!FREE.calls) return;
  let ledger;
  try {
    ledger = JSON.parse(await fs.readFile(LEDGER, 'utf8'));
  } catch {
    ledger = { version: 1, currency: 'CNY', days: {} };
  }
  if (!ledger.days || typeof ledger.days !== 'object') ledger.days = {};
  const day = todayLocal();
  if (!ledger.days[day]) ledger.days[day] = { spendCNY: 0, calls: 0, failures: 0, entries: [] };
  const d = ledger.days[day];
  const free = d.free || (d.free = { calls: 0, failed: 0, bySite: {} });
  free.calls += FREE.calls;
  free.failed += FREE.failed;
  for (const [site, c] of Object.entries(FREE.bySite)) {
    const row = free.bySite[site] || (free.bySite[site] = { calls: 0, failed: 0 });
    row.calls += c.calls;
    row.failed += c.failed;
  }
  free.updatedAt = new Date().toISOString();
  // 先写临时文件再改名：这个文件面板会读，写到一半被杀不能留半截 JSON。
  await fs.mkdir(path.dirname(LEDGER), { recursive: true });
  const tmp = `${LEDGER}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, LEDGER);
  const dist = Object.entries(FREE.bySite).map(([s, c]) => `${s}×${c.calls}${c.failed ? `（失败 ${c.failed}）` : ''}`).join(' · ');
  log(`本轮免费桥：${FREE.calls} 次 / 失败 ${FREE.failed}（${dist}），已记入花费台账`);
}

async function ensureDirs() {
  for (const d of [INBOX, DONE, BLOCKED, FAILED, TOOLONG]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function failCount(name) {
  try {
    const raw = await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8');
    return JSON.parse(raw)[name] ?? 0;
  } catch { return 0; }
}

async function bumpFail(name) {
  let m = {};
  try { m = JSON.parse(await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8')); } catch { /* 首次 */ }
  m[name] = (m[name] ?? 0) + 1;
  await fs.writeFile(path.join(INBOX, '_fails.json'), JSON.stringify(m, null, 2), 'utf8');
  return m[name];
}

async function move(file, dir) {
  const target = path.join(dir, path.basename(file));
  await fs.rename(file, target).catch(async (e) => {
    if (e?.code === 'EXDEV' || e?.code === 'EPERM') {
      await fs.copyFile(file, target);
      await fs.unlink(file);
    } else throw e;
  });
  return target;
}

async function toolPath(script) {
  // 优先 ROOT/tools（部署位），缺失则回退到本文件同目录（fixture/便携场景）
  const inRoot = path.join(ROOT, 'tools', script);
  try {
    await fs.access(inRoot);
    return inRoot;
  } catch {
    return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), script);
  }
}

async function runTool(script, args_) {
  const scriptPath = await toolPath(script);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [scriptPath, ...args_], {
      cwd: ROOT, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e) };
  }
}

async function bridgeAsk(question, site = SITE) {
  try {
    const res = await fetch(`${BRIDGE}/webai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site, question }),
      signal: AbortSignal.timeout(200_000),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;
    countFree(site, ok);
    return { status: res.status, ok, data };
  } catch (e) {
    // 首帧超时、连接被拒时 fetch 是**抛异常**，不是返回错误码。
    // 原来这一抛会把整篇材料判死进 _failed——而超时恰恰是网页桥最常见的失败，
    // 换站兜底必须把这种情况算作"这个站没通"，交给外层切下一个站。
    countFree(site, false);
    return { status: 0, ok: false, data: { errorType: 'fetch-failed', message: String(e?.message ?? e) } };
  }
}

// ── 归属自检 ────────────────────────────────────────────────────────────────
// 真机踩过：上一轮 6 段合并刚结束 17 秒就发下一篇，桥把**上一条回答**返回了这一条。
// 内容套在错材料上，标题写「外壳路线评估」、来源写「免费网页AI桥」，而命令行返回 ok。
// 这是最难自查的一类错——卡片看起来完整、格式也对，只是挂错了材料。
// 两道检查：① 与上一条回答的字符二元组重合度 ② 材料里的专名/数字在回答里的命中数。
const STATE = path.join(INBOX, '.last-reply.json');

function grams(t) {
  const s = String(t).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// 材料里的「独特记号」：只留**低频**英文标识符与数字（出现 ≤2 次）。
// 通用词（ai / api / dsh / http）在文中反复出现，自然被滤掉；专名（shell.overlay）
// 和版本号（0.1.3）只出现一两次，留下。实测：错配的卡在这道闸上命中 0，同材料的卡命中 1-2。
function anchors(t) {
  const raw = [...String(t).matchAll(/[A-Za-z][A-Za-z0-9_.\-]{3,}|\d+\.\d+[\.\d]*|\d{4,}/g)].map((m) =>
    m[0].toLowerCase()
  );
  const cnt = new Map();
  for (const w of raw) cnt.set(w, (cnt.get(w) || 0) + 1);
  const out = new Set();
  for (const [w, c] of cnt) if (c <= 2 && w.length >= 4) out.add(w);
  return out;
}

async function lastReply() {
  try {
    return JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {
    return null;
  }
}

async function rememberReply(source, text) {
  try {
    await fs.writeFile(STATE, JSON.stringify({ source, at: Date.now(), text: String(text).slice(0, 3000) }));
  } catch (e) {
    // 写不进去就等于「永远没有上一条可比较」——串线检测会悄悄退化成只剩锚点这一道。
    // 测试时踩过：传错 fs 模块，写入静默失败，四场景里唯一该被抓住的那条漏了。
    log('上一轮回答状态写不进去，串线检测退化（只剩锚点检查）：', e.message);
  }
}

// 结构闸：真机里 6 段合并那一次，桥无视了 prompt，输出 5 段裸文字，没有任何小节。
// 这种卡能读但不是卡（索引里没有可跳转的小节，渲染出来一大坨）。落库前拦掉。
function checkShape(reply) {
  const n = (String(reply).match(/^##\s+\S/gm) || []).length;
  if (n < 2) return `输出没有小节结构（## 只有 ${n} 个），不像卡片`;
  return null;
}

async function checkAttribution(reply, body, source) {
  const prev = await lastReply();
  // 同一份材料重跑时内容本来就该像，不能当成串线
  if (prev?.text && prev.source !== source) {
    const j = jaccard(reply, prev.text);
    if (j > 0.5) return `与上一条回答高度重合（${j.toFixed(2)}，上一条是 ${prev.source}）`;
  }
  const a = anchors(body);
  if (a.size >= 10) {
    const low = String(reply).toLowerCase();
    let hit = 0;
    for (const t of a) if (low.includes(t)) hit++;
    if (hit === 0) return `回答里没有任何材料独有的专名/版本号（稀有锚点 ${a.size} 个，命中 0）`;
  }
  return null;
}

// prompt 里必须把 markdown 的井号写出来。只写「依次有小节：一句话结论 / 要点 …」时，
// 桥会输出成裸文本行 —— 卡片渲染出来是四大段糊在一起，要点也没有列表符号。
// 真机踩过：卡片能读，但不像卡片。
const CARD_SHAPE =
  `③ 小节必须用二级标题，依次是：## 一句话结论 / ## 要点 / ## 值得记的原文片段 / ## 标签；` +
  ` 「## 一句话结论」下面**只写一行**（≤60 字，不要拆成多行、不要加列表符号）；` +
  `「## 要点」下面每条以「- 」开头，一行一条，≤5 条；` +
  `「## 值得记的原文片段」直接抄原文金句，每条以「- 」开头；` +
  `「## 标签」写 2-4 个以 # 开头的词，不用列表符号。`;

const DIGEST_PROMPT = (title) =>
  `请把下面的材料消化成一张知识卡片，严格满足：① 总字数 ≤1200 字；② 第一行是「# <卡片标题>」，` +
  `标题要一句话说清这是什么（别照抄文件名）；` +
  CARD_SHAPE +
  `不要输出卡片以外的任何话。材料标题：「${title}」。\n\n材料正文：\n`;

// 入料文件名 → 卡片标题。
// 踩过：用户随手丢 2026-11-07-xxx.md，标题原样传给 intake，intake 再补一次日期，
// 结果文件名变成 2026-11-07-2026-11-07-xxx.md。日期由 intake 统一加，入料这边先剥掉。
const cardTitle = (name) =>
  name.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}[-_\s]*/, '').trim() || '未命名';

// 桥不知道「来源 / 摄入时间 / 密级」，让它编就是造假。这三行由代码补真实值，
// 桥只管正文。技能规范与 index-build 的 META_PREFIX 都按这四行对齐。
// 桥不一定每次都听话。prompt 要求了「## 小节」和「- 条目」，但真机里它给过裸文本小节、
// 也把要点写成四大段。这里只补**格式符号**，不动一个字：小节名补 ##、要点段里的裸行补 -。
// 判断标准很窄（整行恰好等于小节名），不会误伤正文里提到「要点」的句子。
const SECTIONS = ['一句话结论', '要点', '值得记的原文片段', '标签'];
const BULLET_SECTIONS = ['要点', '值得记的原文片段'];

// 掐掉桥的会话尾巴。桥是网页对话模型，答完正事经常补一句「需要我帮你…吗？」，
// 这句话会原样落进卡片——知识卡不该管人说话。只掐**尾部**、只掐明确像聊天的话，
// 正文中段出现这些词不动（可能是原文引述）。
const CHATTER_RE = /(需要我|要不要我|如果你需要|希望这(对|份|篇)|祝使用愉快|我可以继续|帮我提取|帮你提取|帮你补全)/;
const CHATTER_END_RE = /(?:吗\?|吗？|吧[!！]?|哦[~～]?)\s*$/;
function stripChatter(lines) {
  const out = [...lines];
  while (out.length) {
    const last = out[out.length - 1].trim();
    if (!last) {
      out.pop();
      continue;
    }
    if (/^#{1,6}\s/.test(last)) break; // 掐到小节标题就停，别把正文截残
    if (CHATTER_RE.test(last) || (last.length > 12 && CHATTER_END_RE.test(last))) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

function normalizeSections(lines) {
  const out = lines.map((l) => {
    const t = l.trim();
    if (!t || /^#{1,6}\s/.test(t)) return l;
    const hit = SECTIONS.find((s) => t === s || t === `${s}：` || t === `${s}:`);
    return hit ? `## ${hit}` : l;
  });

  // 在要点/片段段内，整段都是裸行（一条列表符号都没有）时逐行补「- 」
  for (let i = 0; i < out.length; i++) {
    if (!/^##\s/.test(out[i].trim())) continue;
    const sec = out[i].trim().replace(/^##\s+/, '');
    if (!BULLET_SECTIONS.includes(sec)) continue;
    let j = i + 1;
    while (j < out.length && !/^##\s/.test(out[j].trim())) j++;
    const body = [];
    for (let k = i + 1; k < j; k++) if (out[k].trim()) body.push(k);
    if (body.length < 2) continue; // 单行不当列表（可能是「—」或一句总结）
    const anyBullet = body.some((k) => /^\s*[-*+]\s|^\s*\d+[.)]\s/.test(out[k]));
    if (anyBullet) continue; // 桥已经给了列表，别重复加
    for (const k of body) out[k] = `- ${out[k].trim()}`;
    i = j - 1;
  }
  return out;
}

function withMeta(markdown, { source, at, level, fallbackTitle }) {
  const lines = String(markdown).trim().split('\n');
  let head = `# ${fallbackTitle}`;
  if (/^#\s+/.test(lines[0] ?? '')) {
    head = lines.shift().trim();
  } else if (lines[0] && lines[0].trim().length <= 40 && !/^(?:[-*|>]|\d+[.)、])/.test(lines[0].trim())) {
    // 桥的输出格式并不稳定：有时给「# 标题」，有时标题是纯文本第一行。
    // 后者如果不管，标题就退化成占位符（真机踩过：索引里一排「未命名卡片」）。
    // 排除列表形态用「数字+点/括号」，不能只写 \d —— 「2026-11-05 xxx」这种日期开头的
    // 标题会被误判成有序列表，结果桥给的好标题被留在正文里当第一行。
    head = `# ${lines.shift().trim()}`;
  }
  // 站点 UI 文案是在 stripChatter 之后才暴露的：那段话不像"聊天"，像正经句子，
  // 但它在「## 标签」后面，按卡片契约就不属于卡片。按结构截，不按词表猜。
  const shaped = trimTailAfterTags(normalizeSections(stripChatter(lines)));
  if (shaped.dropped.length) {
    log(`卡片尾部清掉 ${shaped.dropped.length} 行非标签内容（站点文案）：${String(shaped.dropped[0]).slice(0, 30)}…`);
  }
  return [head, '', `- 来源：${source}`, `- 摄入时间：${at}`, `- 密级：${level}`, '', ...shaped.lines]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` +
  ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// 超长材料按段落切块。原来超过 BODY_CAP 直接进 _too-long —— 真机实测真实长文
// 4 篇里 3 篇超限，等于「丢一篇长文」这件事根本用不成。现在切块分别提要点再合并。
// 单段自己就超 cap 的（没有空行的长文本）只能硬切。
function splitChunks(text, cap = BODY_CAP) {
  const out = [];
  const push = (s) => {
    if (s.length <= cap) {
      out.push(s);
      return;
    }
    for (let i = 0; i < s.length; i += cap) out.push(s.slice(i, i + cap));
  };
  let cur = '';
  for (const p of String(text).split(/\n{2,}/)) {
    if (cur && cur.length + p.length + 2 > cap) {
      push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) push(cur);
  return out.filter((c) => c.trim().length > 0);
}

/**
 * 最后一道兜底：模型不肯变短时，按「按重要性排序」的既定约定从尾部删要点。
 * 只有一种情况会走到这里：卡片超上限、问了两次都不给面子。
 * 每个小节至少留 2 条——宁可短，也不落一张超限的卡（超限会被 intake 硬拒，
 * 然后连拒 3 次进 _failed，用户看到的只是"失败"，不知道其实是字数）。
 * 截断后会在末尾留一行说明，不静默丢内容。
 */
function fitCard(text, cap) {
  const lines = text.split('\n');
  const bulletIdx = [];
  for (let i = 0; i < lines.length; i += 1) if (/^\s*[-*]\s+/.test(lines[i])) bulletIdx.push(i);
  if (bulletIdx.length < 8) return null;
  const dropped = new Set();
  const total = () => lines.filter((_, i) => !dropped.has(i)).join('\n').length;
  const sectionStart = (i) => {
    for (let k = i; k >= 0; k -= 1) if (/^#{2,3}\s/.test(lines[k])) return k;
    return -1;
  };
  const countIn = (s) => bulletIdx.filter((i) => !dropped.has(i) && sectionStart(i) === s).length;
  for (let k = bulletIdx.length - 1; k >= 0 && total() > cap; k -= 1) {
    const i = bulletIdx[k];
    if (countIn(sectionStart(i)) <= 2) continue;
    dropped.add(i);
  }
  if (total() > cap) return null;
  const kept = lines.filter((_, i) => !dropped.has(i));
  kept.push(`- （原文超出单卡上限，已按重要性截断 ${dropped.size} 条低优先要点；完整内容见原文归档）`);
  return kept.join('\n');
}

// 分段条目数**按段长给**，不按段数切成固定的 2-3 条。
//
// 上一版是「多段就 2-3 条」，那是为压住合并超限临时降下来的，代价在 7798 字材料上
// 暴露得很清楚：3 段 × 2-3 条 = 最多 9 条 270 字，材料在「提要点」这一环就丢了九成，
// 合并那一步再怎么组织也变不回来（落卡 819 字，七项专项附加扣除的金额一个没剩）。
// 提要点是唯一看过全文的环节，它漏掉的，后面没有机会补。
//
// 改为每 ~650 字 1 条，落在 3-6 条：2600 字的段给 4-5 条，要点集 400 字上下，
// 合并后仍在 1100 字内；真超了还有 SHRINK 兜底——压得掉冗余，变不出没提取的信息。
const pointsRange = (len, n) => {
  if (n === 1) return '3-5';
  const lo = Math.max(3, Math.min(5, Math.round(Number(len) / 650)));
  return `${lo}-${Math.min(6, lo + 1)}`;
};

const POINTS_PROMPT = (title, i, n, len) =>
  `这是《${title}》的第 ${i}/${n} 段。请**只**提取 ${pointsRange(len, n)} 条要点，每条一行、以「- 」开头、` +
  `每条不超过 30 字，保留具体数字、专有名词与结论。不要写标题、不要写总结、不要输出别的任何话。\n\n段落：\n`;

const MERGE_PROMPT = (title) =>
  `下面是同一篇材料《${title}》分段提取的要点。请合并成**一张知识卡片**（注意：是卡片，不是要点列表），严格满足：` +
  `① 总字数 ≤1100 字（留出元信息余量，超过 1200 会被落卡闸硬拒）；② 第一行是「# <卡片标题>」，标题一句话说清这是什么；` +
  CARD_SHAPE.replace('③ ', '') +
  `④ 去重、按重要性排序，不要出现「第几段」这类分段痕迹。不要输出卡片以外的任何话。\n\n`;

// 超限时的一次压缩回合。为什么需要它：分段合并出来的卡长度不可控，
// 9633 字材料分 4 段合并实测出来 1317~1741 字，越过 1200 的硬闸 → intake 直接拒。
// 重试治不了这个：同样的材料、同样的模型，多半还是那么多字。删冗余才是解法。
//
// 注意：第一版提示词写「请只做压缩」，桥返回的反而比原文长 9 字——网页 AI 对
// "少写点"这类要求基本不执行。所以改成**给死数量**（小节数、条目数、每条字数），
// 让它有明确的完成标准；仍然不行就退回原版，让 intake 判，不硬塞。
const SHRINK_PROMPT =
  `把下面这张卡片**重写成更短的一版**，硬性要求：\n` +
  `① 保留原有的小节标题（以 ## 开头的行），一个小节都不许删；\n` +
  `② 每节最多 3 条要点，每条不超过 28 字，以「- 」开头；\n` +
  `③ 所有数字、版本号、专有名词必须保留；\n` +
  `④ 「## 一句话结论」保持单行、≤60 字，不要因为变短就拆成几行；\n` +
  `⑤ 正文合计不超过 900 字。\n` +
  `只输出重写后的卡片，不要解释。\n\n`;

async function processFile(file) {
  const name = path.basename(file);
  if (path.extname(name) !== '.md' || name.startsWith('_')) return;
  log('处理', name);
  const body = await fs.readFile(file, 'utf8');
  const title = cardTitle(name);
  await beatHere('intake', `摄入 ${name}`);

  // 超过「6 段 × 2800 字」才真的放弃（再多，额度与合并质量都撑不住）
  if (body.length > BODY_CAP * MAX_CHUNKS) {
    log(`材料 ${body.length} 字，超过 ${BODY_CAP}×${MAX_CHUNKS}，进 _too-long`);
    await move(file, TOOLONG);
    return;
  }

  // 隐私闸：走 --file 而不是 --text —— 正文作为 argv 传递有长度上限
  // （Windows 命令行约 32K 字节，中文一段 8000 字就爆），长文必须读文件。
  //
  // 2026-11-11 故障演练改的：这里原来把"解析失败"当成"没命中"，于是
  //   扫描器 exit 1 / 输出非 JSON / 文件缺失 → 全部走到 outbound = body，
  //   原文换着 4 个站往外发（实测确认）。规则 24/24 判得对，死在接线。
  // 现在只有三种结局：出去（脱敏后）、拦下（进 _blocked）、**判不出（整轮停）**。
  const scanRes = await runTool('pii-scan.mjs', ['--file', file, '--json']);
  const scan = parseScan(scanRes.stdout);
  if (!scan.ok) {
    EGRESS_HALT = scan.reason;
    const err1 = String(scanRes.stderr || '').trim().split('\n')[0].slice(0, 140);
    log(`隐私闸不可用（${scan.reason}${err1 ? `；stderr: ${err1}` : ''}；exit ${scanRes.code}），本轮不外发，文件留在 inbox 等下轮`);
    return;
  }
  if (scan.verdict === 'BLOCK') {
    log('命中 L1 硬红线，进 _blocked，不外发');
    await move(file, BLOCKED);
    return;
  }

  // 出网前**一律脱敏**，不再"只有 L2 才脱"。踩过两次：
  //   1) 最初只查 L1 就把正文发给外部桥 —— 等于把软红线原样外发；
  //   2) 后来只对 L2 脱敏，于是 L1(示例值)/PASS 的正文把 `AKIA…EXAMPLE` 这种
  //      串原样送出，被**桥自己的**机密检测拦下（422 secret-blocked）。
  //      教训：我们放行 ≠ 对方放行。占位化只动"长得像凭据"的片段，语义不受影响。
  const redRes = await runTool('pii-scan.mjs', ['--file', file, '--redact']);
  const decision = decideEgress({ scan, redactStdout: redRes.stdout, body });
  if (!decision.allow) {
    if (decision.halt) {
      EGRESS_HALT = decision.reason;
      log(`隐私闸不可用（${decision.reason}），本轮不外发，文件留在 inbox 等下轮`);
      return;
    }
    log('命中 L1 硬红线，进 _blocked，不外发');
    await move(file, BLOCKED);
    return;
  }
  const outbound = decision.outbound;
  const level = decision.level;
  if (decision.replacements) log(`出网前替换 ${decision.replacements} 处可疑串（凭据/隐私占位化）`);

  // 负载闸
  const gate = await runTool('load-gate.mjs', ['--json']);
  if (gate.code === 10 || gate.code === 20) {
    log('负载闸不通过，本轮跳过（文件留在 inbox，下轮再试）');
    return;
  }

  // 桥消化：单段直接出卡；多段先逐段提要点，最后合并成一张卡
  const chunks = splitChunks(outbound);
  // 记**实际答出来的站**，不是默认站：换站链切到 deepseek 才成功时，
  // 审核台账写 qianwen 就是假数据，事后查「哪站好用」会被带偏。
  let lastSite = SITE;
  const ask = async (prompt, label) => {
    await beatHere('think', label);
    // 桥的每个站点都是「已登录网页」的薄壳，登录态会过期、首帧会超时。
    // 原来一个站点挂了就把整篇丢进 _failed，其实换一个站大概率就能过。
    const sites = [SITE, ...FALLBACK_SITES];
    let lastErr = '';
    for (let i = 0; i < sites.length; i += 1) {
      const site = sites[i];
      const r = await bridgeAsk(prompt, site);
      const ans = r.ok ? String(r.data.answer ?? r.data.text ?? '') : '';
      if (r.ok && ans.trim()) {
        if (i > 0) log(`${label}：${SITE} 未通，已自动切到 ${site}`);
        lastSite = site;
        return ans;
      }
      lastErr = r.ok
        ? '桥回答为空'
        : `桥返回 ${r.status}：${r.data?.errorType ?? ''} ${r.data?.message ?? ''}`.trim();
      if (i + 1 < sites.length) log(`${label}：${site} 失败（${lastErr}），换 ${sites[i + 1]} 重试`);
    }
    throw new Error(`${sites.length} 个站点均未拿到回答，最后一处：${lastErr}`);
  };

  // 整篇消化（含多段）。directive 是复核驳回单，只在重做那一次带上。
  // 桥 question 上限 4000 字，驳回单裁到 700 字，不挤掉材料正文。
  const digest = async (directive = '') => {
    const guard = directive ? `${directive.slice(0, 700)}\n\n` : '';
    if (chunks.length === 1) {
      return ask(guard + DIGEST_PROMPT(title) + outbound, `桥消化 ${name}（${SITE}）`);
    }
    log(`材料 ${body.length} 字，分 ${chunks.length} 段消化后合并`);
    const pts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      pts.push(await ask(POINTS_PROMPT(title, i + 1, chunks.length, chunks[i].length) + chunks[i], `分段 ${i + 1}/${chunks.length}（${SITE}）`));
    }
    return ask(
      guard + MERGE_PROMPT(title) + pts.map((p, i) => `【第 ${i + 1} 段要点】\n${p}`).join('\n\n'),
      `合并 ${chunks.length} 段（${SITE}）`
    );
  };

  // 落卡前两道自检：归属（是不是挂错了材料）+ 结构（像不像一张卡）。
  // 两道都靠重试兜——串线和格式塌陷都是桥的偶发行为，重跑一次通常就好。
  //
  // 来源要写**归档后**的路径。原来写 memory/50-inbox/<name>，而这个文件在落卡成功后
  // 立刻被移到 _done/ —— 卡片上那行路径当场失效，三天后想回原文就找不到。
  // 卡片一半的价值是「能回到出处」，所以这里必须写最终位置。
  const src = `memory/50-inbox/_done/${name}`;
  const compose = (raw) =>
    withMeta(raw.length > 4000 ? raw.slice(0, 4000) : raw, {
      source: src,
      at: stamp(),
      level,
      fallbackTitle: title,
    });

  let reply;
  let composed = '';
  let reviewRetries = 0;
  const selfCheck = async () => {
    const bad = [];
    const a = await checkAttribution(reply, outbound, name);
    if (a) bad.push(`归属：${a}`);
    // 结构闸必须判**规范化之后**的正文：桥会把 markdown 的「##」吃掉（实测稳定复现），
    // 但小节名、逐条要点、原文、标签都在，normalizeSections 能补回来。判原始输出会误杀。
    composed = compose(reply);
    const s = checkShape(composed);
    if (s) bad.push(`结构：${s}`);
    // 交付复核（数字/专名能不能回溯到材料）**必须参与裁决**，不能只写台账。
    // 2026-11-11 演练实测：一张结构完整、数字全靠编的卡（9999/8888/7777 材料里根本没有）
    // 归属和结构都过得去 → 直接落盘并归档原文，台账里同时记着 REJECT。等于闸门开着但不拦。
    // 反测过严格度：23 张存量卡 20 PASS / 0 REJECT / 2 未判，把它接进来不会误杀好卡。
    // 正文都坏了（结构/归属）就不必再算回溯——驳回单里已经写清哪坏了。
    if (!bad.length) {
      try {
        const rv = reviewCard({ card: composed, sourceText: outbound });
        if (!rv.ok) {
          for (const r of rv.reasons) bad.push(`复核：${r}`);
          log(`交付复核 REJECT：可回溯率 ${(rv.grounding * 100).toFixed(0)}%，专名 ${(rv.idGrounding * 100).toFixed(0)}%`);
        }
      } catch (e) {
        // 复核闸自己坏了不能反过来拦住落卡（它只是近似判据），但必须说出来
        log('复核闸不可用，本篇按「未判」放行：', e.message);
      }
    }
    return bad;
  };

  try {
    reply = await digest();
    let bad = await selfCheck();
    if (bad.length) {
      // 原来是「3 秒后整篇盲重跑一次」——同样的材料同样的模型，多半还是同样的毛病。
      // 换成门下省式定向重做：把「不合格项 / 缺什么 / 怎么改」随 prompt 下发。
      // 关键：**不增加桥调用次数**（原来也是重跑一次），只是这一跑带着驳回单。
      let directive = '';
      try {
        const rv = reviewCard({ card: composed, sourceText: outbound, reasons: bad });
        directive = buildRetryDirective({ result: rv, extraReasons: bad });
        log(`交付复核 ${rv.verdict}：可回溯率 ${(rv.grounding * 100).toFixed(0)}%，专名 ${(rv.idGrounding * 100).toFixed(0)}%，${rv.reasons.length} 条不合格项`);
      } catch (e) {
        log('审核闸不可用，退回原盲重跑（不影响本次消化）：', e.message);
      }
      reviewRetries = 1;
      log(`自检未通过（${bad.join('；')}）；3 秒后${directive ? '按驳回单定向重做' : '整篇重跑'}一次`);
      await new Promise((r) => setTimeout(r, 3000));
      reply = await digest(directive);
      bad = await selfCheck();
      if (bad.length) {
        log(`重做仍未通过（${bad.join('；')}）→ 进 _failed：宁可不动，也不落一张挂错材料、结构坏掉或数字编出来的卡`);
        // 没落卡也要留一条台账：否则三天后看到 _failed 里一个文件、啥记录都没有，
        // 只能重跑一遍才知道当初为什么拒。台账的作用就是回答「为什么不落」。
        try {
          await appendReviewLog({
            at: new Date().toISOString(),
            name,
            card: null,
            verdict: 'REJECT-未落卡',
            grounding: null,
            idGrounding: null,
            sourceCoverage: null,
            unexplained: [],
            reasons: bad.slice(0, 5),
            reviewRetries,
            site: lastSite,
          }, ROOT);
        } catch { /* 台账写不进去不影响已作出的判定 */ }
        await move(file, FAILED);
        return;
      }
      log('定向重做后自检通过');
    }
    // 超限压缩：分段合并出来的卡经常刚好越过上限（实测 1317 字 / 上限 1200）。
    // 不管的话 intake 的字数闸会硬拒，连拒 3 次就进 _failed——而重试解决不了，
    // 同样的材料同样的模型多半还是那么多字。只压一次，压不好就退回原版让 intake 判。
    if (composed.length > CARD_CAP) {
      log(`卡片 ${composed.length} 字 > 上限 ${CARD_CAP}，压缩一次`);
      const beforeReply = reply;
      const beforeComposed = composed;
      reply = await ask(SHRINK_PROMPT + reply.slice(0, 6000), `压缩卡片（${SITE}）`);
      let badAfter = await selfCheck();
      if (badAfter.length || composed.length > CARD_CAP) {
        // 模型不听话（实测：让它"只压缩"，返回的还长了 9 字）→ 自己按约定截断
        const fitted = fitCard(reply, CARD_CAP - 90);
        if (fitted) {
          reply = fitted;
          badAfter = await selfCheck();
          if (!badAfter.length) log(`压缩未达标，已按优先级截断到 ${composed.length} 字`);
        }
      }
      if (badAfter.length || composed.length > CARD_CAP) {
        log(`压缩后仍不合格（${badAfter.join('；') || `${composed.length} 字`}）→ 退回压缩前版本`);
        reply = beforeReply;
        composed = beforeComposed;
      } else {
        log(`压缩成功：${beforeComposed.length} → ${composed.length} 字`);
      }
    }
    await rememberReply(name, reply);
  } catch (e) {
    const n = await bumpFail(name);
    if (n >= MAX_FAILS) {
      log(`连续 ${n} 次失败，进 _failed：`, e.message);
      await move(file, FAILED);
    } else {
      log(`失败 ${n}/${MAX_FAILS}，留待下轮：`, e.message);
    }
    return;
  }

  // 落卡（intake 自带字数闸/防覆盖/索引重建）
  let card;
  try {
    await beatHere('card', `落卡 ${name}`);
    const intakePath = await toolPath('intake.mjs');
    const intake = await import(pathToFileURL(intakePath).href);
    card = await intake.runIntake({
      root: ROOT,
      title,
      source: src,
      body: composed,
    });
    if (!card.ok) throw new Error(card.message ?? card.errorType ?? 'intake 拒绝');
  } catch (e) {
    const n = await bumpFail(name);
    if (n >= MAX_FAILS) {
      log(`落卡连续 ${n} 次失败，进 _failed：`, e.message);
      await move(file, FAILED);
    } else {
      log(`落卡失败 ${n}/${MAX_FAILS}：`, e.message);
    }
    return;
  }

  const target = await move(file, DONE);
  log(`已落卡 ${card.cardFile ?? '?'}；原文归档 ${path.relative(ROOT, target)}`);
  // 交付复核留痕：本地只读、零网络、不拦截。每篇成功卡都留一条，事后能查
  // 「这张卡当时到底核出了什么」，而不是只有一句「已落卡」。
  // 写台账失败绝不能反过来把已经落好的卡判成失败，所以整体 try/catch 包住。
  try {
    const rv = reviewCard({ card: composed, sourceText: outbound });
    await appendReviewLog({
      at: new Date().toISOString(),
      name,
      card: card.cardFile ?? null,
      verdict: rv.verdict,
      grounding: rv.grounding,
      idGrounding: rv.idGrounding,
      sourceCoverage: rv.sourceCoverage,
      unexplained: rv.unexplained.slice(0, 10),
      reviewRetries,
      site: lastSite,
    }, ROOT);
    log(`交付复核 ${rv.verdict}（可回溯率 ${(rv.grounding * 100).toFixed(0)}%，重做 ${reviewRetries} 次）已记入审核台账`);
  } catch (e) {
    log('审核台账写入失败（不影响已落卡）：', e.message);
  }
  // 成功即清失败计数
  try {
    const m = JSON.parse(await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8'));
    delete m[name];
    await fs.writeFile(path.join(INBOX, '_fails.json'), JSON.stringify(m, null, 2), 'utf8');
  } catch { /* 无计数文件就算了 */ }
}

async function sweep() {
  let entries = [];
  try {
    entries = await fs.readdir(INBOX, { withFileTypes: true });
  } catch { return; }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => path.join(INBOX, e.name));
  for (const f of files) {
    if (EGRESS_HALT) {
      log(`隐私闸不可用，本轮剩余 ${files.length - files.indexOf(f)} 份一律不外发（不跳着发）`);
      break;
    }
    try { await processFile(f); } catch (e) { log('单文件异常（不中断循环）：', e.message); }
  }
  // 一轮结束就熄灯：空转时的灯必须是灭的，否则"亮着"就没有信息量了
  await clearBeat({ scene: BEAT_SCENE, rootDir: ROOT });
  // 顺手清掉其他场景遗留的过期心跳：它们不会被任何人清，攒着就是面板上
  // 那句永久挂着的「N 个心跳已过期」。新鲜的（比如别人刚开始的动作）不碰。
  try { await pruneBeats({ rootDir: ROOT }); } catch { /* 清垃圾失败不影响落卡 */ }
  // 记账放在熄灯之后：台账写失败不能影响这一轮已经落好的卡。
  try { await recordFreeUsage(); } catch (e) { log('免费桥用量入账失败（不影响落卡）：', e.message); }
  return files.length;
}

async function main() {
  await ensureDirs();
  log(`启动：inbox=${INBOX} site=${SITE} bridge=${BRIDGE} ${ONCE ? '（--once）' : `（每 ${INTERVAL_MS / 1000}s 扫描 + watch）`}`);
  if (ONCE) {
    await sweep();
    log('once 完成，退出。');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep(); } catch (e) { log('扫描异常：', e.message); }
    running = false;
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
  try {
    const { watch } = await import('node:fs');
    watch(INBOX, { persistent: true }, (_evt, fname) => {
      if (fname && String(fname).endsWith('.md')) setTimeout(tick, 2000); // 防抖：等写完
    });
  } catch (e) {
    log('fs.watch 不可用，退化为纯轮询：', e.message);
  }
}

await main();
