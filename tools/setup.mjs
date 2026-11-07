#!/usr/bin/env node
// tools/setup.mjs —— 从零到能用的一步初始化（只报告 / 补建 / 复检）
//
// 为什么需要它：INSTALL.md 写的是"把整个 symbio/ 目录拷过去"——那是**迁移**，
// 前提是你已经有一份活过来的记忆。而真实情况有两种：
//   1. 从发布仓 clone 下来：tool/config/skills 都有，memory/ 一个文件都没有
//      （memory 永远不同步，里可能有个人画像）。面板装好了，数字全是「—」。
//   2. 记忆目录被误删/搬错盘：症状与上面完全一样。
// 两种情况的共同点是**没人告诉用户少了什么、该按什么顺序补**。本脚本干这件事。
//
// 边界（与其它工具一致：只动自己该动的）：
//   · 默认**只读**，一个字节都不写；加 --fix 才补建
//   · 只补**不存在的**目录与文件，绝不覆盖已有内容（记忆一旦被覆盖就找不回来）
//   · 不联网：桥只是探一下在线状态，探不到记 WARN，不影响判定
//   · 不替你填内容：模板里全是"待宿主填写"，本脚本不猜你是谁
//
// 用法：
//   node tools/setup.mjs                 # 体检：告诉我缺什么
//   node tools/setup.mjs --fix           # 补建缺失的目录与出厂文件
//   node tools/setup.mjs --scene xxx     # 配合 --fix 多建一个场景
//   node tools/setup.mjs --json          # 机器可读（给面板/CI 用）
//   node tools/setup.mjs --no-bridge     # 不探桥（离线环境）
//
// 退出码：0 = 无 FAIL；1 = 还有 FAIL；2 = 参数错误

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TPL = path.join(ROOT, 'config', 'templates');
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(`--${n}`);
const flagVal = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return '';
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
};

const FIX = hasFlag('fix');
const JSON_OUT = hasFlag('json');
const NO_BRIDGE = hasFlag('no-bridge');
const EXTRA_SCENES = flagVal('scene') ? flagVal('scene').split(',').map((s) => s.trim()).filter(Boolean) : [];

if (hasFlag('help') || hasFlag('h')) {
  console.log(`用法：
  node tools/setup.mjs                体检，告诉我缺什么（只读）
  node tools/setup.mjs --fix          补建缺失的目录与出厂文件（不覆盖已有）
  node tools/setup.mjs --scene xxx    配合 --fix，多建一个场景
  node tools/setup.mjs --json         机器可读
  node tools/setup.mjs --no-bridge    不探桥

退出码：0 无 FAIL / 1 有 FAIL / 2 参数错误`);
  process.exit(0);
}

// ── 输出小工具（中文按两格算，否则列对不齐）──────────────────────────
const dwidth = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\uFF60\uFF00-\uFFEF]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dwidth(s)));
const MARK = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };

