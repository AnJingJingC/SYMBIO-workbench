// tools/parts.mjs —— 零件库：按需取一块，不装一整个面板
//
// 作者原话（十期视频）：「不要完全用我的开源，按我的思路建立属于你的」+「一切皆零件」。
// 缺口的实质不是"没有集市"，而是：mydsh 是**在线索引**，检索要联网、收录要等 48 小时、
// 而且只能整包看。真正该有的是一个**离线、可检索、可装配**的本机小库。
//
// 目录（零件 = 一个目录，PART.md 是卡片，实体在 canonical 指向的地方）：
//   parts/机制/<名>/PART.md                   纯方法论，无可执行文件
//   parts/技能/<名>/PART.md                   实体在 memory/10-shared/skills/<名>/SKILL.md
//   parts/脚本/<名>/PART.md                   实体在 tools/<x>.mjs
//   parts/待评估/<名>/PART.md                 想装但没验证过的，先扔这（verified: false）
//   parts/技能/<名>/payload/<x>               仅当实体来自仓外、仓内没有正本时才复制一份
//
// 为什么不存副本：副本一定会和正本漂移（本项目的阶段报告、SKILL.md 都吃过这个亏——
// 改一处漏另一处，而且漏的那处没人会去查）。所以 add --file 指到仓内文件时**只记指针**，
// pull 直接从正本读。只有仓外来的东西才真的复制进 payload/。
//
// 用法：
//   node tools/parts.mjs index                              重建索引
//   node tools/parts.mjs list [--kind 脚本] [--json]
//   node tools/parts.mjs search <关键词>                     离线检索（名字/标签/正文）
//   node tools/parts.mjs show <名>
//   node tools/parts.mjs add --name <名> --kind 脚本 --source "<来源>" \
//        [--desc "一句话"] [--tags a,b] [--risk 低] [--file <源文件路径>] [--verified]
//   node tools/parts.mjs pull --name <名> [--to <目标路径>] [--force]   把 payload 装配出去
//
// 硬规矩：verified:false 的零件**不许直接装配**（必须先真机验证再标 verified）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { root, flag, has, esc, slug, nowStamp, ensureDir, exists, readText, frontMatter } from './lib/common.mjs';

const PARTS = 'parts';
const KINDS = ['机制', '技能', '脚本', '待评估'];

const args = process.argv.slice(2);
const cmd = args[0];

function partsDir(rootDir) {
  return path.join(rootDir || root(), PARTS);
}

