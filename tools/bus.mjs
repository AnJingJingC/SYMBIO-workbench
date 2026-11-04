// bus.mjs —— 跨场景任务文件总线（确定性派单/回执）
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
//   node tools/bus.mjs board [--json]
//
// 防重复：同一 from|to|task 的 8 位 hash 已在看板或台账出现 → 拒绝二次派单。
// 台账：memory/90-archive/任务台账-<YYYY-MM>.md（L5 只追加）。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PLACEHOLDER = '| — | — | — | （当前无未闭环任务） | — | — |';
const SPLIT = '## 冲突与待裁决';

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
  // 找任务表格的最后一行，插在其后；找不到就追加到段尾
  const rows = taskRowLines(lines);
  if (rows.length) {
    const lastIdx = lines.lastIndexOf(rows[rows.length - 1]);
    lines.splice(lastIdx + 1, 0, row);
  } else {
    lines.push(row);
  }
  await fs.writeFile(p, lines.join('\n') + (tail ? '\n' + tail : ''), 'utf8');
  return { ok: true, hash: h, row, board: 'memory/10-shared/任务看板.md', message: `已派单 #${h}：${from} → ${to}。等对方回执。` };
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
  const { date, month } = nowStamp();
  const ledgerPath = path.join(root(), `memory/90-archive/任务台账-${month}.md`);
  try {
    await fs.access(ledgerPath);
  } catch {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, `# 任务台账 ${month}（只追加，不删改）\n\n| 时间 | hash | 来源 | 目标 | 任务 | 结果 | 产出 |\n|---|---|---|---|---|---|---|\n`, 'utf8');
  }
  const row = `| ${time} | ${h} | ${esc(from)} | ${esc(to)} | ${esc(task.replace(/#\w{8}\s*$/, ''))} | ${status}${result ? '：' + esc(result) : ''} | ${esc(artifact)} |`;
  await fs.appendFile(ledgerPath, row + '\n', 'utf8');
  const closed = receipt === 'no' || status !== 'done';
  return { ok: true, hash: h, status, closed, ledger: `memory/90-archive/任务台账-${month}.md`, message: closed ? `任务 #${h} 闭环。need_receipt=no 或非 done，任何人不得再回执。` : `已记回执 #${h}，链上还有下家（need_receipt=yes）。` };
}

async function cmdBoard() {
  const { text } = await readBoard();
  if (text === null) return { ok: false, errorType: 'board-missing' };
  const { lines } = splitBoard(text);
  const tasks = taskRowLines(lines).map((l) => {
    const c = l.slice(1, -1).split('|').map((x) => x.trim());
    return { time: c[0], from: c[1], to: c[2], task: c[3], status: c[4], receipt: c[5] };
  });
  return { ok: true, openTasks: tasks.length, tasks };
}

async function main() {
  let out;
  if (cmd === 'dispatch') out = await cmdDispatch();
  else if (cmd === 'receipt') out = await cmdReceipt();
  else if (cmd === 'board') out = await cmdBoard();
  else out = { ok: false, errorType: 'bad-request', message: '用法：bus.mjs dispatch|receipt|board（--help 见文件头注释）' };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = out.ok === false ? (out.errorType === 'bad-request' ? 1 : 2) : 0;
}

await main();
