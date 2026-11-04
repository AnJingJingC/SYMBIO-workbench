// tools/project.mjs —— 项目台账：从"理解需求"到"交付归档"的一条链
//
// 为什么单开一层，而不是塞进 memory/：
//   memory 是**AI 的记忆**（场景怎么干活的），projects 是**业务的事实**（给谁做了什么、交付了什么）。
//   混在一起会出现两种事故：① 项目结束归档时把场景记忆一起删了；② 客户交付物散落在场景目录里找不到。
//
// 作者的做法（十期视频）：理解需求 → 定制工作台 → 打包 → 自动建档。本工具补的就是"建档"这一环，
// 并且把交付物挂进项目目录，做到**一个项目一个文件夹，交付即留痕**。
//
// 目录：
//   projects/索引.md
//   projects/<项目>/项目卡.md     需求原话 / 交付物 / 里程碑 / 验收 / 状态
//   projects/<项目>/交付/<文件>    实际交付物（deliver --file 复制进来）
//
// 用法：
//   node tools/project.mjs new --name <项目> --client <客户> --need "需求原话" [--due 2026-12-01] [--budget 0]
//   node tools/project.mjs list [--status 进行中] [--json]
//   node tools/project.mjs show --name <项目>
//   node tools/project.mjs status --name <项目> --set 进行中|待验收|已交付|暂停 [--note "..."]
//   node tools/project.mjs deliver --name <项目> --item "交付物名" [--file <路径>] [--note "..."]
//   node tools/project.mjs index

import fs from 'node:fs/promises';
import path from 'node:path';
import { root, flag, has, esc, slug, nowStamp, ensureDir, exists, readText, frontMatter } from './lib/common.mjs';
import { beat } from './lib/heartbeat.mjs';

const PROJECTS = 'projects';
const CARD = '项目卡.md';
const STATES = ['意向', '进行中', '待验收', '已交付', '暂停'];

const args = process.argv.slice(2);
const cmd = args[0];

function oneLine(s, max = 50) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 扫全部项目：从项目卡的 front matter 读元数据，从交付物小节读条目数。 */
export async function scanProjects({ rootDir = null } = {}) {
  const base = path.join(rootDir || root(), PROJECTS);
  let dirs = [];
  try {
    dirs = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const dir of dirs) {
    const cardPath = path.join(base, dir, CARD);
    const text = await readText(cardPath);
    if (!text) continue;
    const fm = frontMatter(text);
    let deliverables = [];
    try {
      deliverables = (await fs.readdir(path.join(base, dir, '交付'))).sort();
    } catch {
      deliverables = [];
    }
    out.push({
      name: fm.name || dir,
      dir,
      client: fm.client || '—',
      status: fm.status || '—',
      created: fm.created || '—',
      due: fm.due || '—',
      budget: fm.budget || '—',
      need: fm.need || '',
      deliverables,
      chars: text.length,
    });
  }
  return out;
}

export async function rebuildIndex({ rootDir = null } = {}) {
  const home = rootDir || root();
  const list = await scanProjects({ rootDir: home });
  const stamp = nowStamp();
  const count = (s) => list.filter((p) => p.status === s).length;

  const rows = list.length
    ? list.map(
        (p) =>
          `| [${esc(p.name)}](${encodeURI(p.dir)}/${encodeURI(CARD)}) | ${esc(p.client)} | ${esc(p.status)} | ${p.deliverables.length} | ${esc(p.due)} | ${esc(oneLine(p.need, 40))} |`,
      )
    : ['| （暂无） | — | — | 0 | — | 第一次建档：`node tools/project.mjs new --name ... --client ... --need "..."` |'];

  const body = [
    '# 项目台账索引',
    '',
    '> 本表由 `tools/project.mjs index` 自动重建，手改会被覆盖。',
    `> 最后重建：${stamp.date} ${stamp.time}　共 ${list.length} 个项目`,
    '',
    `**进行中 ${count('进行中')}　待验收 ${count('待验收')}　已交付 ${count('已交付')}　暂停 ${count('暂停')}**`,
    '',
    '| 项目 | 客户 | 状态 | 交付物 | 截止 | 需求 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## 状态机',
    '',
    '`意向 → 进行中 → 待验收 → 已交付`（`暂停` 可随时插入，恢复时回到暂停前的状态）',
    '',
    '- **待验收** = 东西做完了但客户还没确认。**不许跳过这一步直接标已交付**。',
    '- **已交付** = 客户确认过 + 交付物在本目录 `交付/` 里有实体文件或明确说明。',
    '',
    '## 为什么单开一层',
    '',
    '`memory/` 是 AI 的记忆（场景怎么干活），`projects/` 是业务的事实（给谁做了什么）。',
    '混在一起的后果：归档时误删场景记忆，或客户的交付物散落在场景目录里永远找不到。',
    '',
  ].join('\n');

  await ensureDir(path.join(home, PROJECTS));
  await fs.writeFile(path.join(home, PROJECTS, '索引.md'), body, 'utf8');
  return { ok: true, count: list.length, path: path.join(home, PROJECTS, '索引.md') };
}

