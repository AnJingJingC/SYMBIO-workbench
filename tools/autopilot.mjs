// autopilot.mjs —— 挂监听 + 外部免费算力的无人循环（作者机制清单最后一项的落地）
//
// 链路：memory/50-inbox/*.md（宿主随手丢长文）
//   → load-gate（CPU/内存过高不派活）
//   → pii-scan（L1 命中即拦，进 _blocked/）
//   → 免费 AI 桥消化（豆包等，要求 ≤1200 字知识卡片格式）
//   → tools/intake.mjs 确定性落卡 + 索引重建
//   → 原文移 _done/（失败 _failed/，超长 _too-long/）
//
// 用法：
//   node tools/autopilot.mjs --once              # 只处理现有文件后退出（点测用）
//   node tools/autopilot.mjs                     # 常驻监听（默认 30s 扫描 + fs.watch 即时触发）
//   node tools/autopilot.mjs --interval 60000 --site deepseek
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
import { beat, clearBeat } from './lib/heartbeat.mjs';

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
const SITE = flag('site') || 'doubao';
const ROOT = process.env.SYMBIO_HOME || 'E:/SYMBIO';
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';
const INBOX = path.join(ROOT, 'memory/50-inbox');
const DONE = path.join(INBOX, '_done');
const BLOCKED = path.join(INBOX, '_blocked');
const FAILED = path.join(INBOX, '_failed');
const TOOLONG = path.join(INBOX, '_too-long');
const BODY_CAP = 2800;          // 桥 4000 字上限 − 指令余量
const MAX_CHUNKS = 6;           // 分段上限：再多就不值得（额度与合并质量都撑不住）
const MAX_FAILS = 3;

const log = (...m) => console.log(`[autopilot ${new Date().toISOString()}]`, ...m);

// 亮灯用的活动心跳。TTL 给到 240s：桥消化一张卡实测 8~25s，冷启动重试可能到 70s，
// 面板若 90s 就判灭，会出现"明明还在跑，灯却灭了"的假象。
const BEAT_SCENE = 'knowledge-digest';
const BEAT_TTL = 240_000;
const beatHere = (phase, detail) => beat({ scene: BEAT_SCENE, phase, detail, ttlMs: BEAT_TTL, rootDir: ROOT });

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

