// tools/shared-skill.mjs —— 共享技能层：一处学会，全员可用
//
// 作者机制原话（十期视频）：某个场景学会了什么，就写进**共享技能**，之后所有场景都能用。
// 我们原来的缺口很具体：技能只存在于 `.dsh/skills`（全局目录），于是「场景私有经验」
// 和「全系统能力」之间没有中间态——要么某个场景自己憋着（下次会话就没了），
// 要么直接进全局目录（还没验证成熟就污染所有场景）。
//
// 本工具补的就是这一环，三段式：
//   ① 场景私有   memory/20-scenes/<scene>/skills/<skill>/SKILL.md   —— 实验田，允许不成熟
//   ② 共享层     memory/10-shared/skills/<skill>/SKILL.md (+ ORIGIN.md) —— 已验证、登记来源
//   ③ 装配层     .dsh/skills/<skill>/SKILL.md                       —— DSH 真正加载的位置
//
// 为什么必须有第 ③ 步：DSH 只认 `.dsh/skills`。往共享层写文件不会让宿主多出一个技能，
// 必须显式 pull 装配。**不做假的"已共享"**——没装配就是没装配，索引里那一列会如实显示。
//
// 用法：
//   node tools/shared-skill.mjs list [--json]
//   node tools/shared-skill.mjs learn [--json]        # 场景私有但未进共享层的（候选）
//   node tools/shared-skill.mjs promote --skill <name> --from <scene> [--note "为什么值得共享"] [--force]
//   node tools/shared-skill.mjs pull --skill <name> [--force]     # 共享层 → .dsh/skills
//
// 防覆盖是硬规矩：目标已存在且内容不同 → 拒绝，必须显式 --force。

import fs from 'node:fs/promises';
import path from 'node:path';
import { root, flag, has, esc, nowStamp, ensureDir, exists, readText, sameText, frontMatter } from './lib/common.mjs';
import { beat } from './lib/heartbeat.mjs';

const SHARED = 'memory/10-shared/skills';
const INDEX = `${SHARED}/索引.md`;
const GLOBAL = '.dsh/skills';
const SCENES = 'memory/20-scenes';

const args = process.argv.slice(2);
const cmd = args[0];

function oneLine(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function skillSummary(skillDir) {
  const text = await readText(path.join(skillDir, 'SKILL.md'));
  if (!text) return null;
  const fm = frontMatter(text);
  return {
    name: fm.name || path.basename(skillDir),
    description: fm.description || '',
    stage: fm.metadata?.stage || '',
    chars: text.length,
    text,
  };
}

/** 共享层全部技能：名字 → 元信息（含是否已装配到 .dsh/skills）。 */
export async function listShared({ rootDir = null } = {}) {
  const home = rootDir || root();
  const dir = path.join(home, SHARED);
  let names = [];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    const sDir = path.join(dir, name);
    const info = await skillSummary(sDir);
    if (!info) continue;
    const originText = await readText(path.join(sDir, 'ORIGIN.md'));
    const from = (originText ?? '').match(/- 来源场景：\s*(.+)/)?.[1]?.trim() ?? '';
    const at = (originText ?? '').match(/- 提升时间：\s*(.+)/)?.[1]?.trim() ?? '';
    const globalFile = path.join(home, GLOBAL, name, 'SKILL.md');
    const globalText = await readText(globalFile);
    const installed = globalText !== null;
    const inSync = installed ? sameText(globalText, info.text) : false;
    out.push({
      name,
      description: info.description,
      stage: info.stage,
      chars: info.chars,
      from,
      promotedAt: at,
      installed,
      inSync,
      state: !installed ? '未装配' : inSync ? '已装配' : '装配后已改',
    });
  }
  return out;
}

