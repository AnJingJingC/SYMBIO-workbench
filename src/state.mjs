// SYMBIO 工作台 · 业务状态只读解析器
//
// 设计约束（来自五红线的「事实」条）：
//   · 所有数字都从 E:/SYMBIO 的真实文件解析出来，一处都不许猜；
//   · 任何文件读不到，只记录 issues 并给 null，绝不填兜底假值；
//   · 本模块只读，不写、不迁移、不复制任何业务数据。

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const LAYERS = [
  { key: '00-constitution', label: 'L0 宪法', desc: '不可修改的规则与红线' },
  { key: '10-shared', label: 'L1 共享', desc: '跨场景结论与任务看板' },
  { key: '20-scenes', label: 'L2 场景', desc: '每个场景一个项目' },
  { key: '30-personal', label: 'L3 个人', desc: '私人档案，不参与主线' },
  { key: '90-archive', label: 'L5 归档', desc: '只加不改' },
];

async function readText(root, rel, issues) {
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch (error) {
    // issues 传 null 表示"这个文件本来就可能不存在"（可选资产），不该污染缺项清单
    issues?.push({ path: rel, reason: error?.code ?? String(error?.message ?? '读取失败') });
    return null;
  }
}

/** 读扁平 front matter（只认顶部的 --- ... ---），不引 yaml 依赖。 */
function frontMatter(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/**
 * 读活动心跳（亮灯的唯一数据源）。
 * 过期即灭——不把"很久以前的活动"当成"还在干活"。
 */
export async function readHeartbeats(root, now = Date.now()) {
  const dir = 'memory/10-shared/心跳';
  let names = [];
  try {
    names = (await readdir(path.join(root, dir))).filter((n) => n.endsWith('.json'));
  } catch (error) {
    // 目录不存在 = 还没有任何活动，这是**正常状态**，不是故障（别在面板上喊"不可读"）
    if (error?.code === 'ENOENT') return { available: true, beats: [], active: [], stale: 0 };
    return { available: false, reason: error?.code ?? '心跳目录不可读', beats: [], active: [], stale: 0 };
  }

  const beats = [];
  let stale = 0;
  for (const name of names) {
    let rec = null;
    try {
      rec = JSON.parse(await readFile(path.join(root, dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!rec?.scene || !rec?.at) continue;
    const age = now - Date.parse(rec.at);
    const ttl = Number(rec.ttlMs) > 0 ? Number(rec.ttlMs) : 90_000;
    if (!Number.isFinite(age) || age > ttl) {
      stale += 1;
      continue;
    }
    beats.push({
      scene: rec.scene,
      phase: rec.phase ?? 'idle',
      phaseLabel: rec.phaseLabel ?? rec.phase ?? '',
      detail: rec.detail ?? '',
      at: rec.at,
      atLocal: rec.atLocal ?? '',
      ttlMs: ttl,
      ageMs: Math.max(0, age),
      remainMs: Math.max(0, ttl - age),
    });
  }
  beats.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { available: true, beats, active: beats.filter((b) => b.phase !== 'idle'), stale };
}

/** 共享技能层：哪些已提升、哪些已装配进 .dsh/skills。 */
async function readSharedSkills(root) {
  const dir = 'memory/10-shared/skills';
  let dirs = [];
  try {
    dirs = (await readdir(path.join(root, dir), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    return { available: false, reason: error?.code ?? '共享技能目录不可读', count: 0, installed: 0, items: [] };
  }

  const items = [];
  for (const name of dirs) {
    const text = await readText(root, `${dir}/${name}/SKILL.md`, null);
    if (!text) continue;
    const fm = frontMatter(text);
    const origin = await readText(root, `${dir}/${name}/ORIGIN.md`, null);
    const from = (origin ?? '').match(/- 来源场景：\s*(.+)/)?.[1]?.trim() ?? '';
    const installed = (await readText(root, `.dsh/skills/${name}/SKILL.md`, null)) !== null;
    items.push({
      name: fm.name || name,
      desc: fm.description ?? '',
      from,
      installed,
    });
  }
  return {
    available: true,
    count: items.length,
    installed: items.filter((i) => i.installed).length,
    items,
  };
}

/** 零件库：按分类计数 + 已验证数。 */
async function readParts(root) {
  const base = 'parts';
  const kinds = ['机制', '技能', '脚本', '待评估'];
  let top = [];
  try {
    top = await readdir(path.join(root, base), { withFileTypes: true });
  } catch (error) {
    return { available: false, reason: error?.code ?? '零件库目录不可读', count: 0, verified: 0, byKind: {}, items: [] };
  }

  const items = [];
  let verified = 0;
  const byKind = {};
  for (const kind of kinds) {
    const kdir = path.join(root, base, kind);
    let dirs = [];
    try {
      dirs = (await readdir(kdir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of dirs) {
      const text = await readText(root, `${base}/${kind}/${name}/PART.md`, null);
      if (!text) continue;
      const fm = frontMatter(text);
      const ok = String(fm.verified ?? '').toLowerCase() === 'true';
      if (ok) verified += 1;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      let payload = 0;
      try {
        payload = (await readdir(path.join(kdir, name, 'payload'))).length;
      } catch {
        payload = 0;
      }
      items.push({ name: fm.name || name, kind, verified: ok, risk: fm.risk ?? '', desc: fm.desc ?? '', payload });
    }
  }
  return { available: !!(top.length || items.length), count: items.length, verified, byKind, items };
}

/** 项目台账：状态分布 + 交付物计数。 */
async function readProjects(root) {
  const base = 'projects';
  let dirs = [];
  try {
    dirs = (await readdir(path.join(root, base), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    return { available: false, reason: error?.code ?? '项目目录不可读', count: 0, byStatus: {}, items: [] };
  }

  const items = [];
  const byStatus = {};
  for (const dir of dirs) {
    const text = await readText(root, `${base}/${dir}/项目卡.md`, null);
    if (!text) continue;
    const fm = frontMatter(text);
    const status = fm.status ?? '—';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    let deliverables = 0;
    try {
      deliverables = (await readdir(path.join(root, base, dir, '交付'))).length;
    } catch {
      deliverables = 0;
    }
    items.push({ name: fm.name || dir, client: fm.client ?? '', status, due: fm.due ?? '', deliverables });
  }
  return { available: true, count: items.length, byStatus, items };
}

async function readJson(root, rel, issues) {
  const text = await readText(root, rel, issues);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    issues.push({ path: rel, reason: `JSON 解析失败：${error?.message ?? ''}` });
    return null;
  }
}

/** 把 markdown 表格拆成单元格数组；跳过分隔行、表头与纯占位行。 */
function tableRows(md) {
  if (!md) return [];
  const out = [];
  for (const line of String(md).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    const cells = t.slice(1, -1).split('|').map((c) => c.trim());
    if (!cells.length) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // |---|---|
    if (/^(时间|文件|层|场景|来源|状态|标题)$/.test(cells[0])) continue; // 表头
    if (cells.every((c) => c === '' || c === '—' || c === '-' || /^（/.test(c))) continue; // 「（当前无…）」
    out.push(cells);
  }
  return out;
}

function section(md, heading) {
  if (!md) return '';
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`).test(l.trim()));
  if (start < 0) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

async function countTree(root, rel, issues) {
  const abs = path.join(root, rel);
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      issues.push({ path: path.relative(root, dir), reason: error?.code ?? '目录不可读' });
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files += 1;
        try {
          const s = await readFile(p);
          bytes += s.length;
        } catch {
          /* 单文件读失败只影响字节统计，已在别处记录 */
        }
      }
    }
  };
  await walk(abs);
  return { files, bytes };
}

async function readCards(root, issues) {
  const rel = 'memory/20-scenes/knowledge-digest/cards';
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    issues.push({ path: rel, reason: error?.code ?? '卡片目录不可读' });
    return { available: false, total: 0, items: [], indexChars: 0, indexGeneratedAt: null };
  }
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== '索引.md');
  const items = [];
  for (const f of files) {
    const text = await readText(root, `${rel}/${f.name}`, issues);
    const title = (text ?? '').split(/\r?\n/).find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || f.name;
    items.push({ file: f.name, title, chars: (text ?? '').length });
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  // 索引是**派生件**（index-build 生成的）：全新工作台"还没有索引"不是故障。
  // 这里传 null 表示可选资产，不污染缺项清单——否则刚初始化完的面板一开局就挂个红点，
  // 而用户什么都没做错，只是还没摄入过东西。
  // 但"已经有卡片却没有索引"是真缺：那时候 intake 本该顺手生成，没生成说明链路断了。
  const indexText = await readText(root, `${rel}/索引.md`, null);
  if (indexText === null && items.length > 0) {
    issues.push({ path: `${rel}/索引.md`, reason: 'ENOENT（有卡片但无索引，跑 node tools/index-build.mjs）' });
  }
  const generated = /生成于\s*([0-9-]+\s*[0-9:]+)/.exec(indexText ?? '')?.[1] ?? null;
  return {
    available: true,
    total: items.length,
    items,
    indexChars: (indexText ?? '').length,
    indexGeneratedAt: generated,
  };
}

async function readRedLines(root, issues) {
  const text = await readText(root, 'AGENTS.md', issues);
  if (text === null) return [];
  const out = [];
  const re = /^\d+\.\s+\*\*(.+?)\*\*\s*—\s*(.+)$/;
  for (const line of String(text).split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) {
      let summary = m[2].replace(/\s+/g, ' ').trim();
      if (summary.length > 84) summary = summary.slice(0, 84) + '…';
      out.push(`${m[1]}：${summary}`);
    }
    if (out.length >= 5) break;
  }
  return out;
}

function todayLocal() {
  // 工作台时区 Asia/Shanghai；用 sv-SE 得到稳定的 YYYY-MM-DD
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 读取业务状态。永远 resolve，不抛异常。
 * @param {string} root E:/SYMBIO 这类业务数据根目录
 */
// 内部 Worker：确定性落盘基础设施，不进面板「工具箱」（面板工具箱只列单输入框可点的工具）。
// route / shared-skill / parts / project 都是**多参数命令**，单输入框表达不了，
// 面板改为在「库」区块展示它们的只读摘要，操作走 CLI 或宿主 Agent 技能。
const INTERNAL_TOOLS = new Set([
  'intake.mjs', 'bus.mjs', 'autopilot.mjs', 'lint-weekly.mjs',
  'shared-skill.mjs', 'parts.mjs', 'project.mjs', 'route.mjs',
  // 维护类命令：单输入框的工具箱表达不了 --to/--write 这类选择，硬塞会变成看得见点不动。
  // sync-publish 尤其不能做成按钮——一键往另一个仓库拷 98 个文件，不该是误点能触发的操作
  'sync-publish.mjs',
  // 初始化：一键在工作台根下补建六个目录与出厂文件，且会覆盖判断"哪些是缺失的"。
  // 做成面板按钮等于让误点能造目录——面板没有任何位置需要它，CLI 才是它的正确形态
  'setup.mjs',
]);

export async function readState(root) {
  const issues = [];
  const checkedAt = new Date().toISOString();

  const config = await readJson(root, 'config/symbio.config.json', issues);
  const board = await readText(root, 'memory/10-shared/任务看板.md', issues);
  const handoff = await readText(root, 'memory/20-scenes/knowledge-digest/当前交接.md', issues);
  const redlines = await readText(root, 'memory/00-constitution/REDLINES.md', issues);
  const ledger = await readJson(root, 'memory/10-shared/花费台账.json', issues);

  // 看板两段：未闭环任务 / 冲突与待裁决，用二级标题切开再各自解析
  const splitAt = board ? board.indexOf('## 冲突与待裁决') : -1;
  const taskPart = splitAt >= 0 ? board.slice(0, splitAt) : (board ?? '');
  const conflictPart = splitAt >= 0 ? board.slice(splitAt) : '';
  const conflictRows = tableRows(conflictPart);
  const tasks = tableRows(taskPart).map((c) => ({
    time: c[0] ?? '', source: c[1] ?? '', goal: c[2] ?? '', task: c[3] ?? '', status: c[4] ?? '', receipt: c[5] ?? '',
  }));
  const conflicts = conflictRows.map((c) => ({ time: c[0] ?? '', matter: c[1] ?? '', scene: c[2] ?? '', decision: c[3] ?? '' }));

  const cards = await readCards(root, issues);
  const redLines = await readRedLines(root, issues);
  const [sharedSkills, parts, projects, activity] = await Promise.all([
    readSharedSkills(root),
    readParts(root),
    readProjects(root),
    readHeartbeats(root),
  ]);
  const layers = [];
  for (const layer of LAYERS) {
    layers.push({ ...layer, ...(await countTree(root, `memory/${layer.key}`, issues)) });
  }

  let skills = null;
  let skillStages = null;
  let tools = null;
  try {
    skills = (await readdir(path.join(root, '.dsh/skills'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    // 每个技能的阶段（A 通用核心 / B 场景 / C 按设计未启用）。
    // C 层的三件（画像 / 零件 / 演化）会改写宿主画像或联网抓外部东西，
    // 默认不碰——面板要能把「灰灯」说成「有意关着」而不是「缺件」。
    skillStages = {};
    for (const name of skills) {
      const text = await readText(root, `.dsh/skills/${name}/SKILL.md`, null);
      const stage = String(text ?? '').match(/^\s{2}stage:\s*["']?([A-Za-z])["']?\s*$/m)?.[1];
      if (stage) skillStages[name] = stage.toUpperCase();
    }
  } catch (error) {
    issues.push({ path: '.dsh/skills', reason: error?.code ?? '技能目录不可读' });
  }
  try {
    tools = (await readdir(path.join(root, 'tools'), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !INTERNAL_TOOLS.has(e.name))
      .map((e) => e.name.replace(/\.mjs$/, ''))
      .sort();
  } catch (error) {
    issues.push({ path: 'tools', reason: error?.code ?? '工具目录不可读' });
  }

  const day = todayLocal();
  const todayEntry = ledger?.days?.[day] ?? null;
  // 台账的字段名一直是 spendCNY（tools/spend-guard.mjs 写的），
  // 这里原来只认 totalCNY / spentCNY，导致真记账后面板仍显示 0.00。
  // 保留别名兼容旧台账，但以实际写入方为准。
  const todaySpend =
    typeof todayEntry === 'number'
      ? todayEntry
      : (todayEntry?.spendCNY ?? todayEntry?.totalCNY ?? todayEntry?.spentCNY ?? null);
  // 免费桥的调用次数：钱是 0，但"跑过没跑过"是要看得见的，
  // 否则面板上「今日花费 0.00」和「一次没干」长得一模一样。
  const todayFree = todayEntry?.free && typeof todayEntry.free === 'object'
    ? { calls: Number(todayEntry.free.calls || 0), failed: Number(todayEntry.free.failed || 0) }
    : null;

  const coreOk = !!config && board !== null && handoff !== null && cards.available;

  return {
    ok: coreOk,
    root,
    checkedAt,
    issues,
    config: config
      ? {
          stage: config.stage?.current ?? null,
          modules: config.stage?.modules ?? null,
          cardMaxChars: config.limits?.cardMaxChars ?? null,
          sceneMemoryMaxKB: config.limits?.sceneMemoryMaxKB ?? null,
          dailyBudgetCNY: config.cost?.dailyBudgetCNY ?? null,
          defaultScene: config.paths?.defaultScene ?? null,
          egressAllowlist: config.privacy?.egressAllowlist ?? null,
        }
      : null,
    queue: { tasks, conflicts },
    cards,
    memory: {
      layers,
      totalFiles: layers.reduce((n, l) => n + l.files, 0),
      totalBytes: layers.reduce((n, l) => n + l.bytes, 0),
    },
    handoff: handoff
      ? {
          status: section(handoff, '当前状态'),
          next: section(handoff, '下一步'),
          unresolved: section(handoff, '未决问题'),
          chars: handoff.length,
        }
      : null,
    ledger: ledger
      ? { currency: ledger.currency ?? 'CNY', day, todaySpend, todayFree, daysCount: Object.keys(ledger.days ?? {}).length }
      : null,
    privacyDoc: redlines ? { loaded: true, chars: redlines.length, excerpt: redlines.slice(0, 360) } : { loaded: false, chars: 0, excerpt: '' },
    redLines,
    // 新增三层「库」+ 亮灯信号。全部来自真实文件，读不到就 available:false，不填假数。
    libraries: { sharedSkills, parts, projects },
    activity: {
      available: activity.available,
      reason: activity.reason ?? null,
      active: activity.active,
      count: activity.beats.length,
      stale: activity.stale,
    },
    assets: { skills, tools, skillStages },
  };
}
