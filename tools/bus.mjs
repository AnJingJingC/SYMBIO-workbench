// bus.mjs —— 跨场景任务文件总线（确定性派单/回执/插队）
//
// 设计原则（对齐作者哲学「场景=节点、交接=连线、看板=总线、索引=地图」）：
//   看板 memory/10-shared/任务看板.md 就是总线本身——派单=写一行，回执=划掉一行+台账留痕。
//   与 symbio-dispatch 技能同一套语义（派单四件套 / need_receipt / ≤3 条闭环），
//   本工具把"写盘"这一步做成确定性落盘，宿主 Agent 只需调 CLI，不再手改表格。
//
// 用法：
//   node tools/bus.mjs dispatch --from deep-research --to knowledge-digest \
//        --task "把调研卡片归档进知识卡目录" --accept "卡片出现在 cards/ 且索引更新"
//   node tools/bus.mjs receipt --hash a1b2c3d4 --status done --result "已归档" --artifact "cards/xxx.md"
//   node tools/bus.mjs board
//   node tools/bus.mjs preempt --from 宿主 --to deep-research \
//        --task "紧急：对比今晚要" --accept "对比卡入库" \
//        --reason "老板指令" [--cut a1b2c3d4]
//
// 插队协议（2026-11-16 补）：
//   谁能插队 —— config/preempt-policy.json 的 allow 白名单；文件缺失/坏 JSON/字段不合法一律拒绝
//               （fail-closed，和隐私闸同一纪律：判不出不许猜）。默认策略只有「宿主」。
//   能截断谁 —— 目标场景要有定位卡；--cut 只能指向看板在途的普通任务，禁止链式抢占插队任务。
//   怎么收尾 —— 被截断的任务走 interrupted 回执：划行 + 台账留痕（记截断理由），不凭空消失。
//   插队任务置顶 + [插队] 标记；未闭环插队数受 maxOpen 限制，防止插队把看板淹没。
//   注意：这是协议层（谁能插/怎么收尾），真正的抢占执行仍受宿主形态限制，见差距报告。
//
// 防重复：同一 from|to|task 的 8 位 hash 已在看板或台账出现 → 拒绝二次派单。
// 台账：memory/90-archive/任务台账-<YYYY-MM>.md（L5 只追加）。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { beat, clearBeat } from './lib/heartbeat.mjs';

const PLACEHOLDER = '| — | — | — | （当前无未闭环任务） | — | — |';
const SPLIT = '## 冲突与待裁决';
const PREEMPT_TAG = '[插队]';
const POLICY_REL = 'config/preempt-policy.json';
const DEFAULT_MAX_OPEN = 3;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
};

function root() {
  return process.env.SYMBIO_HOME || 'E:/SYMBIO';
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    stamp: `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    month: `${d.getFullYear()}-${p(d.getMonth() + 1)}`,
  };
}

function hashOf(from, to, task) {
  return crypto.createHash('sha1').update(`${from}|${to}|${task}`).digest('hex').slice(0, 8);
}

const isSepLine = (l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes('-');

/**
 * 插队权限闸：任何一步判不出都拒绝，绝不按"允许"处理。
 * 与 lib/pii-gate.mjs 同一纪律——没有第四种结局（allow / block / halt）。
 */
async function loadPreemptPolicy() {
  const p = path.join(root(), POLICY_REL);
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return { ok: false, reason: `策略文件缺失或读不出：${POLICY_REL}` };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '策略文件不是合法 JSON' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: '策略文件顶层必须是对象' };
  if (!Array.isArray(j.allow) || !j.allow.length || !j.allow.every((s) => typeof s === 'string' && s.trim())) {
    return { ok: false, reason: 'allow 必须是非空字符串数组' };
  }
  const maxOpen = j.maxOpen === undefined ? DEFAULT_MAX_OPEN : Number(j.maxOpen);
  if (!Number.isInteger(maxOpen) || maxOpen < 1) return { ok: false, reason: 'maxOpen 必须是 ≥1 的整数' };
  return { ok: true, allow: new Set(j.allow.map((s) => s.trim())), maxOpen };
}

async function readBoard() {
  const p = path.join(root(), 'memory/10-shared/任务看板.md');
  try {
    return { p, text: await fs.readFile(p, 'utf8') };
  } catch {
    return { p, text: null };
  }
}

/** 拆出任务段行（跳过表头/分隔/占位），返回 { lines, body } */
function splitBoard(text) {
  const idx = text.indexOf(SPLIT);
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const tail = idx >= 0 ? SPLIT + text.slice(idx + SPLIT.length) : '';
  const lines = head.split(/\r?\n/);
  return { lines, tail };
}

function taskRowLines(lines) {
  return lines.filter((l) => {
    const t = l.trim();
    if (!t.startsWith('|')) return false;
    const cells = t.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return false; // 分隔行
    if (/^(时间|来源)/.test(cells[0] ?? '')) return false; // 表头
    if (t.includes('当前无未闭环任务')) return false; // 占位行
    return true;
  });
}

async function hashExistsAnywhere(hash) {
  // 看板 + 当月/近年台账，出现同 hash 即拒绝（防重复派单/防重复回执）
  const board = await readBoard();
  if (board.text && board.text.includes(`#${hash}`)) return true;
  const archiveDir = path.join(root(), 'memory/90-archive');
  let files = [];
  try {
    files = (await fs.readdir(archiveDir)).filter((f) => /^任务台账-\d{4}-\d{2}\.md$/.test(f));
  } catch { /* 无归档目录视为不存在 */ }
  for (const f of files) {
    try {
      const t = await fs.readFile(path.join(archiveDir, f), 'utf8');
      if (t.includes(`#${hash}`)) return true;
    } catch { /* 单文件读不了就跳过，不阻断 */ }
  }
  return false;
}