/** 场景私有技能里，还没进共享层的——这就是"该扩散但没扩散"的清单。 */
export async function listLocalOnly({ rootDir = null } = {}) {
  const home = rootDir || root();
  const shared = new Set((await listShared({ rootDir: home })).map((s) => s.name));
  const out = [];
  let scenes = [];
  try {
    scenes = (await fs.readdir(path.join(home, SCENES), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const scene of scenes) {
    const sdir = path.join(home, SCENES, scene, 'skills');
    let dirs = [];
    try {
      dirs = (await fs.readdir(sdir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of dirs) {
      const info = await skillSummary(path.join(sdir, name));
      if (!info) continue;
      if (shared.has(name)) continue;
      out.push({ name, scene, description: info.description, chars: info.chars });
    }
  }
  return out;
}

/**
 * 把场景私有技能提升到共享层。
 * @returns {Promise<{ok:boolean, action:string, message:string, path?:string}>}
 */
export async function promoteSkill({ skill, from, note = '', force = false, rootDir = null } = {}) {
  const home = rootDir || root();
  if (!skill) return { ok: false, action: 'noop', message: '必须给 --skill' };
  if (!from) return { ok: false, action: 'noop', message: '必须给 --from <场景名>（来源必须可追溯，不许匿名共享）' };

  // 源头优先级：场景私有 → 全局目录（全局的也允许登记，方便其他场景知道它的来历）
  const candidates = [
    { kind: 'scene', file: path.join(home, SCENES, from, 'skills', skill, 'SKILL.md') },
    { kind: 'global', file: path.join(home, GLOBAL, skill, 'SKILL.md') },
  ];
  let source = null;
  for (const c of candidates) {
    const text = await readText(c.file);
    if (text) {
      source = { ...c, text };
      break;
    }
  }
  if (!source) {
    return {
      ok: false,
      action: 'noop',
      message: `找不到技能「${skill}」：既没有 ${SCENES}/${from}/skills/${skill}/SKILL.md，也没有 ${GLOBAL}/${skill}/SKILL.md`,
    };
  }

  const targetDir = path.join(home, SHARED, skill);
  const targetFile = path.join(targetDir, 'SKILL.md');
  const existing = await readText(targetFile);
  if (existing !== null && !sameText(existing, source.text) && !force) {
    return {
      ok: false,
      action: 'refused',
      message: `共享层已有同名技能「${skill}」且内容不同，已拒绝覆盖（防误删已验证版本）。确认要替换请加 --force`,
      path: targetFile,
    };
  }

  const stamp = nowStamp();
  await ensureDir(targetDir);
  await fs.writeFile(targetFile, source.text, 'utf8');
  await fs.writeFile(
    path.join(targetDir, 'ORIGIN.md'),
    [
      `# ${skill} · 来源登记`,
      '',
      `- 来源场景：${from}`,
      `- 来源类型：${source.kind === 'scene' ? '场景私有技能' : '全局技能（登记来历）'}`,
      `- 原始路径：${path.relative(home, source.file).replace(/\\/g, '/')}`,
      `- 提升时间：${stamp.date} ${stamp.time}`,
      `- 为什么共享：${esc(note) || '（未填，建议补一句：它解决了什么问题）'}`,
      '',
      '> 本文件由 tools/shared-skill.mjs 生成。共享层是「已验证、可复用」的中间层，',
      '> 装进 DSH 需要再执行 `node tools/shared-skill.mjs pull --skill ' + skill + '`。',
      '',
    ].join('\n'),
    'utf8',
  );

  await rebuildIndex({ rootDir: home });
  await beat({ scene: from, phase: 'idle', detail: `共享技能：${skill}`, rootDir: home });
  return {
    ok: true,
    action: existing === null ? 'created' : 'updated',
    message: existing === null ? `已提升到共享层：${skill}` : `已更新共享层：${skill}`,
    path: targetFile,
  };
}

/** 把共享层技能装配进 .dsh/skills（这一步才让 DSH 真的多一个技能）。 */
export async function pullSkill({ skill, force = false, rootDir = null } = {}) {
  const home = rootDir || root();
  if (!skill) return { ok: false, action: 'noop', message: '必须给 --skill' };
  const src = await readText(path.join(home, SHARED, skill, 'SKILL.md'));
  if (!src) return { ok: false, action: 'noop', message: `共享层没有「${skill}」，先 promote 再 pull` };

  const targetFile = path.join(home, GLOBAL, skill, 'SKILL.md');
  const existing = await readText(targetFile);
  if (existing !== null && !sameText(existing, src) && !force) {
    return {
      ok: false,
      action: 'refused',
      message: `.dsh/skills/${skill}/SKILL.md 已存在且与共享层不同，已拒绝覆盖（防覆盖宿主正在用的技能）。确认要替换请加 --force`,
      path: targetFile,
    };
  }
  if (existing !== null && sameText(existing, src)) {
    return { ok: true, action: 'unchanged', message: `已是最新：${skill}`, path: targetFile };
  }

  await ensureDir(path.dirname(targetFile));
  await fs.writeFile(targetFile, src, 'utf8');
  await rebuildIndex({ rootDir: home });
  return { ok: true, action: 'installed', message: `已装配到 .dsh/skills：${skill}`, path: targetFile };
}

/** 重建共享技能索引（幂等，可反复调）。 */
export async function rebuildIndex({ rootDir = null } = {}) {
  const home = rootDir || root();
  const list = await listShared({ rootDir: home });
  const stamp = nowStamp();
  const rows = list.length
    ? list.map(
        (s) =>
          `| ${esc(s.name)} | ${esc(oneLine(s.description, 50))} | ${esc(s.from || '—')} | ${esc(s.promotedAt || '—')} | ${esc(s.state)} |`,
      )
    : ['| （暂无） | 场景里学会技能后，用 `shared-skill.mjs promote` 提升到这里 | — | — | — |'];

  const body = [
    '# 共享技能索引',
    '',
    '> **一处学会，全员可用。** 本表由 `tools/shared-skill.mjs` 自动重建，手改会被覆盖。',
    '',
    `最后重建：${stamp.date} ${stamp.time}`,
    '',
    '| 技能 | 一句话 | 来源场景 | 提升时间 | 装配状态 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## 三条使用纪律',
    '',
    '1. **先私有后共享**：场景里先跑通（`memory/20-scenes/<scene>/skills/`），验证过再 `promote`。',
    '2. **共享 ≠ 生效**：DSH 只加载 `.dsh/skills`，共享层必须 `pull` 才真正多一个技能。',
    '3. **装配状态会显示"装配后已改"**：那说明有人直接改了 `.dsh/skills` 里的文件，共享层没跟上。',
    '   要么把改动 `promote --force` 回收，要么 `pull --force` 覆盖——**别让两处长期不一致**。',
    '',
  ].join('\n');

  await ensureDir(path.join(home, SHARED));
  await fs.writeFile(path.join(home, INDEX), body, 'utf8');
  return { ok: true, count: list.length, path: path.join(home, INDEX) };
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === 'help' || has(args, 'help')) {
    console.log(`共享技能层（一处学会，全员可用）

  node tools/shared-skill.mjs list [--json]
  node tools/shared-skill.mjs learn [--json]                 场景私有但未共享的候选
  node tools/shared-skill.mjs promote --skill <名> --from <场景> [--note "..."] [--force]
  node tools/shared-skill.mjs pull --skill <名> [--force]     装配进 .dsh/skills（DSH 才加载）
  node tools/shared-skill.mjs rebuild                         只重建索引

目录：${SHARED}/<技能>/SKILL.md + ORIGIN.md → pull 后进 ${GLOBAL}/<技能>/SKILL.md`);
    return 0;
  }

  if (cmd === 'rebuild') {
    const r = await rebuildIndex();
    console.log(`索引已重建：${r.count} 个共享技能 → ${r.path}`);
    return 0;
  }

  if (cmd === 'list') {
    const list = await listShared();
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(list, null, 1)}\n`);
      return 0;
    }
    if (!list.length) {
      console.log('共享层还是空的。\n把场景里跑通的技能提升上来：node tools/shared-skill.mjs promote --skill <名> --from <场景>');
      return 0;
    }
    console.log(`共享技能 ${list.length} 个：\n`);
    for (const s of list) {
      console.log(`· ${s.name}  [${s.state}]  来源=${s.from || '—'}`);
      if (s.description) console.log(`  ${oneLine(s.description, 90)}`);
    }
    return 0;
  }

  if (cmd === 'learn') {
    const list = await listLocalOnly();
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(list, null, 1)}\n`);
      return 0;
    }
    if (!list.length) {
      console.log('没有待扩散的场景私有技能。（场景私有技能放在 memory/20-scenes/<场景>/skills/<技能>/SKILL.md）');
      return 0;
    }
    console.log(`发现 ${list.length} 个"场景会了但没共享"的技能：\n`);
    for (const s of list) {
      console.log(`· ${s.name}（来自 ${s.scene}）`);
      console.log(`  提升：node tools/shared-skill.mjs promote --skill ${s.name} --from ${s.scene} --note "解决了什么问题"`);
    }
    return 0;
  }

  if (cmd === 'promote') {
    const r = await promoteSkill({ skill: flag(args, 'skill'), from: flag(args, 'from'), note: flag(args, 'note'), force: has(args, 'force') });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    if (r.ok) console.log('  下一步（让 DSH 真正加载）：node tools/shared-skill.mjs pull --skill ' + flag(args, 'skill'));
    return r.ok ? 0 : 1;
  }

  if (cmd === 'pull') {
    const r = await pullSkill({ skill: flag(args, 'skill'), force: has(args, 'force') });
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return r.ok ? 0 : 1;
  }

  console.error(`未知命令：${cmd}。试试 node tools/shared-skill.mjs help`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('shared-skill.mjs')) {
  main().then((code) => process.exit(code));
}
