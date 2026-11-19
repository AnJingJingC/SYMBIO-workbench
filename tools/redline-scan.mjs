#!/usr/bin/env node
/**
 * SYMBIO · 对外文本红线闸（纯本地、零依赖、不联网）
 *
 * 补的位置：现有三道闸都在管"进来的东西"——pii-scan 管隐私、spend-guard 管花费、
 * load-gate 管负载；没有一道管"出去的话"。这一道管的是**承诺与合规**：
 * 价格、退款、收益、绝对化、贬损、时效承诺。
 *
 * 用法：
 *   node tools/redline-scan.mjs --text "这段话要发出去"
 *   node tools/redline-scan.mjs --file "path/to/msg.txt"
 *   echo "文本" | node tools/redline-scan.mjs --stdin
 *   node tools/redline-scan.mjs --text "..." --json            # 机器可读
 *   node tools/redline-scan.mjs --text "..." --explain         # 显示为何命中
 *   node tools/redline-scan.mjs --check-rules                  # 自检：规则能否编译
 *   node tools/redline-scan.mjs --text "..." --rules ./r.json  # 指定规则文件（自测用）
 *   node tools/redline-scan.mjs --text "..." --local ./l.json  # 指定本机覆盖文件（自测用）
 *
 * 退出码：0 = 放行（无命中或仅提醒）；1 = 只有 L2 提醒；2 = L1 硬拦；3 = 规则/用法错误
 *
 * 纪律（与隐私闸同一套）：
 *   · fail-closed：规则缺失、JSON 坏、正则编译不过 → 退出 3，**不假装放行**。
 *     调用方看到非 0 一律"先别发"，别把 3 当成 0。
 *   · 本地覆盖只能加白名单：config/redline-rules.local.json 只认 allowlist，
 *     不允许它改 rules —— 否则一份本地文件就能悄悄关掉整道闸。
 *   · 白名单是"遮蔽"而非"跳过"：命中片段被替换成等长占位符后再匹配，
 *     这样白名单里的短语不会连带把整句放过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES = path.resolve(__dirname, '..', 'config', 'redline-rules.json');
const LOCAL_RULES = path.resolve(__dirname, '..', 'config', 'redline-rules.local.json');
const LOCAL_ALLOWED_KEYS = new Set(['allowlist']);

function die(msg, code = 3) {
  console.error(JSON.stringify({ error: msg }, null, 2));
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (name) => process.argv.includes(`--${name}`);

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    die(`${label} 读不到：${file}（${e.code ?? e.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${label} 不是合法 JSON：${file}（${e.message}）`);
  }
}

// ── 规则装载 ────────────────────────────────────────────────────────────────

function loadRules(rulesPath, localPath = LOCAL_RULES) {
  const main = readJson(rulesPath, '红线规则');
  if (!Array.isArray(main.rules) || main.rules.length === 0) {
    die('红线规则为空：至少要有 1 条规则（空规则等于放行一切）');
  }
  const allow = new Set((main.allowlist ?? []).filter((s) => typeof s === 'string' && s));

  // 本地覆盖：只允许追加白名单
  if (localPath && fs.existsSync(localPath)) {
    const local = readJson(localPath, '本机红线覆盖');
    for (const k of Object.keys(local)) {
      if (!LOCAL_ALLOWED_KEYS.has(k)) {
        die(`本机红线覆盖含非法字段「${k}」：只允许 allowlist（不允许本地关闸）`);
      }
    }
    for (const s of local.allowlist ?? []) if (typeof s === 'string' && s) allow.add(s);
  }

  const compiled = [];
  for (const r of main.rules) {
    if (!r.id || !r.level || !Array.isArray(r.patterns) || r.patterns.length === 0) {
      die(`规则条目不完整（需要 id / level / patterns）：${JSON.stringify(r).slice(0, 80)}`);
    }
    if (r.level !== 'L1' && r.level !== 'L2') die(`规则 ${r.id} 的 level 只能是 L1 或 L2，实际 ${r.level}`);
    const res = [];
    for (const src of r.patterns) {
      try {
        res.push(new RegExp(src, 'u'));
      } catch (e) {
        die(`规则 ${r.id} 的正则编译失败：${src}（${e.message}）`);
      }
    }
    compiled.push({ id: r.id, level: r.level, why: r.why ?? '', regexes: res });
  }
  return { rules: compiled, allowlist: [...allow] };
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function maskAllowlist(text, allowlist) {
  if (!allowlist.length) return text;
  let out = text;
  for (const phrase of allowlist) {
    // 等长占位符：保持偏移不变，snippet 才切得准
    out = out.split(phrase).join('·'.repeat(phrase.length));
  }
  return out;
}

function snippet(text, index, length) {
  const from = Math.max(0, index - 12);
  const to = Math.min(text.length, index + length + 12);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

function scan(text, { rules, allowlist }) {
  const masked = maskAllowlist(text, allowlist);
  const matches = [];
  for (const r of rules) {
    for (const re of r.regexes) {
      const g = new RegExp(re.source, 'gu');
      let m;
      while ((m = g.exec(masked)) !== null) {
        matches.push({
          id: r.id,
          level: r.level,
          why: r.why,
          hit: m[0],
          index: m.index,
          snippet: snippet(text, m.index, m[0].length),
        });
        if (m[0].length === 0) g.lastIndex += 1; // 防零宽死循环
      }
    }
  }
  matches.sort((a, b) => a.index - b.index || b.hit.length - a.hit.length);
  // 同一规则内的重叠命中只留最长的一条：「不满意随时退」命中的「随时退」不应再报一次
  const deduped = [];
  for (const m of matches) {
    const covered = deduped.some((k) => k.id === m.id && m.index < k.index + k.hit.length);
    if (!covered) deduped.push(m);
  }
  const blocked = deduped.filter((m) => m.level === 'L1');
  const warned = deduped.filter((m) => m.level === 'L2');
  return { matches: deduped, blocked, warned };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function readInput() {
  if (has('text')) return arg('text') ?? '';
  if (has('file')) {
    const f = arg('file');
    if (!f) die('--file 需要一个路径');
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (e) {
      die(`文件读不到：${f}（${e.code ?? e.message}）`);
    }
  }
  if (has('stdin')) {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch (e) {
      die(`stdin 读不到（${e.message}）`);
    }
  }
  die('用法：--text "文本" / --file 路径 / --stdin');
}

function main() {
  const rulesPath = arg('rules') || DEFAULT_RULES;
  const localPath = has('local') ? arg('local') || null : LOCAL_RULES;
  const { rules, allowlist } = loadRules(rulesPath, localPath);

  if (has('check-rules')) {
    console.log(
      JSON.stringify(
        { ok: true, rulesFile: rulesPath, rules: rules.length, patterns: rules.reduce((n, r) => n + r.regexes.length, 0), allowlist: allowlist.length },
        null,
        2,
      ),
    );
    return 0;
  }

  const text = readInput();
  if (!text.trim()) die('待检文本为空');

  const { matches, blocked, warned } = scan(text, { rules, allowlist });
  const code = blocked.length ? 2 : warned.length ? 1 : 0;

  if (has('json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: blocked.length === 0,
          exit: code,
          blocked: blocked.length,
          warned: warned.length,
          matches: has('explain') ? matches : matches.map(({ id, level, hit }) => ({ id, level, hit })),
        },
        null,
        2,
      )}\n`,
    );
    return code;
  }

  if (!matches.length) {
    console.log('[红线闸] 放行：未命中（0 处）');
    return 0;
  }

  const head = blocked.length ? `[红线闸] 拦下：L1 ${blocked.length} 处` : `[红线闸] 放行但有提醒：L2 ${warned.length} 处`;
  console.log(head);
  for (const m of matches) {
    const tag = m.level === 'L1' ? '✗ 拦' : '· 提醒';
    console.log(`  ${tag} ${m.id}（${m.level}）命中「${m.hit}」`);
    if (has('explain') && m.why) console.log(`      原因：${m.why}`);
    if (has('explain')) console.log(`      上下文：${m.snippet}`);
  }
  if (blocked.length) console.log('  → 这些话别直接发；要么删掉承诺，要么人来确认后发出。');
  else console.log('  → 不拦，但建议再看一眼上面几处。');
  return code;
}

process.exit(main());