export async function newProject({ name, client = '', need = '', due = '', budget = '', rootDir = null, force = false } = {}) {
  const home = rootDir || root();
  if (!name) return { ok: false, message: '必须给 --name' };
  if (!client) return { ok: false, message: '必须给 --client（不知道给谁做，就不该立项）' };
  if (!need) return { ok: false, message: '必须给 --need（需求原话优先，不要自己概括）' };

  const dir = path.join(home, PROJECTS, slug(name));
  const cardFile = path.join(dir, CARD);
  if ((await exists(cardFile)) && !force) {
    return { ok: false, message: `项目「${name}」已存在。要覆盖加 --force`, path: cardFile };
  }

  const stamp = nowStamp();
  await ensureDir(path.join(dir, '交付'));
  const card = [
    '---',
    `name: ${esc(name)}`,
    `client: ${esc(client)}`,
    `status: 意向`,
    `created: ${stamp.date}`,
    `due: ${esc(due) || '—'}`,
    `budget: ${esc(budget) || '—'}`,
    `need: ${esc(need)}`,
    '---',
    '',
    `# ${name}`,
    '',
    `**客户**：${esc(client)}　**立项**：${stamp.date}　**截止**：${esc(due) || '—'}　**预算**：${esc(budget) || '—'}`,
    '',
    '## 需求（原话）',
    '',
    `> ${esc(need)}`,
    '',
    '<!-- 需求变更一律追加在原话下方，不覆盖原话。原话是最初的锚点，改了就说不清"当初怎么谈的"。 -->',
    '',
    '## 交付物',
    '',
    '| 交付物 | 实体文件 | 交付时间 | 备注 |',
    '|---|---|---|---|',
    '| （暂无） | — | — | 用 `project.mjs deliver` 追加 |',
    '',
    '## 里程碑',
    '',
    '| 时间 | 事件 | 状态 |',
    '|---|---|---|',
    `| ${stamp.date} | 立项 | ✓ |`,
    '',
    '## 验收',
    '',
    '- 验收标准：（写清"什么算完成"，否则永远做不完）',
    '- 验收人：',
    '- 验收结论：**待验收**',
    '',
    '## 备注',
    '',
    '- ',
    '',
  ].join('\n');

  await fs.writeFile(cardFile, card, 'utf8');
  await rebuildIndex({ rootDir: home });
  await beat({ scene: 'projects', phase: 'idle', detail: `立项：${name}`, rootDir: home });
  return { ok: true, message: `已立项：${name}（状态=意向）→ ${path.relative(home, dir)}`, path: cardFile };
}

async function readCard(home, name) {
  const list = await scanProjects({ rootDir: home });
  const p = list.find((x) => x.name === name || x.dir === slug(name));
  if (!p) return null;
  const file = path.join(home, PROJECTS, p.dir, CARD);
  return { project: p, file, text: await readText(file) };
}

export async function setStatus({ name, status, note = '', rootDir = null } = {}) {
  const home = rootDir || root();
  const found = await readCard(home, name);
  if (!found) return { ok: false, message: `没有项目「${name}」` };
  if (!STATES.includes(status)) {
    return { ok: false, message: `状态必须是 ${STATES.join(' / ')} 之一` };
  }

  let text = found.text;
  text = text.replace(/^status: .*$/m, `status: ${status}`);
  const stamp = nowStamp();
  const milestone = `| ${stamp.date} | ${esc(note) || `状态改为${status}`} | ${status === '已交付' ? '✓' : '·'} |`;

  // 按行定位里程碑表体，插在表的最后一行之后。
  // 上一版用 `([\s\S]*?\n\|[^\n]*\|\n)((?:[^\n]*\n)*)` 做正则，结果是
  // 贪婪的 tail 一路吃到文件末尾，里程碑被追加到了「备注」之后——表格早就结束了还往里插。
  const lines = text.split('\n');
  const h = lines.findIndex((l) => l.trim() === '## 里程碑');
  if (h < 0) {
    text = `${text.replace(/\s+$/, '')}\n\n## 里程碑\n\n| 时间 | 事件 | 状态 |\n|---|---|---|\n${milestone}\n`;
  } else {
    let lastRow = -1;
    for (let i = h + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith('## ')) break;
      if (t.startsWith('|')) lastRow = i;
      else if (lastRow > 0 && t) break;
    }
    if (lastRow < 0) {
      // 有标题但没表体（被手工删空了）：补一个表头再插
      lines.splice(h + 1, 0, '', '| 时间 | 事件 | 状态 |', '|---|---|---|', milestone);
    } else {
      lines.splice(lastRow + 1, 0, milestone);
    }
    text = lines.join('\n');
  }

  await fs.writeFile(found.file, text, 'utf8');
  await rebuildIndex({ rootDir: home });
  return { ok: true, message: `「${name}」状态 → ${status}`, path: found.file };
}