async function bridgeAsk(question) {
  const res = await fetch(`${BRIDGE}/webai/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site: SITE, question }),
    signal: AbortSignal.timeout(200_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.ok !== false, data };
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
  return [head, '', `- 来源：${source}`, `- 摄入时间：${at}`, `- 密级：${level}`, '', ...normalizeSections(lines)]
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

const POINTS_PROMPT = (title, i, n) =>
  `这是《${title}》的第 ${i}/${n} 段。请**只**提取 3-5 条要点，每条一行、以「- 」开头，` +
  `保留具体数字、专有名词与结论。不要写标题、不要写总结、不要输出别的任何话。\n\n段落：\n`;

const MERGE_PROMPT = (title) =>
  `下面是同一篇材料《${title}》分段提取的要点。请合并成**一张知识卡片**（注意：是卡片，不是要点列表），严格满足：` +
  `① 总字数 ≤1200 字；② 第一行是「# <卡片标题>」，标题一句话说清这是什么；` +
  CARD_SHAPE.replace('③ ', '') +
  `④ 去重、按重要性排序，不要出现「第几段」这类分段痕迹。不要输出卡片以外的任何话。\n\n`;

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
  const scan = await runTool('pii-scan.mjs', ['--file', file, '--json']);
  let scanLevel = '';
  try {
    scanLevel = JSON.parse(scan.stdout)?.level || '';
  } catch { /* 解析不了就按空处理，后面按最保守走 */ }
  if (scan.code === 2 || /"level"\s*:\s*"L1"|\bBLOCK\b/i.test(scan.stdout)) {
    log('命中 L1 硬红线，进 _blocked，不外发');
    await move(file, BLOCKED);
    return;
  }

  // L2（手机号/工资/病历…）：必须先脱敏再出网。
  // 踩过：原来只查 L1 就把正文发给外部桥 —— 等价于把软红线原样外发，违反
  // 「L2 默认本地处理，确需出网必须脱敏」。脱敏失败就进 _blocked，宁可不动。
  let outbound = body;
  let level = 'L0 公开';
  if (scanLevel === 'L2') {
    const red = await runTool('pii-scan.mjs', ['--file', file, '--redact']);
    let redacted = '';
    try {
      // --redact 的输出是 JSON（redactedText 在里面），不是裸文本。
      // 直接把 stdout 当正文发出去 = 把一坨 JSON 喂给桥。
      redacted = JSON.parse(red.stdout)?.redactedText || '';
    } catch { /* 解析失败按脱敏失败处理 */ }
    if (!redacted || redacted.length < body.length * 0.3) {
      log('L2 命中但脱敏失败，进 _blocked（不外发）');
      await move(file, BLOCKED);
      return;
    }
    outbound = redacted;
    level = 'L2 已脱敏';
    log('命中 L2，已脱敏后再送桥');
  }

  // 负载闸
  const gate = await runTool('load-gate.mjs', ['--json']);
  if (gate.code === 10 || gate.code === 20) {
    log('负载闸不通过，本轮跳过（文件留在 inbox，下轮再试）');
    return;
  }

  // 桥消化：单段直接出卡；多段先逐段提要点，最后合并成一张卡
  const chunks = splitChunks(outbound);
  const ask = async (prompt, label) => {
    await beatHere('think', label);
    const r = await bridgeAsk(prompt);
    if (!r.ok) {
      throw new Error(`桥返回 ${r.status}：${r.data?.errorType ?? ''} ${r.data?.message ?? ''}`.trim());
    }
    const ans = String(r.data.answer ?? r.data.text ?? '');
    if (!ans.trim()) throw new Error('桥回答为空');
    return ans;
  };

  // 整篇消化（含多段）。
  const digest = async () => {
    if (chunks.length === 1) {
      return ask(DIGEST_PROMPT(title) + outbound, `桥消化 ${name}（${SITE}）`);
    }
    log(`材料 ${body.length} 字，分 ${chunks.length} 段消化后合并`);
    const pts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      pts.push(await ask(POINTS_PROMPT(title, i + 1, chunks.length) + chunks[i], `分段 ${i + 1}/${chunks.length}（${SITE}）`));
    }
    return ask(
      MERGE_PROMPT(title) + pts.map((p, i) => `【第 ${i + 1} 段要点】\n${p}`).join('\n\n'),
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
  const selfCheck = async () => {
    const bad = [];
    const a = await checkAttribution(reply, outbound, name);
    if (a) bad.push(`归属：${a}`);
    // 结构闸必须判**规范化之后**的正文：桥会把 markdown 的「##」吃掉（实测稳定复现），
    // 但小节名、逐条要点、原文、标签都在，normalizeSections 能补回来。判原始输出会误杀。
    composed = compose(reply);
    const s = checkShape(composed);
    if (s) bad.push(`结构：${s}`);
    return bad;
  };

  try {
    reply = await digest();
    let bad = await selfCheck();
    if (bad.length) {
      log(`自检未通过（${bad.join('；')}）；3 秒后整篇重跑一次`);
      await new Promise((r) => setTimeout(r, 3000));
      reply = await digest();
      bad = await selfCheck();
      if (bad.length) {
        log(`重跑仍未通过（${bad.join('；')}）→ 进 _failed：宁可不动，也不落一张挂错材料或结构坏掉的卡`);
        await move(file, FAILED);
        return;
      }
      log('重跑后自检通过');
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
    try { await processFile(f); } catch (e) { log('单文件异常（不中断循环）：', e.message); }
  }
  // 一轮结束就熄灯：空转时的灯必须是灭的，否则"亮着"就没有信息量了
  await clearBeat({ scene: BEAT_SCENE, rootDir: ROOT });
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
