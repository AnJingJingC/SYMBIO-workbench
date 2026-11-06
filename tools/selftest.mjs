// tools/selftest.mjs —— 工具层自测（锁住"写文件别把表格弄坏"）
//
// 为什么单独有它：workbench 的 40 项契约测试守的是 UI，tools/ 一直是"跑一次、看一眼"。
// 结果同一类坑踩了两次——
//   2026-11-06  project.mjs deliver 把新行插在「## 里程碑」标题前的空行，表格当场截断；
//   2026-11-07  bus.mjs dispatch 在空表时把行 push 到段尾（表头后的空行之后），表格断成两段。
// 两次都是"命令返回 ok、文件也写了"——只有断言能防第三次。
//
// 判据只有一条：**markdown 表格块里不能出现空行**。表头、分隔行、数据行必须连续。
//
// 用法：
//   node tools/selftest.mjs          # 跑全部，全过退出码 0
//   node tools/selftest.mjs --keep   # 保留临时目录，出问题时好翻现场

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = HERE;

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function tmpRoot(keep) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symbio-selftest-'));
  return { dir, cleanup: async () => (keep ? null : fs.rm(dir, { recursive: true, force: true })) };
}

/** 以 SYMBIO_HOME 指向临时目录跑一个工具，返回 { code, stdout, stderr } */
async function runTool(home, tool, args) {
  try {
    const r = await execFileP(process.execPath, [path.join(TOOLS, tool), ...args], {
      env: { ...process.env, SYMBIO_HOME: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * 取出以 headerFirstCell 开头的表格块：从表头行连续收集以 | 开头的行。
 * 遇到空行或非表格行就停——所以"表被空行断开"会直接表现为块变短。
 */
function tableBlock(md, headerFirstCell) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith('|') && l.includes(headerFirstCell));
  if (start < 0) return null;
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) break;
    block.push(lines[i]);
  }
  return block;
}

const isSep = (l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes('-');

/**
 * 找出被空行断开的表格：某行以 | 开头，前一行是空行、前两行也是 | 开头的行。
 * 这正是两次真实事故的形态——数据行写进去了，但掉在表格外面，渲染出来表是断的。
 * 返回坏行号（从 1 开始），数组为空表示全文表格都完整。
 */
function brokenTables(md) {
  const lines = md.split(/\r?\n/);
  const bad = [];
  for (let i = 2; i < lines.length; i += 1) {
    const cur = lines[i].trim();
    const prev = lines[i - 1].trim();
    const prev2 = lines[i - 2].trim();
    if (cur.startsWith('|') && prev === '' && prev2.startsWith('|')) bad.push(i + 1);
  }
  return bad;
}

// ── 1. bus：空表派单不能把表断开 ──────────────────────────────
async function testBus(keep) {
  console.log('\nbus.mjs · 看板写入');
  const { dir, cleanup } = await tmpRoot(keep);
  try {
    await fs.mkdir(path.join(dir, 'memory', '10-shared'), { recursive: true });
    await fs.mkdir(path.join(dir, 'memory', '90-archive'), { recursive: true });
    await fs.mkdir(path.join(dir, 'memory', '20-scenes', '场景乙'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'memory', '10-shared', '任务看板.md'),
      [
        '# 任务看板（只放未闭环任务）',
        '',
        '| 时间 | 来源 | 目标 | 任务 | 状态 | 需要回执 |',
        '|---|---|---|---|---|---|',
        '',
        '## 冲突与待裁决',
        '',
        '| 时间 | 事项 | 涉及场景 | 待宿主决定 |',
        '|---|---|---|---|',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'memory', '20-scenes', '场景乙', '定位卡.md'), '# 场景乙\n\n- 定位：自测用\n', 'utf8');

    const boardPath = path.join(dir, 'memory', '10-shared', '任务看板.md');
    const read = () => fs.readFile(boardPath, 'utf8');

    // 空表 → 派第一单
    const r1 = await runTool(dir, 'bus.mjs', ['dispatch', '--from', '甲', '--to', '场景乙', '--task', '自测一', '--accept', '结论']);
    check(r1.code === 0, '空表派单返回成功', r1.stderr || r1.stdout);
    let block = tableBlock(await read(), '时间');
    check(!!block && block.length === 3, '空表派单后表格是 3 行（表头+分隔+1 条数据）', `实际 ${block ? block.length : 0} 行`);
    check(!!block && isSep(block[1]), '第 2 行仍是分隔行（数据行没插到表头上面）');
    check(!!block && block[2]?.includes('running'), '第 3 行是数据行，紧接分隔行、中间无空行');

    // 非空表 → 派第二单，应接在第 1 条之后
    await runTool(dir, 'bus.mjs', ['dispatch', '--from', '甲', '--to', '场景乙', '--task', '自测二', '--accept', '结论']);
    block = tableBlock(await read(), '时间');
    check(!!block && block.length === 4, '第二条派单后表格 4 行', `实际 ${block ? block.length : 0} 行`);
    check(!!block && block[3]?.includes('自测二'), '新行接在已有数据行之后');

    // 回执 → 划掉一行
    const hash = (block?.[2]?.match(/#([0-9a-f]{8})/) ?? [])[1];
    const r3 = await runTool(dir, 'bus.mjs', ['receipt', '--hash', hash || 'deadbeef', '--status', 'done', '--result', '过了']);
    check(r3.code === 0, '回执返回成功', r3.stderr || r3.stdout);
    block = tableBlock(await read(), '时间');
    check(!!block && block.length === 3, '回执后表格回到 3 行（该行被划掉）', `实际 ${block ? block.length : 0} 行`);
    check(!!block && !block.some((l) => l.includes(hash)), '被回执的那一行不在表格里了');

    // 冲突表（第二张表）没被波及
    const conflict = tableBlock(await read(), '事项');
    check(!!conflict && conflict.length === 2, '第二张表（冲突与待裁决）结构未受影响', `实际 ${conflict ? conflict.length : 0} 行`);

    // 全文扫描：任何被空行断开的表格都算坏
    const broken = brokenTables(await read());
    check(broken.length === 0, '看板全文没有"被空行断开的表格"', broken.length ? `坏行：${broken.join('、')}` : '');
  } finally {
    await cleanup();
  }
}

// ── 2. project：交付物登记不能把表断开 ────────────────────────
async function testProject(keep) {
  console.log('\nproject.mjs · 项目卡写入');
  const { dir, cleanup } = await tmpRoot(keep);
  try {
    await fs.mkdir(path.join(dir, 'projects'), { recursive: true });
    const r1 = await runTool(dir, 'project.mjs', ['new', '--name', '自测项目', '--client', '内部', '--need', '验证插行不断表']);
    check(r1.code === 0, 'project new 成功', r1.stderr || r1.stdout);

    const artifact = path.join(dir, 'artifact.txt');
    await fs.writeFile(artifact, 'artifact', 'utf8');
    const r2 = await runTool(dir, 'project.mjs', ['deliver', '--name', '自测项目', '--item', '自测交付', '--file', artifact]);
    check(r2.code === 0, 'project deliver 成功', r2.stderr || r2.stdout);

    const card = await fs.readFile(path.join(dir, 'projects', '自测项目', '项目卡.md'), 'utf8');
    const closed = tableBlock(card, '事件');
    check(!!closed, '项目卡里有里程碑表（表头含"事件"）');
    if (closed) {
      check(isSep(closed[1]), '里程碑表第 2 行是分隔行', JSON.stringify(closed.slice(0, 3)));
      check(closed.length === 3, '里程碑表 3 行（表头+分隔+立项那一行）', `实际 ${closed.length} 行`);
      check(!!closed[2] && closed[2].includes('立项'), '立项行紧接分隔行');
    }
    const deliver = tableBlock(card, '交付物');
    check(!!deliver && deliver.length === 3, '交付物表 3 行（表头+分隔+1 条交付）', `实际 ${deliver ? deliver.length : 0} 行`);
    check(!!deliver && deliver[2].includes('自测交付'), '交付行紧接分隔行、内容正确');

    const broken = brokenTables(card);
    check(broken.length === 0, '项目卡全文没有"被空行断开的表格"', broken.length ? `坏行：${broken.join('、')}` : '');
  } finally {
    await cleanup();
  }
}

async function main() {
  const keep = process.argv.includes('--keep');
  console.log('SYMBIO 工具层自测');
  await testBus(keep);
  await testProject(keep);
  console.log(`\n结论：PASS ${pass} / FAIL ${fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return fail ? 1 : 0;
}

main().then((c) => process.exit(c));