const results = [];
function add(level, id, title, msg, fix = '', fixed = false) {
  results.push({ level, id, title, msg, fix, fixed });
}
const has = (rel) => fs.existsSync(path.join(ROOT, rel));
const abs = (rel) => path.join(ROOT, rel);
const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
  } catch {
    return null;
  }
};
const countDirs = (rel) => {
  try {
    return fs.readdirSync(abs(rel), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return -1;
  }
};
const countFiles = (rel, ext) => {
  try {
    return fs.readdirSync(abs(rel), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(ext)).length;
  } catch {
    return -1;
  }
};

const SCENE_FILES = ['身份卡.md', '定位卡.md', '当前交接.md', '私有记忆.md', '场景画像.md'];
const SCENE_NAMES = {
  'knowledge-digest': '知识消化场景',
  'deep-research': '深度研究场景',
};
const today = () => new Date().toLocaleDateString('sv-SE');

// 要检查的场景 = 配置里的默认场景 + 磁盘上已有的场景 + --scene 指定的新场景。
// 只查默认场景是不够的：面板按目录列场景，第二、第三个场景缺件时面板照样显示，
// 但点进去全是空的——那才是最容易被当成"面板坏了"的状态。
function sceneList(memRoot, defaultScene) {
  let onDisk = [];
  try {
    onDisk = fs
      .readdirSync(abs(`${memRoot}/20-scenes`), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    onDisk = [];
  }
  return [...new Set([defaultScene, ...onDisk, ...EXTRA_SCENES])].filter(Boolean).sort();
}

// ── 检查项 ───────────────────────────────────────────────────────────
async function runChecks() {
  results.length = 0;
  const cfg = readJson('config/symbio.config.json');

  // 1. 这是不是工作台根
  if (has('tools/memory-lint.mjs') && has('config/symbio.config.json')) {
    add('PASS', 'root', '工作台根', ROOT);
  } else {
    add('FAIL', 'root', '工作台根', `这里不像工作台根：${ROOT}`, '在含有 tools/ 与 config/ 的目录里运行');
    return; // 根都不对，后面的检查没有意义
  }

  // 2. 配置可解析（后面所有检查都依赖它）
  if (!cfg) {
    add('FAIL', 'config', '主配置', 'config/symbio.config.json 缺失或无法解析', '从仓库恢复该文件');
    return;
  }
  add('PASS', 'config', '主配置', `可解析，阶段 ${cfg.stage?.current ?? '?'}`);

  const memRoot = cfg.paths?.memoryRoot || 'memory';
  const defaultScene = cfg.paths?.defaultScene || 'knowledge-digest';
  const scenes = sceneList(memRoot, defaultScene);

  // 3. 六层记忆目录
  const LAYERS = [
    ['00-constitution', '宪法'],
    ['10-shared', '共享'],
    ['20-scenes', '场景'],
    ['30-personal', '私人'],
    ['50-inbox', '收件箱'],
    ['90-archive', '归档'],
  ];
  const missingLayers = LAYERS.filter(([k]) => !has(`${memRoot}/${k}`)).map(([k]) => k);
  if (!missingLayers.length) {
    add('PASS', 'layers', '记忆六层', `${LAYERS.length} 层齐全`);
  } else {
    add('FAIL', 'layers', '记忆六层', `缺 ${missingLayers.length} 层：${missingLayers.join(', ')}`, `node tools/setup.mjs --fix`);
  }

  // 4. 宪法与红线（这两个是 lint 的硬 FAIL 项）
  const missingConst = ['CONSTITUTION.md', 'REDLINES.md'].filter((f) => !has(`${memRoot}/00-constitution/${f}`));
  if (!missingConst.length) add('PASS', 'constitution', '宪法与红线', '两份齐全');
  else add('FAIL', 'constitution', '宪法与红线', `缺 ${missingConst.join(', ')}`, 'node tools/setup.mjs --fix');

  // 5. 共享层三件（看板缺了就没法派单，台账缺了预算硬闸会重建）
  const sharedNeed = [
    ['任务看板.md', 'FAIL'],
    ['花费台账.json', 'WARN'],
    ['宿主画像.md', 'WARN'],
  ];
  const sharedState = sharedNeed.map(([f, lvl]) => ({ f, lvl, ok: has(`${memRoot}/10-shared/${f}`) }));
  const sharedFail = sharedState.filter((s) => !s.ok && s.lvl === 'FAIL');
  const sharedWarn = sharedState.filter((s) => !s.ok && s.lvl === 'WARN');
  if (!sharedFail.length && !sharedWarn.length) {
    add('PASS', 'shared', '共享层', `${sharedNeed.length} 件齐全`);
  } else if (sharedFail.length) {
    add('FAIL', 'shared', '共享层', `缺 ${sharedFail.map((s) => s.f).join(', ')}`, 'node tools/setup.mjs --fix');
  } else {
    add('WARN', 'shared', '共享层', `缺 ${sharedWarn.map((s) => s.f).join(', ')}（不致命，补上更好）`, 'node tools/setup.mjs --fix');
  }

  // 6. 场景五件套（lint 每个场景都要查这五个）
  const sceneProblems = [];
  for (const s of scenes) {
    if (!has(`${memRoot}/20-scenes/${s}`)) {
      sceneProblems.push(`${s}：整个目录不存在`);
      continue;
    }
    const miss = SCENE_FILES.filter((f) => !has(`${memRoot}/20-scenes/${s}/${f}`));
    if (miss.length) sceneProblems.push(`${s}：缺 ${miss.length} 件（${miss.join('、')}）`);
  }
  if (!sceneProblems.length) {
    add('PASS', 'scene', '场景五件套', `${scenes.join('、')} 齐全`);
  } else {
    add('FAIL', 'scene', '场景五件套', sceneProblems.join('；'), 'node tools/setup.mjs --fix');
  }

  // 7. 卡片目录（空着不重要，但"目录都不在"意味着落卡会失败）
  // 只对默认场景要求 cards/：卡片目录是知识消化场景的约定，别的场景用私有记忆存结论
  const cardDirs = [defaultScene].filter((s) => !has(`${memRoot}/20-scenes/${s}/cards`));
  if (!cardDirs.length) add('PASS', 'cards', '卡片目录', '就位');
  else add('WARN', 'cards', '卡片目录', `${cardDirs.join('、')} 还没有 cards/`, 'node tools/setup.mjs --fix');

  // 8. 技能（面板的"已装技能"就数这个）
  const nSkills = countDirs('.dsh/skills');
  if (nSkills < 0) {
    add('FAIL', 'skills', '技能', '.dsh/skills 不存在', '从仓库拷 .dsh/skills（发布仓已包含）');
  } else if (nSkills === 0) {
    add('FAIL', 'skills', '技能', '.dsh/skills 是空的', '从仓库拷 .dsh/skills（发布仓已包含）');
  } else if (nSkills < 10) {
    add('WARN', 'skills', '技能', `已装 ${nSkills} 个（完整版 12 个）`, '比对 .dsh/skills 与仓库版本');
  } else {
    add('PASS', 'skills', '技能', `已装 ${nSkills} 个`);
  }

  // 9. 工具（面板工具箱预期 6 个可点，内部 Worker 另算）
  const nTools = countFiles('tools', '.mjs');
  if (nTools < 6) add('FAIL', 'tools', '工具', `tools/ 下只有 ${nTools} 个 .mjs`, '从仓库拷 tools/');
  else add('PASS', 'tools', '工具', `${nTools} 个 .mjs`);

  // 10. 隐私规则：能解析 + 词典是否填过（这条最容易被跳过，也最影响效果）
  const pii = readJson('config/pii-rules.json');
  if (!pii) {
    add('FAIL', 'privacy', '隐私规则', 'config/pii-rules.json 缺失或无法解析', '从仓库恢复');
  } else {
    const dict = Array.isArray(pii.nameDictionary) ? pii.nameDictionary.filter(Boolean) : [];
    const nPat = ['L1', 'L2', 'L3'].reduce((n, k) => n + (pii.levels?.[k]?.patterns?.length || 0), 0);
    if (!dict.length) {
      add('WARN', 'privacy', '隐私规则', `${nPat} 条规则可用，但 nameDictionary 是空的`, '把真名/家人姓名/常用账号前缀填进 config/pii-rules.json');
    } else {
      add('PASS', 'privacy', '隐私规则', `${nPat} 条规则，词典 ${dict.length} 项`);
    }
  }

  // 11. 桥（可选件：没它也能用，只是没有"无人循环消化"）
  if (NO_BRIDGE) {
    add('PASS', 'bridge', '免费 AI 桥', '已按 --no-bridge 跳过探测');
  } else {
    const b = await probeBridge();
    if (b.ok) add('PASS', 'bridge', '免费 AI 桥', `在线，站点 ${b.sites.join('/')}`);
    else add('WARN', 'bridge', '免费 AI 桥', `未连上（${b.reason}）——不影响读写，只是没有自动消化`, 'cd shell && npm run bridge');
  }

  // 12. 体检工具自己的结论（把 lint 的 FAIL 数当成本脚本的 FAIL 数）
  const lint = runLint();
  if (lint === null) add('WARN', 'lint', '记忆体检', '跑不起来（memory-lint 缺失或超时）', 'node tools/memory-lint.mjs 手动看');
  else if (lint.fail > 0) add('FAIL', 'lint', '记忆体检', `memory-lint 报 ${lint.fail} 个 FAIL`, 'node tools/memory-lint.mjs 看详情');
  else add('PASS', 'lint', '记忆体检', `FAIL 0 / WARN ${lint.warn} / PASS ${lint.pass}`);

  // 13. Git（建议项，不影响能用）
  if (has('.git')) add('PASS', 'git', '版本控制', '已初始化');
  else add('WARN', 'git', '版本控制', '还没 git init——记忆改动无法回滚', 'git init && git add . && git commit -m "init"');
}

// ── 桥探测（1.5s 超时，探不到就是没开，不重试）────────────────────────
async function probeBridge() {
  try {
    const res = await fetch(`${BRIDGE.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, sites: Array.isArray(body.sites) ? body.sites : [] };
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? '1.5s 无响应' : '未启动' };
  }
}

// ── 调 lint 拿结论（用的就是同一个工具，不另写一套判据）────────────────
function runLint() {
  try {
    let out;
    try {
      out = execFileSync(process.execPath, [abs('tools/memory-lint.mjs'), '--json'], {
        cwd: ROOT, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      out = e.stdout; // 退出码 1 = 有 FAIL，但 JSON 仍会打出来
    }
    const data = JSON.parse(out);
    // memory-lint 的 summary 键是大写的（FAIL/WARN/PASS），别按小写读
    const s = data.summary || {};
    return { fail: s.FAIL ?? 0, warn: s.WARN ?? 0, pass: s.PASS ?? 0 };
  } catch {
    return null;
  }
}

// ── 补建 ─────────────────────────────────────────────────────────────
const fixedLog = [];

function writeIfAbsent(rel, content) {
  if (has(rel)) return false;
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content, 'utf8');
  fixedLog.push(rel);
  return true;
}

function readTpl(name) {
  try {
    return fs.readFileSync(path.join(TPL, name), 'utf8');
  } catch {
    return null;
  }
}

function applyFixes(cfg) {
  const memRoot = cfg?.paths?.memoryRoot || 'memory';
  const defaultScene = cfg?.paths?.defaultScene || 'knowledge-digest';
  const scenes = sceneList(memRoot, defaultScene);
  const date = today();
  const fill = (tpl, scene) =>
    tpl
      .split('{{date}}').join(date)
      .split('{{scene_name}}').join(SCENE_NAMES[scene] || `${scene} 场景`)
      .split('{{scene}}').join(scene);

  // 目录先建（内容文件依赖父目录）
  for (const k of ['00-constitution', '10-shared', '20-scenes', '30-personal', '50-inbox', '90-archive']) {
    const p = abs(`${memRoot}/${k}`);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      fixedLog.push(`${memRoot}/${k}/`);
    }
  }
  // 收件箱的四个去向目录（autopilot 直接往里 mv，缺了会报错）
  for (const k of ['_done', '_blocked', '_failed', '_too-long']) {
    const p = abs(`${memRoot}/50-inbox/${k}`);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      fixedLog.push(`${memRoot}/50-inbox/${k}/`);
    }
  }

  // 出厂文件（只补不覆盖）
  const items = [
    ['CONSTITUTION.md', `${memRoot}/00-constitution/CONSTITUTION.md`, null],
    ['REDLINES.md', `${memRoot}/00-constitution/REDLINES.md`, null],
    ['任务看板.md', `${memRoot}/10-shared/任务看板.md`, null],
    ['花费台账.json', `${memRoot}/10-shared/花费台账.json`, null],
    ['宿主画像.md', `${memRoot}/10-shared/宿主画像.md`, null],
  ];
  for (const [tplName, dest, scene] of items) {
    const tpl = readTpl(tplName);
    if (tpl == null) continue; // 模板缺失不报错，由检查项如实反映
    writeIfAbsent(dest, scene ? fill(tpl, scene) : fill(tpl, defaultScene));
  }

  // 场景五件套 + cards/
  for (const s of scenes) {
    const base = `${memRoot}/20-scenes/${s}`;
    const p = abs(base);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      fixedLog.push(`${base}/`);
    }
    const cardsDir = abs(`${base}/cards`);
    if (s === defaultScene && !fs.existsSync(cardsDir)) {
      fs.mkdirSync(cardsDir, { recursive: true });
      fixedLog.push(`${base}/cards/`);
    }
    for (const f of SCENE_FILES) {
      const tpl = readTpl(`scene/${f}`);
      if (tpl == null) continue;
      writeIfAbsent(`${base}/${f}`, fill(tpl, s));
    }
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────
const cfgForFix = readJson('config/symbio.config.json');
// 参数校验：--scene 后面必须跟着值（写成 --scene --fix 是最常见的误用）
{
  const i = argv.indexOf('--scene');
  if (i >= 0 && (i === argv.length - 1 || argv[i + 1].startsWith('--'))) {
    console.error('--scene 需要一个场景名，例如：--scene contract-review');
    process.exit(2);
  }
}

await runChecks();
const before = results.reduce((a, r) => ({ ...a, [r.level]: (a[r.level] || 0) + 1 }), {});

if (FIX) {
  applyFixes(cfgForFix);
  await runChecks(); // 复检：让输出反映"修完之后"的真实状态
}

const summary = results.reduce((a, r) => ({ ...a, [r.level]: (a[r.level] || 0) + 1 }), {});
const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: fails.length === 0,
    root: ROOT,
    checkedAt: new Date().toISOString(),
    fixed: fixedLog,
    before,
    summary: { pass: summary.PASS || 0, warn: summary.WARN || 0, fail: summary.FAIL || 0 },
    results,
  }, null, 2));
} else {
  const line = '─'.repeat(60);
  console.log(`\nSYMBIO 工作台 · 初始化检查${FIX ? '（--fix 已运行）' : ''}`);
  console.log(`根目录 ${ROOT}`);
  console.log(line);
  for (const r of results) {
    console.log(`${MARK[r.level]}  ${padR(r.title, 12)} ${r.msg}`);
    if (r.level !== 'PASS' && r.fix) console.log(`      ${' '.repeat(12)} → ${r.fix}`);
  }
  console.log(line);
  console.log(`PASS ${summary.PASS || 0} / WARN ${summary.WARN || 0} / FAIL ${summary.FAIL || 0}`);

  if (fixedLog.length) {
    console.log(`\n本次补建 ${fixedLog.length} 项：`);
    for (const f of fixedLog) console.log(`  + ${f}`);
  }

  if (fails.length) {
    console.log(`\n还有 ${fails.length} 项没解决。按上面的 → 提示逐条处理；`);
    console.log(`大部分能一条命令补掉：node tools/setup.mjs --fix`);
  } else if (warns.length) {
    console.log(`\n没有硬故障。WARN 是"能用，但还能更好"，建议按顺序处理：`);
    console.log(`  1. 填 config/pii-rules.json 的 nameDictionary（隐私闸靠它认人名）`);
    console.log(`  2. 填 memory/20-scenes/${cfgForFix?.paths?.defaultScene || 'knowledge-digest'}/定位卡.md（AI 的职责边界）`);
    console.log(`  3. 桥没起就跑：cd shell && npm run bridge`);
  } else {
    console.log(`\n全部通过。下一步：`);
  }
  if (!fails.length) {
    console.log(`\n下一步：`);
    console.log(`  1. 把第一篇资料丢进 memory/50-inbox/，然后 node tools/autopilot.mjs --once`);
    console.log(`     （桥没起的话先 cd shell && npm run bridge）`);
    console.log(`  2. 或直接在 DSH 里说"把这篇文章整理成知识卡片"`);
    console.log(`  3. 一周后 node tools/memory-lint.mjs 体检\n`);
  }
}

process.exit(fails.length ? 1 : 0);
