#!/usr/bin/env node
/**
 * SYMBIO · 知识摄入 Worker（确定性落卡 + 索引重建，零依赖外壳）
 *
 * 设计定位（可移植逻辑层，对应作者仓库 symbio-intake 概念，适配 dataelement 工具/路由模型）：
 *   · 本文件只做「确定性」的部分：隐私闸（L1 硬拦截）→ 字数闸（≤ cardMaxChars）→ 防覆盖写盘 → 重建索引。
 *   · 「把长文消化成卡片正文」需要 LLM，由宿主 Agent（symbio-intake 技能）或免费 AI 桥完成，本文件不负责。
 *   · 因此调用方必须传入已经消化好的卡片正文 body；body 缺位时本文件直接拒绝，绝不凭空编造卡片。
 *
 * 用法（CLI）：
 *   node tools/intake.mjs --title "标题" --source "链接/路径" --body "$(cat card.md)"
 *   echo "<card markdown>" | node tools/intake.mjs --title "标题" --source "x" --stdin
 *
 * 导入（供服务端路由调用）：
 *   import { runIntake } from '../tools/intake.mjs'
 *   const r = await runIntake({ root, title, source, body })
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DEFAULT = path.resolve(__dirname, '..');

const DEFAULTS = { cardMaxChars: 1200, defaultScene: 'knowledge-digest' };

function die(msg, code = 1) {
  // 结构化错误，便于面板 / 路由解析
  process.stdout.write(JSON.stringify({ ok: false, errorType: 'arg-error', message: msg }, null, 2) + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = { title: '', source: '', body: null, stdin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i] || '';
    else if (a === '--source') out.source = argv[++i] || '';
    else if (a === '--body') out.body = argv[++i] || '';
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[1] || '');
      process.exit(0);
    }
  }
  return out;
}

async function readConfig(root) {
  const p = path.join(root, 'config', 'symbio.config.json');
  try {
    const cfg = JSON.parse(await fsp.readFile(p, 'utf8'));
    return {
      cardMaxChars: cfg?.limits?.cardMaxChars ?? DEFAULTS.cardMaxChars,
      defaultScene: cfg?.paths?.defaultScene ?? DEFAULTS.defaultScene,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 纯本地跑隐私闸。命中 L1 返回 {blocked:true}，其余返回 {blocked:false}。绝不联网。 */
async function privacyGate(root, text) {
  const scanPath = path.join(root, 'tools', 'pii-scan.mjs');
  try {
    await fsp.access(scanPath);
  } catch {
    // 缺扫描器时按保守默认放行（不阻断主流程），但报 hint
    return { blocked: false, hint: 'pii-scan.mjs 缺失，跳过本地隐私闸' };
  }
  try {
    const { stdout } = await execFileP('node', [scanPath, '--text', text.slice(0, 4000), '--json'], {
      cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const r = JSON.parse(stdout);
    if (r.verdict === 'BLOCK') return { blocked: true, hits: r.hits };
    return { blocked: false };
  } catch (e) {
    // 退出码 2 也会落到这里，但 stdout 仍含 JSON
    const out = e?.stdout || '';
    try {
      const r = JSON.parse(out);
      if (r.verdict === 'BLOCK') return { blocked: true, hits: r.hits };
    } catch { /* 解析失败按放行 */ }
    return { blocked: false, hint: '隐私闸解析异常，按放行处理' };
  }
}

function slugify(s) {
  const base = String(s || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // 非字母数字 → 连字符（保留中文）
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'untitled';
}

function ensureTitleLine(body, title) {
  if (/^#\s+.+$/m.test(body)) return body; // 已有标题行
  const t = (title || '未命名卡片').trim();
  return `# ${t}\n\n${body.replace(/^\n+/, '')}`;
}

function todayLocal() {
  return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, 时区本地
}

async function uniquePath(dir, date, slug) {
  let candidate = path.join(dir, `${date}-${slug}.md`);
  if (!(await fsp.access(candidate).then(() => true).catch(() => false))) return candidate;
  for (let n = 2; n <= 999; n += 1) {
    candidate = path.join(dir, `${date}-${slug}-${n}.md`);
    if (!(await fsp.access(candidate).then(() => true).catch(() => false))) return candidate;
  }
  throw new Error('防覆盖序号耗尽（>999）');
}

async function rebuildIndex(root, scene) {
  const buildPath = path.join(root, 'tools', 'index-build.mjs');
  const dir = `memory/20-scenes/${scene}/cards`;
  try {
    await fsp.access(buildPath);
  } catch {
    return { ok: false, reason: 'index-build.mjs 缺失，未重建索引' };
  }
  try {
    const { stdout } = await execFileP('node', [buildPath, '--dir', dir, '--name', '卡片索引'], {
      cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, message: stdout.trim() };
  } catch (e) {
    return { ok: false, reason: (e?.stderr || e?.message || '索引重建失败').toString().slice(0, 300) };
  }
}

/**
 * 确定性落卡。所有异常都被吞成结构化结果，绝不抛到调用方。
 * @returns {Promise<{ok:boolean, errorType?:string, message?:string, cardFile?:string, chars?:number, index?:object}>}
 */
export async function runIntake({ root, title, source, body } = {}) {
  const r = String(root || ROOT_DEFAULT);
  const cfg = await readConfig(r);

  const b = typeof body === 'string' ? body : '';
  if (!b.trim()) {
    return { ok: false, errorType: 'empty-body', message: '卡片正文为空：intake 不负责消化，请先由宿主技能或桥产出正文。' };
  }
  if (b.length > cfg.cardMaxChars) {
    return {
      ok: false, errorType: 'over-cap',
      message: `卡片正文 ${b.length} 字，超过 cardMaxChars=${cfg.cardMaxChars}，未落盘。请压缩到上限内（要点化、删冗余）。`,
      chars: b.length, limit: cfg.cardMaxChars,
    };
  }

  const gate = await privacyGate(r, b);
  if (gate.blocked) {
    return {
      ok: false, errorType: 'privacy-block',
      message: '内容命中 L1 硬红线，已终止，未做任何处理、未写入任何文件。',
      hits: gate.hits,
    };
  }

  const finalBody = ensureTitleLine(b, title);
  const scene = cfg.defaultScene;
  const cardsDir = path.join(r, 'memory', '20-scenes', scene, 'cards');
  try {
    await fsp.mkdir(cardsDir, { recursive: true });
  } catch (e) {
    return { ok: false, errorType: 'mkdir-failed', message: `卡片目录创建失败：${e?.message ?? e}` };
  }

  const target = await uniquePath(cardsDir, todayLocal(), slugify(title || 'untitled'));
  try {
    await fsp.writeFile(target, finalBody, 'utf8');
  } catch (e) {
    return { ok: false, errorType: 'write-failed', message: `落卡写入失败：${e?.message ?? e}（内容已在对话内回显，未假装成功）` };
  }

  const idx = await rebuildIndex(r, scene);
  return {
    ok: true,
    cardFile: path.relative(r, target),
    chars: finalBody.length,
    limit: cfg.cardMaxChars,
    scene,
    index: idx,
    gateHint: gate.hint || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let body = args.body;
  if (body == null && args.stdin) {
    try { body = fs.readFileSync(0, 'utf8'); } catch { body = ''; }
  }
  if (body == null) die('缺少卡片正文：用 --body "<markdown>" 或 --stdin 从管道读取。');

  const result = await runIntake({ root: args.root, title: args.title, source: args.source, body });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// 作为 CLI 直接运行时才执行；被 import 时不自动跑
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
