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
// 本地私有覆盖：真名 / 家人姓名 / 账号前缀放这里，**故意不放进主规则文件**。
// 主文件要进版本库，填真名等于把家人姓名随 git 一起提交、一起同步。
// 本文件由 .gitignore 排除，只在本机存在；没有它一切照旧。
const LOCAL_RULES_PATH = path.resolve(__dirname, '..', 'config', 'pii-rules.local.json');
// 本地文件只允许"加名字"。若允许它改 levels / allowlist，一份本地文件就能悄悄
// 关掉硬红线，而所有人（包括体检）都以为闸还在。
const LOCAL_ALLOWED_KEYS = new Set(['nameDictionary']);

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

function readJsonFile(p) {
  if (!fs.existsSync(p)) return { missing: true };
  try {
    return { data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { broken: String(e && e.message) };
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词典条目 → L2 姓名规则。
 *
 * 分成两组，因为两类的"边界"不一样：
 *   - 中文名（张三）：中文没有词边界，直接当子串匹配，加了边界反而漏（"张三说"匹配不到）
 *   - ASCII（zhangsan / 邮箱前缀）：必须加前后边界，否则 zhang 会命中 zhangwei、@zhang.com
 *
 * 长串排在前面：JS 交替式是「从左到右，先匹配先赢」，
 * 有「李四海」和「李四」两条时必须先匹配长的，否则永远只能截到"李四"。
 */
function dictionaryToPatterns(items) {
  const entries = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of items) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    // 单字当姓名会几乎命中每一篇中文——比不填更糟，因为会让人习惯性忽略告警
    if (v.length < 2) {
      rejected.push({ entry: v, why: '长度 <2：单字当姓名会大面积误杀' });
      continue;
    }
    if (v.length > 32) {
      rejected.push({ entry: `${v.slice(0, 12)}…`, why: '长度 >32：多半是整句，不是姓名或前缀' });
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    entries.push(v);
  }

  const sorted = entries.slice().sort((a, b) => b.length - a.length);
  const cjk = sorted.filter((v) => !/[A-Za-z0-9]/.test(v));
  const ascii = sorted.filter((v) => /[A-Za-z0-9]/.test(v));

  const patterns = [];
  if (cjk.length) {
    patterns.push({
      id: 'name-dict-cjk',
      kind: 'name',
      regex: `(?:${cjk.map(escapeRe).join('|')})`,
      note: `词典命中（中文名 ${cjk.length} 项）`,
      dict: true,
    });
  }
  if (ascii.length) {
    patterns.push({
      id: 'name-dict-ascii',
      kind: 'name',
      regex: `(?<![A-Za-z0-9])(?:${ascii.map(escapeRe).join('|')})(?![A-Za-z0-9])`,
      note: `词典命中（ASCII 名/账号前缀 ${ascii.length} 项）`,
      dict: true,
    });
  }
  return { patterns, entries, rejected };
}

function loadRules() {
  const main = readJsonFile(RULES_PATH);
  if (main.missing) {
    // 保守兜底：规则缺失时一切按 L2 处理
    return { __missing: true };
  }
  if (main.broken) return { __broken: main.broken };
  const rules = main.data;

  // 合并词典：主文件（可入库的通用项）+ 本地私有文件（真名，不入库）
  const local = readJsonFile(LOCAL_RULES_PATH);
  const dict = [];
  if (Array.isArray(rules.nameDictionary)) dict.push(...rules.nameDictionary);
  if (local.data) {
    const illegal = Object.keys(local.data).filter((k) => !LOCAL_ALLOWED_KEYS.has(k) && !k.startsWith('$'));
    // 非法键只报不用：本地文件若写了 levels/allowlist，一笔都不生效
    if (illegal.length) rules.__localRejectedKeys = illegal;
    if (Array.isArray(local.data.nameDictionary)) dict.push(...local.data.nameDictionary);
  } else if (local.broken) {
    // 本地文件坏了**不能**把整份规则判死：它是"加名字"的附件，
    // 坏了只该少认几个名字，不该让硬红线一起失效。要报出来，不静默。
    rules.__localBroken = local.broken;
  }

  const built = dictionaryToPatterns(dict);
  rules.__dictionary = { entries: built.entries.length, rejected: built.rejected };
  if (built.patterns.length) {
    const L2 = rules.levels?.L2;
    if (L2) {
      // 放在最前：精确的姓名/前缀优先于宽泛的正则
      L2.patterns = [...built.patterns, ...(L2.patterns || [])];
    }
  }
  return rules;
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

// 官方示例值白名单：规则加载后填充（见 config/pii-rules.json 的 allowlist.exact）。
// 放行不等于「没看见」——命中的每条都会记进 allowlisted，输出里能看到。
let ALLOW = new Set();
const allowlisted = [];

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
    // 官方示例值放行：AWS 文档里那个 AKIAIOSFODNN7EXAMPLE 之类的串，本身就写在
    // 「这条规则该怎么写」的文档里。一次真机实测里，一篇讨论隐私规则的技术文档
    // 因为引用了它被判 L1 硬拦——**讨论怎么防泄露，被防泄露机制拦了**。
    // 只认逐字全等，且放行要记进 allowlisted，不静默。
    const kept = [];
    let skipped = 0;
    for (const f of found) {
      if (ALLOW.has(f.value)) skipped += 1;
      else kept.push(f);
    }
    if (skipped) allowlisted.push({ id: p.id, count: skipped });
    if (kept.length) {
      hits.push({
        level: levelDef.label,
        id: p.id,
        kind: p.kind || 'unknown',
        note: p.note || '',
        count: kept.length,
        // 只在本地终端显示前 6 个字符，避免把全文打出来
        sampleMasked: kept.slice(0, 3).map((f) => maskValue(f.value)),
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
    // 词典条目也算规则（编译不过就等于没在保护），一并自检并报出被拒条目
    okOut.dictionary = {
      entries: rules.__dictionary?.entries || 0,
      rejected: rules.__dictionary?.rejected || [],
      localFile: fs.existsSync(LOCAL_RULES_PATH) ? LOCAL_RULES_PATH : null,
      localBroken: rules.__localBroken || null,
      localRejectedKeys: rules.__localRejectedKeys || [],
    };
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

  // 官方示例值白名单（只认逐字全等，不做前缀匹配）
  ALLOW = new Set((rules.allowlist?.exact || []).map((v) => String(v)));
  allowlisted.length = 0;

  const hits = [];
  for (const key of ['L1', 'L2', 'L3']) {
    const lv = rules.levels?.[key];
    if (!lv) continue;
    hits.push(...scanLevel(text, lv));
  }

  const L1LABEL = rules.levels?.L1?.label || 'L1';
  const hasL2 = hits.some((h) => h.level === (rules.levels?.L2?.label || 'L2'));
  const hasL3 = hits.some((h) => h.level === (rules.levels?.L3?.label || 'L3'));

  // 2026-11-07：L1 关键词「裸词命中」不再判 BLOCK，降为 L2 提示。
  // 真机实测 6 篇真实技术文档：5 篇被 token/验证码/密码/密钥 裸词误杀，0 篇含真实敏感值
  // （cn-id-card / bank-card / passport / api-key-literal / private-key-block 全未命中）。
  // 裸词只说明「在讨论这个概念」，不等于「泄露了这个值」。
  // 真正的凭据仍由三条正则硬拦：api-key-literal / private-key-block / secret-assignment。
  const l1Hits = hits.filter((h) => h.level === L1LABEL);
  const l1Real = l1Hits.filter((h) => h.kind !== 'keyword');
  const l1Words = l1Hits.filter((h) => h.kind === 'keyword');
  const hasL1 = l1Real.length > 0;

  const verdict = hasL1 ? 'BLOCK' : hasL2 || l1Words.length ? 'REDACT' : 'PASS';
  const result = {
    verdict,
    level: hasL1 ? 'L1' : hasL2 || l1Words.length ? 'L2' : hasL3 ? 'L3' : 'none',
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
  if (l1Words.length && !hasL1) {
    for (const h of l1Words) {
      h.downgraded = true;
      h.note = '硬红线关键词裸词命中 —— 已降为 L2 提示（没命中任何真实凭据格式，不拦截）';
    }
    result.keywordOnly = true;
    result.note = `提到 ${l1Words[0].count} 个硬红线关键词，但没有任何真实凭据格式 → 按 L2 处理（脱敏后可出网）。`;
  }
  if (ruleErrors.length) {
    result.ruleErrors = ruleErrors;
    result.hint = `⚠ 有 ${ruleErrors.length} 条规则编译失败，未参与匹配（见 ruleErrors）。此时 PASS 不代表安全。`;
    console.error(`⚠ 规则编译失败 ${ruleErrors.length} 条：${ruleErrors.map((r) => `${r.id} (${r.error})`).join('；')}`);
  }

  // L2 里也有同一类「只提到词、没给值」的情况（体检报告 / 工资 / 病历 …）。
  // 判据与 L1 一致：这一层只有 keyword 一种命中，且没有更高级别的真值命中。
  // 为什么要标出来：体检报告要回答「有没有 L2 内容漏进可同步文件」，
  // 而「卡片里出现『体检报告』四个字」不是泄露。不标这一位，体检就只剩误报可用。
  // 注意：标记不等于放行——verdict 仍是 REDACT，出网仍要脱敏；只是让调用方能分辨。
  const l2Hits = hits.filter((h) => h.level === (rules.levels?.L2?.label || 'L2'));
  const l2Real = l2Hits.filter((h) => h.kind !== 'keyword');
  if (!hasL1 && l2Hits.length && !l2Real.length && !l1Real.length) {
    for (const h of l2Hits) h.keywordOnly = true;
    result.keywordOnly = true;
    result.note = `仅命中 L2 关键词（${l2Hits.map((h) => h.id).join('、')}），未命中任何带值的格式 → 按"提及"处理，不是泄露。`;
  }

  if (allowlisted.length) {
    const n = allowlisted.reduce((a, x) => a + x.count, 0);
    result.allowlisted = allowlisted;
    result.allowlistNote = `${n} 处命中是公开示例值（allowlist.exact），已放行且不外发；如认为不该放行，从 config/pii-rules.json 的 allowlist 里删掉该串。`;
  }

  // 配置层面的告警：本地私有词典坏了、或被塞了不该有的键。都不影响裁决，
  // 但必须让调用方看得见——静默失效正是这条闸历史上最大的问题。
  const cfgWarn = [];
  if (rules.__localBroken) cfgWarn.push(`config/pii-rules.local.json 解析失败（${rules.__localBroken}），本次只用了主规则 + 主词典`);
  if (rules.__localRejectedKeys?.length) cfgWarn.push(`config/pii-rules.local.json 含不允许的键（${rules.__localRejectedKeys.join('、')}），已忽略；该文件只允许 nameDictionary`);
  if (rules.__dictionary?.rejected?.length) cfgWarn.push(`${rules.__dictionary.rejected.length} 条词典条目被拒（${rules.__dictionary.rejected.map((x) => `${x.entry}: ${x.why}`).join('；')}）`);
  if (cfgWarn.length) result.configWarnings = cfgWarn;

  if (args.redact && verdict !== 'BLOCK') {
    const r = redact(text, rules);
    result.redactedText = r.redacted;
    result.replacements = r.replacements;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(verdict === 'BLOCK' ? 2 : 0);
}

main();
