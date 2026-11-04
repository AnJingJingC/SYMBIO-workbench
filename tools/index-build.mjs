#!/usr/bin/env node
/**
 * SYMBIO · 索引生成器（零依赖）
 * 扫描指定目录下的 .md，为每篇抽取「标题 + 一句话 + 标签」，生成 索引.md。
 * 用法：
 *   node tools/index-build.mjs
 *   node tools/index-build.mjs --dir "memory/20-scenes/knowledge-digest/cards"
 *   node tools/index-build.mjs --dir ... --name "卡片索引"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { dir: 'memory/20-scenes/knowledge-digest/cards', name: '卡片索引' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--name') out.name = argv[++i];
  }
  return out;
}

function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

const META_PREFIX = /^[-*]\s*(来源|摄入时间|密级|主题标签|更新时间|状态)[：:]/;

// 小节名（可能带 # 或 ** 包裹）：不是正文，取摘要时必须跳过
const SECTION_NAMES = /^(一句话结论|要点|值得记的原文片段|原文片段|标签|结论|摘要|要点提炼)$/;
const stripMarks = (l) => l.replace(/^[#*\s]+|[*\s]+$/g, '').replace(/[：:]$/, '');

/**
 * 抽「一句话」。
 * 2026-11-04 真机踩坑：卡片由外部模型生成，小节标题是**纯文本**「一句话结论」而不是
 * `## 一句话结论`，旧正则匹配不到 → 退化取"正文第一行"，而正文第一行恰好是重复的标题，
 * 于是索引里每条的"一句话"都等于标题，信息量归零。
 */
function firstSentence(text, title = '') {
  const plain = text.replace(/^---[\s\S]*?---/, '');
  const lines = plain.split('\n').map((l) => l.trim());
  const titleFlat = clean(title);

  const isNoise = (l) =>
    !l ||
    l.startsWith('#') ||
    l.startsWith('|') ||
    l.startsWith('>') ||
    l.startsWith('```') ||
    l.startsWith('<!--') ||
    META_PREFIX.test(l) ||
    SECTION_NAMES.test(stripMarks(l));

  // 1) 优先：标记行「一句话结论」之后的第一段有效文本（兼容 ## / ** / 纯行三种写法）
  const idx = lines.findIndex((l) => stripMarks(l) === '一句话结论');
  if (idx >= 0) {
    for (let i = idx + 1; i < lines.length; i++) {
      if (SECTION_NAMES.test(stripMarks(lines[i]))) break; // 进入下一小节，停止
      if (isNoise(lines[i])) continue;
      const c = clean(lines[i]);
      if (c.length >= 8 && c !== titleFlat) return c;
    }
  }

  // 2) 退化：第一段有效、且不与标题重复的正文
  for (const l of lines) {
    if (isNoise(l)) continue;
    const c = clean(l.replace(/^[-*]\s*/, ''));
    if (c.length >= 8 && c !== titleFlat) return c;
  }
  return '（无摘要）';
}

function clean(s) {
  return s
    .replace(/^一句话结论[：:]\s*/, '')
    .replace(/\|/g, '｜')
    .slice(0, 60);
}

function tags(text) {
  const set = new Set();
  const re = /(?:标签[：:]\s*)?((?:#[\u4e00-\u9fa5A-Za-z0-9_-]+(?:\s+|$))+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const parts = m[1].split(/\s+/).filter((t) => t.startsWith('#'));
    parts.forEach((t) => set.add(t));
  }
  return [...set].slice(0, 6).join(' ');
}

function dateOf(name, fallback) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : fallback;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(ROOT, args.dir);
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '索引.md').sort();
  const rows = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const text = fs.readFileSync(full, 'utf8');
    const title = firstHeading(text) || f.replace(/\.md$/, '');
    const one = firstSentence(text, title);
    const tg = tags(text) || '—';
    const d = dateOf(f, fs.statSync(full).mtime.toISOString().slice(0, 10));
    rows.push({ f, title, one, tg, d });
  }

  const out = [];
  out.push(`# ${args.name}（自动生成）`);
  out.push('');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  out.push(`> 由 \`node tools/index-build.mjs\` 生成于 ${stamp}（本地时间）`);
  out.push(`> 共 ${rows.length} 条。**只写一句话，不写正文**。手工补充请写在表格下方，重跑不会丢（会被保留）。`);
  out.push('');
  out.push('| 文件 | 标题 | 一句话 | 标签 | 日期 |');
  out.push('|---|---|---|---|---|');
  if (!rows.length) out.push('| （空） | — | 还没有内容 | — | — |');
  for (const r of rows) out.push(`| ${r.f} | ${r.title.replace(/\|/g, '｜')} | ${r.one} | ${r.tg} | ${r.d} |`);
  out.push('');

  const idxPath = path.join(dir, '索引.md');
  let tail = '';
  if (fs.existsSync(idxPath)) {
    const old = fs.readFileSync(idxPath, 'utf8');
    const marker = '<!-- 手工区：以下内容由宿主维护，自动生成不会覆盖 -->';
    const i = old.indexOf(marker);
    if (i >= 0) tail = '\n' + old.slice(i);
  }
  out.push('<!-- 手工区：以下内容由宿主维护，自动生成不会覆盖 -->');
  out.push(tail.replace('<!-- 手工区：以下内容由宿主维护，自动生成不会覆盖 -->', '').trim());
  out.push('');

  fs.writeFileSync(idxPath, out.join('\n'), 'utf8');
  console.log(`已生成：${path.relative(ROOT, idxPath)}（${rows.length} 条）`);
}

main();