function oneLine(s, max = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 扫全部零件：返回 [{name, kind, dir, card}] */
export async function scanParts({ rootDir = null } = {}) {
  const base = partsDir(rootDir);
  const out = [];
  for (const kind of KINDS) {
    const kdir = path.join(base, kind);
    let dirs = [];
    try {
      dirs = (await fs.readdir(kdir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      continue;
    }
    for (const name of dirs) {
      const dir = path.join(kdir, name);
      const text = await readText(path.join(dir, 'PART.md'));
      if (!text) continue;
      const fm = frontMatter(text);
      let payload = [];
      try {
        payload = (await fs.readdir(path.join(dir, 'payload'))).sort();
      } catch {
        payload = [];
      }
      out.push({
        name: fm.name || name,
        kind: fm.kind || kind,
        dir,
        relDir: path.relative(base, dir).replace(/\\/g, '/'),
        desc: fm.desc || fm.description || '',
        source: fm.source || '',
        license: fm.license || '',
        risk: fm.risk || '—',
        deps: fm.deps || '—',
        tags: String(fm.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        verified: String(fm.verified || '').toLowerCase() === 'true',
        // complete=false 表示卡片只有骨架、没有实质说明。检索到了也读不到东西，必须显性标出来
        complete: String(fm.complete || '').toLowerCase() !== 'false',
        assemble: fm.assemble || '',
        canonical: fm.canonical || '',
        payload,
        chars: text.length,
      });
    }
  }
  return out;
}

/** 重建 parts/索引.md（幂等）。 */
export async function rebuildIndex({ rootDir = null } = {}) {
  const home = rootDir || root();
  const list = await scanParts({ rootDir: home });
  const stamp = nowStamp();

  const byKind = new Map(KINDS.map((k) => [k, []]));
  for (const p of list) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p);
  }

  const sections = [];
  for (const [kind, items] of byKind) {
    sections.push(`## ${kind}（${items.length}）`, '');
    if (!items.length) {
      sections.push('_（空）_', '');
      continue;
    }
    sections.push('| 零件 | 一句话 | 来源 | 风险 | 状态 |');
    sections.push('|---|---|---|---|---|');
    for (const p of items) {
      const state = p.verified ? '已验证' : '**未验证**';
      const mark = p.complete ? state : `${state} · **卡片未补全**`;
      sections.push(`| [${esc(p.name)}](${encodeURI(p.relDir)}/PART.md) | ${esc(oneLine(p.desc, 44))} | ${esc(p.source || '—')} | ${esc(p.risk)} | ${mark} |`);
    }
    sections.push('');
  }

  const body = [
    '# 零件库索引',
    '',
    '> 本表由 `tools/parts.mjs index` 自动重建，手改会被覆盖。',
    `> 最后重建：${stamp.date} ${stamp.time}　共 ${list.length} 个零件（已验证 ${list.filter((p) => p.verified).length}）`,
    '',
    '**为什么要本机零件库**：在线集市只能"整包看、联网查、等审核"；零件库是离线、可检索、可装配——',
    '装的是一块能力，不是一个面板。装多了不用反而烧 token（作者原话）。',
    '',
    ...sections,
    '## 三条纪律',
    '',
    '1. **未验证不许装配**：`verified: false` 的零件只能看，`pull` 会被拒绝。',
    '2. **装配前先体检**：装完跑 `node tools/memory-lint.mjs`（对应 `symbio-part` 技能要求）。',
    '3. **零件靠"拆"长出来**：每消化一个外部东西，就往这里收一块，不要一次买齐。',
    '4. **本库不存副本**：卡片的 `canonical` 指正本，`pull` 直接从正本拷。仓内已有正本的绝不复制——',
    '   副本一定漂移，改一处漏另一处，而且漏的那处没人会去查。',
    '',
  ].join('\n');

  await ensureDir(path.join(home, PARTS));
  await fs.writeFile(path.join(home, PARTS, '索引.md'), body, 'utf8');
  return { ok: true, count: list.length, verified: list.filter((p) => p.verified).length, path: path.join(home, PARTS, '索引.md') };
}

/** 收录一个零件。 */
/**
 * 收录一个零件。
 * abilities / why / limits 不是可选装饰：上一版只生成骨架，6 张卡片全是
 * "（列 2–4 条具体能力）"这种占位符——**收录≠有用**，检索到了也读不到东西。
 * 现在要求至少给 --abilities 与 --limits，否则卡片会被标记为「未补全」。
 */
export async function addPart({
  name, kind = '脚本', source = '', desc = '', tags = '', risk = '低', deps = '', assemble = '', file = '', license = '',
  abilities = '', why = '', limits = '', verified = false, verifiedNote = '', force = false, rootDir = null,
} = {}) {
  const home = rootDir || root();
  if (!name) return { ok: false, message: '必须给 --name' };
  const k = KINDS.includes(kind) ? kind : '脚本';
  const dir = path.join(home, PARTS, k, slug(name));
  const cardFile = path.join(dir, 'PART.md');

  if ((await exists(cardFile)) && !force) {
    return { ok: false, message: `零件「${name}」已存在（${path.relative(home, dir)}）。要覆盖加 --force`, path: cardFile };
  }

  const stamp = nowStamp();
  await ensureDir(dir);

  let payloadNote = '（无实体文件：纯方法论/纯说明）';
  let canonical = '';
  if (file) {
    const src = path.resolve(file);
    const raw = await fs.readFile(src).catch(() => null);
    if (!raw) return { ok: false, message: `读不到源文件：${src}` };

    // 仓内已有正本 → 只记指针，不复制（副本必然漂移）
    const rel = path.relative(home, src).replace(/\\/g, '/');
    const insideRepo = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (insideRepo) {
      canonical = rel;
      payloadNote = `${rel}（正本在仓内，本库不存副本；改内容改正本）`;
    } else {
      await ensureDir(path.join(dir, 'payload'));
      const target = path.join(dir, 'payload', path.basename(src));
      await fs.writeFile(target, raw);
      canonical = `payload/${path.basename(src)}`;
      payloadNote = `payload/${path.basename(src)}（来源在仓外，故留一份副本）`;
    }
  }

  const bullet = (raw, fallback) => {
    const items = String(raw ?? '').split('|').map((s) => s.trim()).filter(Boolean);
    return items.length ? items.map((s) => `- ${s}`).join('\n') : `- ${fallback}`;
  };

  const card = [
    '---',
    `name: ${slug(name)}`,
    `kind: ${k}`,
    `desc: ${esc(desc) || '（待补一句话）'}`,
    `source: ${esc(source) || '（未填来源）'}`,
    `license: ${esc(license) || '（未填，装配前必须确认）'}`,
    `risk: ${esc(risk)}`,
    `deps: ${esc(deps || '无')}`,
    `tags: ${String(tags || '').split(/[,，]/).map((t) => esc(t)).filter(Boolean).join(',')}`,
    `verified: ${verified ? 'true' : 'false'}`,
    `complete: ${abilities && limits ? 'true' : 'false'}`,
    `canonical: ${canonical || '（无）'}`,
    `assemble: ${esc(assemble) || '（待补装配方式）'}`,
    `added: ${stamp.date}`,
    '---',
    '',
    `# ${name}`,
    '',
    desc ? `> ${desc}` : '> （补一句话：这块零件解决什么问题）',
    '',
    '## 能干什么',
    '',
    bullet(abilities, '（未填：列 2–4 条**具体**能力，不要写"很强大"这类形容词）'),
    '',
    '## 为什么值得装',
    '',
    why ? why.split('|').map((s) => `- ${s.trim()}`).filter((s) => s !== '- ').join('\n') : '- （未填：不装它的代价是什么）',
    '',
    '## 装配方式',
    '',
    assemble ? `\`\`\`\n${assemble}\n\`\`\`` : '```\n（写清：复制到哪 / 跑什么命令 / 装完怎么验证）\n```',
    '',
    `实体文件：${payloadNote}`,
    '',
    '## 风险与边界',
    '',
    `- 风险等级：${risk}`,
    `- 依赖：${deps || '无'}`,
    limits ? limits.split('|').map((s) => `- 边界：${s.trim()}`).filter((s) => s !== '- 边界：').join('\n') : '- 边界：（未填：写清它做不到什么，避免下次误用）',
    '',
    '## 验证记录',
    '',
    verified
      ? `- ${stamp.date} ${esc(verifiedNote) || '已在本机真跑通过（tools/parts.mjs 收录）'}`
      : '- **未验证**：只是收录待评估，`pull` 会被拒绝',
    '',
  ].join('\n');

  await fs.writeFile(cardFile, card, 'utf8');
  await rebuildIndex({ rootDir: home });
  const complete = !!(abilities && limits);
  return {
    ok: true,
    message: `已收录零件：${name} → ${path.relative(home, dir)}` + (complete ? '' : '（⚠ 缺 --abilities/--limits，卡片会被标为未补全）'),
    path: cardFile,
    verified,
    complete,
  };
}

/** 检索：名字命中 > 标签命中 > 正文命中。 */
export async function searchParts(keyword, { rootDir = null } = {}) {
  const home = rootDir || root();
  const list = await scanParts({ rootDir: home });
  const q = String(keyword ?? '').toLowerCase().trim();
  if (!q) return [];

  const scored = [];
  for (const p of list) {
    let score = 0;
    const where = [];
    if (p.name.toLowerCase().includes(q)) {
      score += 10;
      where.push('名称');
    }
    if (p.tags.some((t) => t.toLowerCase().includes(q))) {
      score += 6;
      where.push('标签');
    }
    if (p.desc.toLowerCase().includes(q)) {
      score += 4;
      where.push('简介');
    }
    const body = await readText(path.join(p.dir, 'PART.md'));
    if (body && body.toLowerCase().includes(q)) {
      score += 2;
      where.push('正文');
    }
    if (score > 0) scored.push({ ...p, score, where });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

/** 装配：把实体文件复制出去。未验证的一律拒绝。 */
export async function pullPart({ name, to = '', force = false, rootDir = null } = {}) {
  const home = rootDir || root();
  const list = await scanParts({ rootDir: home });
  const part = list.find((p) => p.name === name || path.basename(p.dir) === name);
  if (!part) return { ok: false, message: `零件库里没有「${name}」` };
  if (!part.verified && !force) {
    return {
      ok: false,
      message: `「${name}」标记为未验证（verified:false），已拒绝装配。先在本机真跑验证，再把 PART.md 里的 verified 改成 true`,
    };
  }

  // 实体来源：canonical 优先（仓内正本），否则退回 payload/
  const rel = part.canonical && !part.canonical.startsWith('（') ? part.canonical : '';
  const srcs = rel
    ? [{ src: path.resolve(home, rel), base: path.basename(rel) }]
    : part.payload.map((f) => ({ src: path.join(part.dir, 'payload', f), base: f }));

  if (!srcs.length) {
    return { ok: false, message: `「${name}」没有实体文件（纯方法论），请直接读 ${part.relDir}/PART.md 按说明手工装配` };
  }
  if (!(await exists(srcs[0].src))) {
    return { ok: false, message: `「${name}」正本找不到：${srcs[0].src}。卡片里的 canonical 可能写错了` };
  }

  const targetDir = to ? path.resolve(to) : path.join(home, 'parts', '.assembled', slug(name));
  await ensureDir(targetDir);
  const copied = [];
  for (const { src, base } of srcs) {
    const dst = path.join(targetDir, base);
    if ((await exists(dst)) && !force) {
      return { ok: false, message: `目标已存在：${dst}。要覆盖加 --force`, copied };
    }
    await fs.copyFile(src, dst);
    copied.push(dst);
  }
  return { ok: true, message: `已装配 ${copied.length} 个文件到 ${targetDir}`, copied, targetDir };
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === 'help' || has(args, 'help')) {
    console.log(`零件库（按需取一块，不装一整个面板）

  node tools/parts.mjs index                       重建索引
  node tools/parts.mjs list [--kind 脚本] [--json]
  node tools/parts.mjs search <关键词>
  node tools/parts.mjs show <名>
  node tools/parts.mjs add --name <名> --kind 脚本|技能|机制|待评估 --source "<来源>" \\
       [--license MIT] [--desc "一句话"] [--tags a,b] [--risk 低] [--file <源文件>] \\
       --abilities "能力1|能力2|能力3" --why "不装它的代价" --limits "做不到什么" \\
       [--verified --verified-note "怎么验的 / 验到哪一步"]
  node tools/parts.mjs pull --name <名> [--to <目录>] [--force]

纪律：verified:false 的零件不许装配（先真机验证）。缺 abilities/limits 的卡片会被标为「未补全」——
收录不等于有用，检索到了却读不到东西，比没收录更浪费时间。
本库不存副本：canonical 指正本，pull 从正本拷；仓内已有正本的绝不复制（副本一定漂移）。`);
    return 0;
  }

  if (cmd === 'index') {
    const r = await rebuildIndex();
    console.log(`索引已重建：${r.count} 个零件（已验证 ${r.verified}）→ ${r.path}`);
    return 0;
  }

  if (cmd === 'list') {
    const kind = flag(args, 'kind');
    let list = await scanParts();
    if (kind) list = list.filter((p) => p.kind === kind);
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(list.map(({ dir, ...rest }) => rest), null, 1)}\n`);
      return 0;
    }
    if (!list.length) {
      console.log('零件库还是空的。每消化一个外部东西就往这里收一块：node tools/parts.mjs add --name ...');
      return 0;
    }
    console.log(`零件 ${list.length} 个：\n`);
    for (const p of list) {
      console.log(`· ${p.name}  [${p.kind}] ${p.verified ? '已验证' : '未验证'}${p.complete ? '' : '  ⚠卡片未补全'}  风险=${p.risk}`);
      if (p.desc) console.log(`  ${oneLine(p.desc, 88)}`);
    }
    return 0;
  }

  if (cmd === 'search') {
    const kw = args[1];
    if (!kw) {
      console.error('用法：node tools/parts.mjs search <关键词>');
      return 1;
    }
    const hits = await searchParts(kw);
    if (!hits.length) {
      console.log(`没找到含「${kw}」的零件。可以先把候选收进待评估：node tools/parts.mjs add --kind 待评估 --name ...`);
      return 0;
    }
    console.log(`命中 ${hits.length} 个：\n`);
    for (const h of hits) {
      console.log(`· ${h.name}  [${h.kind}] ${h.verified ? '已验证' : '未验证'}  （命中：${h.where.join('/')}）`);
      if (h.desc) console.log(`  ${oneLine(h.desc, 88)}`);
    }
    return 0;
  }

  if (cmd === 'show') {
    const name = args[1];
    if (!name) {
      console.error('用法：node tools/parts.mjs show <名>');
      return 1;
    }
    const list = await scanParts();
    const p = list.find((x) => x.name === name || path.basename(x.dir) === name);
    if (!p) {
      console.error(`没有零件「${name}」`);
      return 1;
    }
    const card = await readText(path.join(p.dir, 'PART.md'));
    console.log(card ?? '（卡片读不到）');
    return 0;
  }

  if (cmd === 'add') {
    const r = await addPart({
      name: flag(args, 'name'),
      kind: flag(args, 'kind') || '脚本',
      source: flag(args, 'source'),
      desc: flag(args, 'desc'),
      tags: flag(args, 'tags'),
      risk: flag(args, 'risk') || '低',
      deps: flag(args, 'deps'),
      assemble: flag(args, 'assemble'),
      abilities: flag(args, 'abilities'),
      why: flag(args, 'why'),
      limits: flag(args, 'limits'),
      file: flag(args, 'file'),
      license: flag(args, 'license'),
      verified: has(args, 'verified'),
      verifiedNote: flag(args, 'verified-note'),
      force: has(args, 'force'),
    });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'pull') {
    const r = await pullPart({ name: flag(args, 'name'), to: flag(args, 'to'), force: has(args, 'force') });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  console.error(`未知命令：${cmd}。试试 node tools/parts.mjs help`);
  return 1;
}

if (process.argv[1]?.endsWith('parts.mjs')) {
  main().then((code) => process.exit(code));
}
