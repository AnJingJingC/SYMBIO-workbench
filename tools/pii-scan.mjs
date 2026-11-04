#!/usr/bin/env node
/**
 * SYMBIO · 隐私扫描器（纯本地，零依赖，绝不联网）
 * 用法：
 *   node tools/pii-scan.mjs --text "待检文本"
 *   node tools/pii-scan.mjs --file "path/to/file.txt"
 *   echo "文本" | node tools/pii-scan.mjs --stdin
 *   node tools/pii-scan.mjs --file x.txt --redact      # 额外输出脱敏文本
 *   node tools/pii-scan.mjs --check-rules             # 自检：所有规则能否编译（3 = 有坏规则）
 * 退出码：0 = PASS/REDACT，2 = BLOCK（L1 命中），3 = 规则自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '..', 'config', 'pii-rules.json');

function die(msg, code = 1) {
  console.error(JSON.stringify({ error: msg }, null, 2));
  process.exit(code);
}

function parseArgs(argv) {
  const out = { text: null, file: null, stdin: false, redact: false, json: true, checkRules: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') out.text = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--redact') out.redact = true;
    else if (a === '--check-rules') out.checkRules = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loadRules() {
  if (!fs.existsSync(RULES_PATH)) {
    // 保守兜底：规则缺失时一切按 L2 处理
    return { __missing: true };
  }
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    return { __broken: String(e && e.message) };
  }
}

// 坏规则必须报出来。曾经这里 catch 后直接 continue，结果一条写了 (?i) 的规则
// （JS 不支持内联标志）永远编译失败 → **API Key 那条 L1 硬红线一直是死的**，
// 而输出照样显示 PASS。没在跑的规则比没有规则更危险：你以为有保护。
const ruleErrors = [];

function compileRule(p) {
  try {
    return new RegExp(p.regex, p.flags || 'g');
  } catch (e) {
    ruleErrors.push({ id: p.id, error: String(e && e.message).replace(/^.*?: /, '') });
    return null;
  }
}

function scanLevel(text, levelDef) {
  const hits = [];
  for (const p of levelDef.patterns || []) {
    const re = compileRule(p);
    if (!re) continue;
    const found = [];
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      found.push({ value: m[0], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (++guard > 5000) break;
    }
    if (found.length) {
      hits.push({
        level: levelDef.label,
        id: p.id,
        kind: p.kind || 'unknown',
        note: p.note || '',
        count: found.length,
        // 只在本地终端显示前 6 个字符，避免把全文打出来
        sampleMasked: found.slice(0, 3).map((f) => maskValue(f.value)),
      });
    }
  }
  const kws = [];
  const lower = text.toLowerCase();
  for (const kw of levelDef.keywords || []) {
    if (!kw) continue;
    if (lower.includes(String(kw).toLowerCase())) kws.push(kw);
  }
  if (kws.length) {
    hits.push({
      level: levelDef.label,
      id: `${levelDef.label}-keyword`,
      kind: 'keyword',
      note: '关键词命中',
      count: kws.length,
      sampleMasked: kws.slice(0, 6),
    });
  }
  return hits;
}

function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '*'.repeat(Math.min(6, s.length - 4)) + s.slice(-2);
}

function redact(text, rules) {
  const map = rules.placeholderMap || {};
  const counters = {};
  let out = text;
  const list = [];
  const order = ['L1', 'L2', 'L3'];
  for (const key of order) {
    const lv = rules.levels?.[key];
    if (!lv) continue;
    for (const p of lv.patterns || []) {
      const re = compileRule(p);
      if (!re) continue;
      out = out.replace(re, (match) => {
        const kind = p.kind || 'unknown';
        const token = map[kind] || kind.toUpperCase();
        counters[kind] = (counters[kind] || 0) + 1;
        const ph = `«${token}_${counters[kind]}»`;
        list.push({ placeholder: ph, kind, level: key, originalLength: match.length });
        return ph;
      });
    }
  }
  return { redacted: out, replacements: list };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 规则自检：一条规则编译不过，它就不在保护你。必须能单独查出来。
  if (args.checkRules) {
    const rules = loadRules();
    if (rules.__missing) die('config/pii-rules.json 不存在', 3);
    if (rules.__broken) die(`config/pii-rules.json 解析失败：${rules.__broken}`, 3);
    const bad = [];
    let total = 0;
    for (const key of ['L1', 'L2', 'L3']) {
      for (const p of rules.levels?.[key]?.patterns || []) {
        total += 1;
        if (!compileRule(p)) bad.push({ level: key, id: p.id, error: ruleErrors[ruleErrors.length - 1]?.error });
      }
    }
    const okOut = { total, broken: bad.length, rules: bad };
    console.log(JSON.stringify(okOut, null, 2));
    process.exit(bad.length ? 3 : 0);
  }
  let text = '';
  if (args.text != null) text = args.text;
  else if (args.file) {
    if (!fs.existsSync(args.file)) die(`文件不存在：${args.file}`);
    text = fs.readFileSync(args.file, 'utf8');
  } else if (args.stdin) text = readStdin();
  else die('缺少输入：用 --text / --file / --stdin 指定待检内容');

  const rules = loadRules();
  if (rules.__missing) {
    console.log(
      JSON.stringify(
        { verdict: 'REDACT', level: 'L2', reason: 'pii-rules.json 缺失，按保守默认全部视为 L2', hits: [] },
        null,
        2
      )
    );
    process.exit(0);
  }
  if (rules.__broken) {
    console.log(
      JSON.stringify(
        { verdict: 'REDACT', level: 'L2', reason: `pii-rules.json 解析失败：${rules.__broken}，按保守默认处理`, hits: [] },
        null,
        2
      )
    );
    process.exit(0);
  }

  const hits = [];
  for (const key of ['L1', 'L2', 'L3']) {
    const lv = rules.levels?.[key];
    if (!lv) continue;
    hits.push(...scanLevel(text, lv));
  }

  const hasL1 = hits.some((h) => h.level === (rules.levels?.L1?.label || 'L1'));
  const hasL2 = hits.some((h) => h.level === (rules.levels?.L2?.label || 'L2'));
  const hasL3 = hits.some((h) => h.level === (rules.levels?.L3?.label || 'L3'));

  const verdict = hasL1 ? 'BLOCK' : hasL2 ? 'REDACT' : 'PASS';
  const result = {
    verdict,
    level: hasL1 ? 'L1' : hasL2 ? 'L2' : hasL3 ? 'L3' : 'none',
    action:
      verdict === 'BLOCK'
        ? '立即终止：内容命中硬红线，未做任何处理、未发送任何内容。'
        : verdict === 'REDACT'
        ? '默认本地处理；确需出网必须脱敏并逐条确认。'
        : '可直接使用。',
    hits,
    scannedChars: text.length,
    hint: '本工具全程本地运行，不联网、不写日志。',
  };
  if (ruleErrors.length) {
    result.ruleErrors = ruleErrors;
    result.hint = `⚠ 有 ${ruleErrors.length} 条规则编译失败，未参与匹配（见 ruleErrors）。此时 PASS 不代表安全。`;
    console.error(`⚠ 规则编译失败 ${ruleErrors.length} 条：${ruleErrors.map((r) => `${r.id} (${r.error})`).join('；')}`);
  }

  if (args.redact && verdict !== 'BLOCK') {
    const r = redact(text, rules);
    result.redactedText = r.redacted;
    result.replacements = r.replacements;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(verdict === 'BLOCK' ? 2 : 0);
}

main();
