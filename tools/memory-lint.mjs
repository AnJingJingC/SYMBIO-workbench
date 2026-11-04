#!/usr/bin/env node
/**
 * SYMBIO · 记忆体检（零依赖，纯本地）
 * 用法：
 *   node tools/memory-lint.mjs
 *   node tools/memory-lint.mjs --scene knowledge-digest
 *   node tools/memory-lint.mjs --json
 * 退出码：0 = 无 FAIL，1 = 有 FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'symbio.config.json');

const results = [];
function add(level, id, msg, fix) {
  results.push({ level, id, msg, fix: fix || '' });
}

function parseArgs(argv) {
  const out = { scene: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scene') out.scene = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function sizeKB(p) {
  try {
    return fs.statSync(p).size / 1024;
  } catch {
    return null;
  }
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1) 配置可解析
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    add('PASS', 'config', '配置文件可解析');
  } catch (e) {
    add('FAIL', 'config', `config/symbio.config.json 无法解析：${e.message}`, '恢复配置文件后重跑');
    return report();
  }

  const limits = cfg.limits || {};
  const memRoot = path.join(ROOT, cfg.paths?.memoryRoot || 'memory');
  const sceneRoot = path.join(memRoot, '20-scenes');
  const sharedRoot = path.join(memRoot, '10-shared');

  // 2) 场景必需文件
  const scenes = fs.existsSync(sceneRoot)
    ? fs.readdirSync(sceneRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const targetScenes = args.scene ? scenes.filter((s) => s === args.scene) : scenes;
  if (!scenes.length) add('WARN', 'scene', '没有任何场景', '按 INSTALL.md 建一个场景目录');

  for (const s of targetScenes) {
    const base = path.join(sceneRoot, s);
    for (const f of ['定位卡.md', '身份卡.md', '当前交接.md', '私有记忆.md', '场景画像.md']) {
      if (!fs.existsSync(path.join(base, f))) add('FAIL', `scene:${s}`, `缺少 ${f}`, `按模板补建 ${path.join(base, f)}`);
    }
    // 3) 体量红线
    const memKB = sizeKB(path.join(base, '私有记忆.md'));
    if (memKB != null) {
      if (memKB > (limits.sceneMemoryMaxKB || 25))
        add('FAIL', `limit:${s}`, `私有记忆 ${memKB.toFixed(1)}KB > ${limits.sceneMemoryMaxKB}KB`, '把最旧 1/3 移入 90-archive 并在文件头写明');
      else add('PASS', `limit:${s}`, `私有记忆 ${memKB.toFixed(1)}KB ✅`);
    }
    const hoKB = sizeKB(path.join(base, '当前交接.md'));
    if (hoKB != null) {
      if (hoKB > (limits.handoffMaxKB || 4))
        add('FAIL', `handoff:${s}`, `当前交接 ${hoKB.toFixed(1)}KB > ${limits.handoffMaxKB}KB`, '只保留 当前状态/下一步/未决问题/关键路径 四段');
      else add('PASS', `handoff:${s}`, `当前交接 ${hoKB.toFixed(1)}KB ✅`);
    }
  }

  // 4) 主画像体量
  const portraitKB = sizeKB(path.join(sharedRoot, '宿主画像.md'));
  if (portraitKB != null) {
    if (portraitKB > 8) add('FAIL', 'limit:portrait', `宿主画像 ${portraitKB.toFixed(1)}KB > 8KB`, '合并同类项后重写');
    else add('PASS', 'limit:portrait', `宿主画像 ${portraitKB.toFixed(1)}KB ✅`);
  }

  // 5) 索引缺失检测
  const trigger = limits.indexTriggerFiles || 30;
  const allDirs = [];
  (function collect(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      allDirs.push(p);
      collect(p);
    }
  })(memRoot);

  for (const d of allDirs) {
    const mds = fs.readdirSync(d).filter((f) => f.endsWith('.md') && f !== '索引.md');
    if (mds.length >= trigger && !fs.existsSync(path.join(d, '索引.md'))) {
      add('FAIL', 'index', `${path.relative(ROOT, d)} 有 ${mds.length} 个 md 但无索引`, '跑 node tools/index-build.mjs');
    }
  }
  if (!results.some((r) => r.id === 'index')) add('PASS', 'index', '索引完整或无超量目录');

  // 6) 空文件
  for (const f of walk(memRoot)) {
    if (!f.endsWith('.md')) continue;
    try {
      if (fs.statSync(f).size === 0) add('WARN', 'empty', `空文件：${path.relative(ROOT, f)}`, '补内容或删掉');
    } catch {}
  }

  // 7) 归档层存在
  if (!fs.existsSync(path.join(memRoot, '90-archive'))) add('FAIL', 'archive', '归档层不存在', '创建 memory/90-archive/');
  else add('PASS', 'archive', '归档层存在 ✅');

  // 8) 宪法与红线
  for (const f of ['CONSTITUTION.md', 'REDLINES.md']) {
    const p = path.join(memRoot, '00-constitution', f);
    if (!fs.existsSync(p)) add('FAIL', 'constitution', `缺少 ${f}`, '从模板恢复');
  }
  if (!results.some((r) => r.id === 'constitution')) add('PASS', 'constitution', '宪法与红线完整 ✅');

  // 9) 阶段开关一致性
  const st = cfg.stage || {};
  const mods = st.modules || {};
  const stageMap = { A: ['intake', 'pii-guard', 'memory-write', 'handoff', 'recall'], AB: ['dispatch', 'health'], ABC: ['portrait', 'part', 'evolve'] };
  const need = [].concat(stageMap[st.current] || []);
  for (const m of need) {
    if (mods[m] !== true) add('WARN', 'stage', `阶段 ${st.current} 但模块 ${m} 未启用`, '检查 config.stage.modules');
  }
  add('PASS', 'stage', `当前阶段：${st.current || '未设置'}`);

  report();

  function report() {
    const fail = results.filter((r) => r.level === 'FAIL');
    const warn = results.filter((r) => r.level === 'WARN');
    const pass = results.filter((r) => r.level === 'PASS');

    if (args.json) {
      console.log(JSON.stringify({ summary: { FAIL: fail.length, WARN: warn.length, PASS: pass.length }, results }, null, 2));
      process.exit(fail.length ? 1 : 0);
    }

    console.log('\n=== SYMBIO 记忆体检 ===\n');
    for (const r of [...fail, ...warn]) {
      console.log(`[${r.level}] ${r.msg}`);
      if (r.fix) console.log(`        → 修法：${r.fix}`);
    }
    console.log(`\n通过 ${pass.length} 项：`);
    for (const r of pass) console.log(`  ✅ ${r.msg}`);
    console.log(`\n结论：FAIL ${fail.length} / WARN ${warn.length} / PASS ${pass.length}\n`);
    process.exit(fail.length ? 1 : 0);
  }
}

main();