/** 台账只追加：回执与被截断回执共用一处格式，避免两处漂移。 */
async function appendLedger({ time, h, from, to, task, status, result, artifact }) {
  const { month } = nowStamp();
  const ledgerPath = path.join(root(), `memory/90-archive/任务台账-${month}.md`);
  try {
    await fs.access(ledgerPath);
  } catch {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, `# 任务台账 ${month}（只追加，不删改）\n\n| 时间 | hash | 来源 | 目标 | 任务 | 结果 | 产出 |\n|---|---|---|---|---|---|---|\n`, 'utf8');
  }
  const row = `| ${time} | ${h} | ${esc(from)} | ${esc(to)} | ${esc(task.replace(/#\w{8}\s*$/, ''))} | ${status}${result ? '：' + esc(result) : ''} | ${esc(artifact)} |`;
  await fs.appendFile(ledgerPath, row + '\n', 'utf8');
  return `memory/90-archive/任务台账-${month}.md`;
}

async function cmdDispatch() {
  const from = flag('from'), to = flag('to'), task = flag('task'), accept = flag('accept');
  const needReceipt = (flag('need-receipt') || 'yes') === 'no' ? 'no' : 'yes';
  if (!from || !to || !task || !accept) {
    return { ok: false, errorType: 'bad-request', message: '缺字段：--from/--to/--task/--accept 全部必填（派单四件套的最小集）' };
  }
  const toDir = path.join(root(), 'memory/20-scenes', to);
  const isHost = to === '宿主';
  if (!isHost) {
    try {
      await fs.access(path.join(toDir, '定位卡.md'));
    } catch {
      return { ok: false, errorType: 'scene-missing', message: `目标场景不存在或没有定位卡：memory/20-scenes/${to}/定位卡.md，拒收` };
    }
  }
  const h = hashOf(from, to, task);
  if (await hashExistsAnywhere(h)) {
    return { ok: false, errorType: 'duplicate', hash: h, message: `同一任务(#${h})已存在派单或回执记录，不再发起（防死循环规则 4）` };
  }
  const { stamp } = nowStamp();
  const row = `| ${stamp} | ${esc(from)} | ${esc(to)} | ${esc(task)} #${h} | running | ${needReceipt} |`;
  const { p, text } = await readBoard();
  if (text === null) return { ok: false, errorType: 'board-missing', message: '任务看板不存在：memory/10-shared/任务看板.md' };
  let { lines, tail } = splitBoard(text);
  lines = lines.filter((l) => !l.includes('当前无未闭环任务')); // 来了真任务，占位行让位
  // 插在「表格最后一行」之后。空表时 rows 为空，此时不能再 push 到段尾——
  // splitBoard 给出的 lines 末尾还跟着表头后的空行，插在那儿会让数据行掉出表格
  // （2026-11-07 实测：插完后表头与数据行之间多了一个空行，表格当场断成两段）。
  const rows = taskRowLines(lines);
  let anchor = rows.length ? lines.lastIndexOf(rows[rows.length - 1]) : -1;
  if (anchor < 0) {
    // 空表：锚定最后一个以 | 开头的行（表头或分隔行），没有就追加
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim().startsWith('|')) { anchor = i; break; }
    }
  }
  if (anchor >= 0) lines.splice(anchor + 1, 0, row);
  else lines.push(row);
  await fs.writeFile(p, lines.join('\n') + (tail ? '\n' + tail : ''), 'utf8');
  // 派单亮灯：灯挂在**出手的一方**（from），因为"谁在派活"才是活动信号。
  // 点亮后立刻熄灭：派单是毫秒级的一次性动作，亮 60 秒就是假装还在干活——
  // 而 60 秒后它会变成 stale，面板上永久挂一句「N 个心跳已过期」。
  await beat({ scene: from, phase: 'dispatch', detail: `派单 #${h} → ${to}`, ttlMs: 60_000, rootDir: root() });
  await clearBeat({ scene: from, rootDir: root() });
  return { ok: true, hash: h, row, board: 'memory/10-shared/任务看板.md', message: `已派单 #${h}：${from} → ${to}。等对方回执。` };
}

