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
// 业务数据根：与 autopilot / bus / common 一致，优先认 SYMBIO_HOME。
// 这样自测能把体检指向临时目录，不必为了测一条规则去碰真实记忆。
const ROOT = process.env.SYMBIO_HOME || path.resolve(__dirname, '..');
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

  // 5.5) 卡片契约（2026-11-11 新增）
  //
  // 起因：本工具原来**完全不看卡片内容**。真机往 cards/ 塞 4 张坏卡（正文 1400 字、
  // 缺 guard/index_updated、written_to 指向别处、中文文件名），体检仍报 FAIL 0。
  // 而门下省把「memory-lint FAIL 0」当最终裁决 —— 闸门实际上在空转。
  //
  // 卡片现有两套形态，都得认，不能只验一种：
  //   A 型（autopilot/intake 产出）：无 frontmatter，首行 `# 标题`，正文三行元信息，四段
  //   B 型（旧端迁移 / 人工）：YAML frontmatter，五段（含 出处 / 存疑）
  // 「一句话结论 > 60 字」记 WARN 不记 FAIL：60 是索引列宽（index-build 截到 60），
  // 超了只是索引里看不全，卡片本身没错。逼着压短反而会丢掉前提条件。
  // 存量卡里 22 条结论是 60–90 字的完整表述，压短要丢信息 —— 那是改内容，不该由体检逼着做。
  const maxChars = limits.cardMaxChars || 1200;
  const secOf = (body, name) => {
    const re = new RegExp(`^##\\s+${name}\\s*$`, 'm');
    return re.test(body) ? body.split(re)[1].split(/^##\s+/m)[0] : null;
  };
  const cps = (x) => [...x].length;
  for (const s of targetScenes) {
    const cardsDir = path.join(sceneRoot, s, 'cards');
    if (!fs.existsSync(cardsDir)) {
      add('WARN', `card:${s}`, `场景 ${s} 下没有 cards/`, '建 cards/ 后跑 node tools/index-build.mjs');
      continue;
    }
    const files = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.md') && f !== '索引.md');
    let bad = 0;
    // 场景级的报错（不带具体文件名），和逐张卡的 fail() 分开
    const failScene = (m, fix) => {
      bad++;
      add('FAIL', `card:${s}`, m, fix);
    };
    for (const f of files) {
      const rel = `memory/20-scenes/${s}/cards/${f}`;
      const t = fs.readFileSync(path.join(cardsDir, f), 'utf8');
      const ls = t.split(/\r?\n/);
      const fail = (m, fix) => {
        bad++;
        add('FAIL', `card:${s}`, `${f}：${m}`, fix);
      };

      if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/.test(f)) {
        fail('文件名不合规范（应为 YYYY-MM-DD-ascii-slug.md）', '改名成 ascii slug，再重建索引');
      }

      // 分型：首行 --- 且之后能找到闭合 --- 才算 B 型
      let fm = null;
      let body = t;
      if (ls[0] === '---') {
        const end = ls.indexOf('---', 1);
        if (end > 0) {
          fm = {};
          for (const l of ls.slice(1, end)) {
            const m = l.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
            if (m) fm[m[1]] = m[2].trim();
          }
          body = ls.slice(end + 1).join('\n');
        }
      }

      const len = cps(body.replace(/\s+/g, ''));
      if (len > maxChars) fail(`正文 ${len} 字 > ${maxChars} 字上限`, '回去重压：超限说明只抄了笔记，不是消化');

      const concl = secOf(body, '一句话结论');
      if (concl == null) fail('缺「## 一句话结论」段', '按场景画像.md 的卡片格式补');
      else {
        const c = concl.trim();
        if (!c) fail('「一句话结论」是空的', '补一句实在的结论');
        else if (cps(c.split(/\r?\n/)[0].trim()) > 60) {
          // 阈值对齐索引列宽（index-build 截到 60 字）：40~60 字在索引里完整可见，
          // 报了也没人该改；>60 才是真的只剩半句。判 WARN 不判 FAIL。
          const n = cps(c.split(/\r?\n/)[0].trim());
          add('WARN', `card:${s}`, `${f}：一句话结论 ${n} 字 > 60（索引列会截成半句）`, '收进 60 字内，限定条件移进正文');
        }
      }

      if (fm) {
        // B 型契约
        const need = ['title', 'type', 'source', 'date', 'ingested', 'guard', 'written_to', 'index_updated'];
        const miss = need.filter((k) => !fm[k]);
        if (miss.length) fail(`缺必填字段 ${miss.join(', ')}`, '按 场景画像.md 的卡片格式补齐');
        if (fm.type && fm.type !== 'knowledge-card') fail(`type=${fm.type}，应为 knowledge-card`, '改回 knowledge-card');
        if (fm.guard && !['none', 'L1', 'L2', 'L3'].includes(fm.guard)) fail(`guard=${fm.guard} 不在枚举内`, '改回 none/L1/L2/L3');
        if (fm.written_to && fm.written_to !== rel) fail(`written_to 写的是 ${fm.written_to}`, '改成卡片真实相对路径');
        for (const k of ['出处', '存疑']) if (secOf(body, k) == null) fail(`缺「## ${k}」段`, '按格式补，不许省');
        if (secOf(body, '关键点') == null && secOf(body, '要点') == null) fail('缺「## 关键点 / 要点」段', '按格式补');
      } else {
        // A 型契约
        if (!/^#\s+\S/.test(t)) fail('缺一级标题（索引标题列会回落成文件名）', '补 `# 标题` 后重建索引');
        for (const k of ['来源', '摄入时间', '密级']) {
          if (!new RegExp(`^-\\s*${k}[：:]`, 'm').test(t)) fail(`缺元信息「- ${k}：」`, '按 autopilot 卡片头部补三行元信息');
        }
        const pts = secOf(body, '要点');
        if (pts == null) fail('缺「## 要点」段', '按格式补');
        else {
          const n = (pts.match(/^-\s+\S/gm) || []).length;
          if (n < 3) fail(`要点只有 ${n} 条（应 ≥3）`, '补到 3 条以上，否则这张卡没什么可回看的');
        }
        for (const k of ['值得记的原文片段', '标签']) if (secOf(body, k) == null) fail(`缺「## ${k}」段`, '按格式补');
      }
    }

    // 索引条数必须和卡片数一致：索引少一条就等于那张卡检索不到
    const idxPath = path.join(cardsDir, '索引.md');
    if (fs.existsSync(idxPath)) {
      // 判据用「第一列是 xxx.md」而不是 `| 20` 前缀：后者只覆盖以日期开头的文件名，
      // 一旦卡片改名成别的 slug 就静默漏数。与 个人助理 侧同口径。
      const rows = fs.readFileSync(idxPath, 'utf8').split(/\r?\n/).filter((l) => /^\|\s*[^|]+\.md\s*\|/.test(l)).length;
      if (rows !== files.length) failScene(`索引 ${rows} 条 ≠ 卡片 ${files.length} 张`, '跑 node tools/index-build.mjs');
    } else if (files.length) {
      failScene('没有 索引.md', '跑 node tools/index-build.mjs');
    }

    if (!bad && files.length) add('PASS', `card:${s}`, `${files.length} 张卡，格式与体量均合规`);
  }

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

  // 9) 隐私规则可编译（一条编译不过，它就不在保护你——曾有一条 L1 的 API Key 规则
  //    写了 JS 不支持的 (?i)，静默失效很久，而体检照样报 PASS）
  const prPath = path.join(ROOT, 'config', 'pii-rules.json');
  if (!fs.existsSync(prPath)) {
    add('WARN', 'pii-rules', 'config/pii-rules.json 不存在，隐私闸按保守默认处理', '从模板恢复');
  } else {
    try {
      const rules = JSON.parse(fs.readFileSync(prPath, 'utf8'));
      const bad = [];
      let total = 0;
      for (const key of ['L1', 'L2', 'L3']) {
        for (const p of rules.levels?.[key]?.patterns || []) {
          total += 1;
          try {
            void new RegExp(p.regex, p.flags || 'g');
          } catch (e) {
            bad.push(`${p.id}（${String(e.message).replace(/^.*?: /, '')}）`);
          }
        }
      }
      if (bad.length) add('FAIL', 'pii-rules', `${bad.length}/${total} 条隐私规则编译失败，等于没在跑：${bad.join('；')}`, '修 config/pii-rules.json 里的正则（JS 不支持内联 (?i)，改用 flags:"gi"）');
      else add('PASS', 'pii-rules', `隐私规则 ${total} 条全部可编译 ✅`);
    } catch (e) {
      add('FAIL', 'pii-rules', `config/pii-rules.json 解析失败：${e.message}`, '修 JSON 语法');
    }
  }

  // 10) 阶段开关一致性
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