export async function addDeliverable({ name, item, file = '', note = '', rootDir = null } = {}) {
  const home = rootDir || root();
  const found = await readCard(home, name);
  if (!found) return { ok: false, message: `没有项目「${name}」` };
  if (!item) return { ok: false, message: '必须给 --item（交付物叫什么）' };

  let stored = '—';
  if (file) {
    const src = path.resolve(file);
    const raw = await fs.readFile(src).catch(() => null);
    if (!raw) return { ok: false, message: `读不到文件：${src}` };
    const dstDir = path.join(home, PROJECTS, found.project.dir, '交付');
    await ensureDir(dstDir);
    const dst = path.join(dstDir, path.basename(src));
    await fs.writeFile(dst, raw);
    stored = `交付/${path.basename(src)}`;
  }

  const stamp = nowStamp();
  const row = `| ${esc(item)} | ${esc(stored)} | ${stamp.date} | ${esc(note) || '—'} |`;
  let text = found.text;
  if (text.includes('| （暂无） | — | — | 用 `project.mjs deliver` 追加 |')) {
    text = text.replace('| （暂无） | — | — | 用 `project.mjs deliver` 追加 |', row);
  } else {
    text = text.replace(/(\n## 里程碑)/, `\n${row}$1`);
  }
  await fs.writeFile(found.file, text, 'utf8');
  await rebuildIndex({ rootDir: home });
  return { ok: true, message: `已登记交付物：${item}（${stored}）`, path: found.file, stored };
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === 'help' || has(args, 'help')) {
    console.log(`项目台账（理解需求 → 交付归档）

  node tools/project.mjs new --name <项目> --client <客户> --need "需求原话" [--due 2026-12-01] [--budget 0]
  node tools/project.mjs list [--status 进行中] [--json]
  node tools/project.mjs show --name <项目>
  node tools/project.mjs status --name <项目> --set "${STATES.join('|')}" [--note "..."]
  node tools/project.mjs deliver --name <项目> --item "交付物名" [--file <路径>] [--note "..."]
  node tools/project.mjs index

状态机：意向 → 进行中 → 待验收 → 已交付（暂停可插入）`);
    return 0;
  }

  if (cmd === 'index') {
    const r = await rebuildIndex();
    console.log(`索引已重建：${r.count} 个项目 → ${r.path}`);
    return 0;
  }

  if (cmd === 'new') {
    const r = await newProject({
      name: flag(args, 'name'), client: flag(args, 'client'), need: flag(args, 'need'),
      due: flag(args, 'due'), budget: flag(args, 'budget'), force: has(args, 'force'),
    });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'list') {
    const status = flag(args, 'status');
    let list = await scanProjects();
    if (status) list = list.filter((p) => p.status === status);
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(list, null, 1)}\n`);
      return 0;
    }
    if (!list.length) {
      console.log('台账还是空的。立项：node tools/project.mjs new --name ... --client ... --need "..."');
      return 0;
    }
    console.log(`项目 ${list.length} 个：\n`);
    for (const p of list) {
      console.log(`· ${p.name}  [${p.status}]  客户=${p.client}  交付物=${p.deliverables.length}  截止=${p.due}`);
      if (p.need) console.log(`  ${oneLine(p.need, 88)}`);
    }
    return 0;
  }

  if (cmd === 'show') {
    const found = await readCard(root(), flag(args, 'name'));
    if (!found) {
      console.error(`没有项目「${flag(args, 'name')}」`);
      return 1;
    }
    console.log(found.text);
    return 0;
  }

  if (cmd === 'status') {
    const r = await setStatus({ name: flag(args, 'name'), status: flag(args, 'set'), note: flag(args, 'note') });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'deliver') {
    const r = await addDeliverable({ name: flag(args, 'name'), item: flag(args, 'item'), file: flag(args, 'file'), note: flag(args, 'note') });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  console.error(`未知命令：${cmd}。试试 node tools/project.mjs help`);
  return 1;
}

if (process.argv[1]?.endsWith('project.mjs')) {
  main().then((code) => process.exit(code));
}