async function cmdPreempt() {
  const from = flag('from'), to = flag('to'), task = flag('task');
  const accept = flag('accept'), reason = flag('reason'), cut = flag('cut');
  if (!from || !to || !task || !accept || !reason) {
    return { ok: false, errorType: 'bad-request', message: '缺字段：--from/--to/--task/--accept/--reason 全部必填（--cut 可选）' };
  }

  // ① 权限闸先行：判不出就不许插队（与隐私闸同一 fail-closed 纪律）
  const policy = await loadPreemptPolicy();
  if (!policy.ok) {
    return { ok: false, errorType: 'gate-unavailable', message: `插队权限闸判不出结论：${policy.reason}。默认拒绝，不猜。` };
  }
  if (!policy.allow.has(from)) {
    return { ok: false, errorType: 'not-authorized', message: `场景「${from}」不在插队白名单（${[...policy.allow].join(' / ')}），无权插队` };
  }

  // ② 目标场景存在性（与 dispatch 同一判据）
  const toDir = path.join(root(), 'memory/20-scenes', to);
  if (to !== '宿主') {
    try {
      await fs.access(path.join(toDir, '定位卡.md'));
    } catch {
      return { ok: false, errorType: 'scene-missing', message: `目标场景不存在或没有定位卡：memory/20-scenes/${to}/定位卡.md，拒收` };
    }
  }

  const { p, text } = await readBoard();
  if (text === null) return { ok: false, errorType: 'board-missing', message: '任务看板不存在：memory/10-shared/任务看板.md' };
  let { lines, tail } = splitBoard(text);

  // ③ 被截断任务：只能是看板在途的普通任务，插队任务不许互相截断（防链式抢占）
  let cutRow = '';
  let cutCells = [];
  if (cut) {
    cutRow = text.split(/\r?\n/).find((l) => l.includes(`#${cut}`) && l.trim().startsWith('|')) ?? '';
    if (!cutRow) return { ok: false, errorType: 'cut-not-found', message: `看板上没有 #${cut} 的在途任务，不能截断不存在的任务` };
    cutCells = cutRow.slice(1, -1).split('|').map((c) => c.trim());
    if (cutCells[3]?.startsWith(PREEMPT_TAG)) {
      return { ok: false, errorType: 'cut-preempt', message: '不能截断另一条插队任务（禁止链式抢占）' };
    }
  }

  // ④ 重复与配额
  const h = hashOf(from, to, `${PREEMPT_TAG}${task}`);
  if (await hashExistsAnywhere(h)) {
    return { ok: false, errorType: 'duplicate', hash: h, message: `同一插队任务(#${h})已存在，不再发起` };
  }
  const openPreempts = taskRowLines(lines).filter((l) => l.includes(PREEMPT_TAG)).length;
  if (openPreempts >= policy.maxOpen) {
    return { ok: false, errorType: 'quota', message: `未闭环插队 ${openPreempts} 条已达上限 ${policy.maxOpen}，先回执再插` };
  }

  // ⑤ 写盘：先给被截断任务收尾（划行 + 台账），再插队置顶
  let ledger = '';
  if (cutRow) {
    lines = lines.filter((l) => l !== cutRow);
    ledger = await appendLedger({
      time: cutCells[0], h: cut, from: cutCells[1], to: cutCells[2], task: cutCells[3],
      status: 'interrupted', result: `被插队截断（${reason}）`, artifact: '',
    });
  }
  lines = lines.filter((l) => !l.includes('当前无未闭环任务'));
  const { stamp } = nowStamp();
  const row = `| ${stamp} | ${esc(from)} | ${esc(to)} | ${PREEMPT_TAG} ${esc(task)} #${h} | running | yes |`;
  const sepIdx = lines.findIndex(isSepLine);
  if (sepIdx < 0) return { ok: false, errorType: 'board-malformed', message: '看板表格没有分隔行，拒绝写入（防把表写断）' };
  lines.splice(sepIdx + 1, 0, row);
  await fs.writeFile(p, lines.join('\n') + (tail ? '\n' + tail : ''), 'utf8');

  // ⑥ 亮灯即灭（和 dispatch 同理，插队也是毫秒级动作）
  await beat({ scene: from, phase: 'preempt', detail: `插队 #${h}${cut ? ` 截断 #${cut}` : ''} → ${to}`, ttlMs: 60_000, rootDir: root() });
  await clearBeat({ scene: from, rootDir: root() });

  return {
    ok: true, hash: h, preempt: true, cut: cut || '', row,
    ledger, board: 'memory/10-shared/任务看板.md',
    message: `已插队 #${h}：${from} → ${to}${cut ? `，#${cut} 记为 interrupted 并留痕` : ''}。插队任务置顶，先做它。`,
  };
}

async function cmdReceipt() {
  const h = flag('hash'), status = flag('status') || 'done';
  const result = flag('result'), artifact = flag('artifact');
  if (!h) return { ok: false, errorType: 'bad-request', message: '缺 --hash' };
  if (!['done', 'blocked', 'rejected'].includes(status)) {
    return { ok: false, errorType: 'bad-request', message: '--status 只能是 done | blocked | rejected' };
  }
  const { p, text } = await readBoard();
  if (text === null) return { ok: false, errorType: 'board-missing', message: '任务看板不存在' };
  const hit = text.split(/\r?\n/).find((l) => l.includes(`#${h}`) && l.trim().startsWith('|'));
  if (!hit) return { ok: false, errorType: 'not-found', message: `看板上没有 #${h} 的任务行（可能已闭环或未派单）` };
  const cells = hit.slice(1, -1).split('|').map((c) => c.trim());
  const [time, from, to, task, , receipt] = cells;
  // 划行：删掉该行；看板空了就补回占位行
  let { lines, tail } = splitBoard(text);
  lines = lines.filter((l) => l !== hit);
  if (!taskRowLines(lines).length && !lines.some((l) => l.includes('当前无未闭环任务'))) {
    const headerIdx = lines.findIndex((l) => /^\|\s*时间/.test(l.trim()));
    lines.splice(headerIdx + 2, 0, PLACEHOLDER); // 表头 + 分隔行之后
  }
  await fs.writeFile(p, lines.join('\n') + (tail ? '\n' + tail : ''), 'utf8');
  // 台账（L5 只追加）
  const ledger = await appendLedger({ time, h, from, to, task, status, result, artifact });
  const closed = receipt === 'no' || status !== 'done';
  await beat({ scene: from, phase: closed ? 'idle' : 'receipt', detail: `回执 #${h} ${status}`, ttlMs: 60_000, rootDir: root() });
  await clearBeat({ scene: from, rootDir: root() });
  return { ok: true, hash: h, status, closed, ledger, message: closed ? `任务 #${h} 闭环。need_receipt=no 或非 done，任何人不得再回执。` : `已记回执 #${h}，链上还有下家（need_receipt=yes）。` };
}

async function cmdBoard() {
  const { text } = await readBoard();
  if (text === null) return { ok: false, errorType: 'board-missing' };
  const { lines } = splitBoard(text);
  const tasks = taskRowLines(lines).map((l) => {
    const c = l.slice(1, -1).split('|').map((x) => x.trim());
    const isPreempt = (c[3] ?? '').startsWith(PREEMPT_TAG);
    return {
      time: c[0], from: c[1], to: c[2],
      task: isPreempt ? c[3].slice(PREEMPT_TAG.length).trim() : c[3],
      status: c[4], receipt: c[5],
      priority: isPreempt ? 'preempt' : 'normal',
    };
  });
  return {
    ok: true,
    openTasks: tasks.length,
    preempts: tasks.filter((t) => t.priority === 'preempt').length,
    tasks,
  };
}

async function main() {
  let out;
  if (cmd === 'dispatch') out = await cmdDispatch();
  else if (cmd === 'receipt') out = await cmdReceipt();
  else if (cmd === 'preempt') out = await cmdPreempt();
  else if (cmd === 'board') out = await cmdBoard();
  else out = { ok: false, errorType: 'bad-request', message: '用法：bus.mjs dispatch|receipt|preempt|board（--help 见文件头注释）' };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = out.ok === false ? (out.errorType === 'bad-request' ? 1 : 2) : 0;
}

await main();
