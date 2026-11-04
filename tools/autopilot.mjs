// autopilot.mjs —— 挂监听 + 外部免费算力的无人循环（作者机制清单最后一项的落地）
//
// 链路：memory/50-inbox/*.md（宿主随手丢长文）
//   → load-gate（CPU/内存过高不派活）
//   → pii-scan（L1 命中即拦，进 _blocked/）
//   → 免费 AI 桥消化（豆包等，要求 ≤1200 字知识卡片格式）
//   → tools/intake.mjs 确定性落卡 + 索引重建
//   → 原文移 _done/（失败 _failed/，超长 _too-long/）
//
// 用法：
//   node tools/autopilot.mjs --once              # 只处理现有文件后退出（点测用）
//   node tools/autopilot.mjs                     # 常驻监听（默认 30s 扫描 + fs.watch 即时触发）
//   node tools/autopilot.mjs --interval 60000 --site deepseek
//
// 诚实边界（先读再跑）：
//   1. 依赖伴生桥在线且目标站点已登录（额度耗尽 = 桥报 not-logged-in，本工具不代登录，
//      按"失败"计数，3 次进 _failed/）。启动桥：cd shell && npm run bridge
//   2. 桥 question 上限 4000 字 → 原文 >2800 字不做桥内分块（多问合并极易烧额度且不可靠），
//      直接进 _too-long/ 交宿主决定怎么切。
//   3. 消化质量 = 桥的输出质量。落卡前只做格式与字数闸，不做事实核查。
//   4. 本工具只动 memory/50-inbox/ 与 knowledge-digest/cards/，不碰其他记忆层。

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
};
const ONCE = args.includes('--once');
const INTERVAL_MS = Math.max(10_000, Number(flag('interval')) || 30_000);
const SITE = flag('site') || 'doubao';
const ROOT = process.env.SYMBIO_HOME || 'E:/SYMBIO';
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';
const INBOX = path.join(ROOT, 'memory/50-inbox');
const DONE = path.join(INBOX, '_done');
const BLOCKED = path.join(INBOX, '_blocked');
const FAILED = path.join(INBOX, '_failed');
const TOOLONG = path.join(INBOX, '_too-long');
const BODY_CAP = 2800;          // 桥 4000 字上限 − 指令余量
const MAX_FAILS = 3;

const log = (...m) => console.log(`[autopilot ${new Date().toISOString()}]`, ...m);

async function ensureDirs() {
  for (const d of [INBOX, DONE, BLOCKED, FAILED, TOOLONG]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function failCount(name) {
  try {
    const raw = await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8');
    return JSON.parse(raw)[name] ?? 0;
  } catch { return 0; }
}

async function bumpFail(name) {
  let m = {};
  try { m = JSON.parse(await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8')); } catch { /* 首次 */ }
  m[name] = (m[name] ?? 0) + 1;
  await fs.writeFile(path.join(INBOX, '_fails.json'), JSON.stringify(m, null, 2), 'utf8');
  return m[name];
}

async function move(file, dir) {
  const target = path.join(dir, path.basename(file));
  await fs.rename(file, target).catch(async (e) => {
    if (e?.code === 'EXDEV' || e?.code === 'EPERM') {
      await fs.copyFile(file, target);
      await fs.unlink(file);
    } else throw e;
  });
  return target;
}

async function toolPath(script) {
  // 优先 ROOT/tools（部署位），缺失则回退到本文件同目录（fixture/便携场景）
  const inRoot = path.join(ROOT, 'tools', script);
  try {
    await fs.access(inRoot);
    return inRoot;
  } catch {
    return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), script);
  }
}

async function runTool(script, args_) {
  const scriptPath = await toolPath(script);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [scriptPath, ...args_], {
      cwd: ROOT, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e) };
  }
}

async function bridgeAsk(question) {
  const res = await fetch(`${BRIDGE}/webai/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site: SITE, question }),
    signal: AbortSignal.timeout(200_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.ok !== false, data };
}

const DIGEST_PROMPT = (title) =>
  `请把下面的材料消化成一张知识卡片，严格满足：① 总字数 ≤1200 字；② 第一行是「# <卡片标题>」；` +
  `③ 依次有小节：一句话结论 / 要点（≤5条）/ 值得记的原文片段 / 标签（#开头，2-4个）。` +
  `不要输出卡片以外的任何话。材料标题：「${title}」。\n\n材料正文：\n`;

async function processFile(file) {
  const name = path.basename(file);
  if (path.extname(name) !== '.md' || name.startsWith('_')) return;
  log('处理', name);
  const body = await fs.readFile(file, 'utf8');

  if (body.length > BODY_CAP) {
    log('超长，进 _too-long（桥单问上限内做不了可靠消化）');
    await move(file, TOOLONG);
    return;
  }

  // L1 隐私闸（execFile 无 shell，正文作为 argv 传递安全；exit 2 = BLOCK）
  const scan = await runTool('pii-scan.mjs', ['--text', body]);
  if (scan.code === 2 || /privacy-block|"level"\s*:\s*"L1"|\bBLOCK\b/i.test(scan.stdout)) {
    log('命中 L1 硬红线，进 _blocked，不外发');
    await move(file, BLOCKED);
    return;
  }

  // 负载闸
  const gate = await runTool('load-gate.mjs', ['--json']);
  if (gate.code === 10 || gate.code === 20) {
    log('负载闸不通过，本轮跳过（文件留在 inbox，下轮再试）');
    return;
  }

  // 桥消化
  let reply;
  try {
    const r = await bridgeAsk(DIGEST_PROMPT(name.replace(/\.md$/, '')) + body);
    if (!r.ok) {
      throw new Error(`桥返回 ${r.status}：${r.data?.errorType ?? ''} ${r.data?.message ?? ''}`.trim());
    }
    reply = String(r.data.answer ?? r.data.text ?? '');
    if (!reply.trim()) throw new Error('桥回答为空');
  } catch (e) {
    const n = await bumpFail(name);
    if (n >= MAX_FAILS) {
      log(`连续 ${n} 次失败，进 _failed：`, e.message);
      await move(file, FAILED);
    } else {
      log(`失败 ${n}/${MAX_FAILS}，留待下轮：`, e.message);
    }
    return;
  }

  // 落卡（intake 自带字数闸/防覆盖/索引重建）
  let card;
  try {
    const intakePath = await toolPath('intake.mjs');
    const intake = await import(pathToFileURL(intakePath).href);
    const trimmed = reply.length > 4000 ? reply.slice(0, 4000) : reply; // intake 上限内交给它判定
    card = await intake.runIntake({
      root: ROOT,
      title: name.replace(/\.md$/, ''),
      source: `autopilot:${SITE}`,
      body: trimmed,
    });
    if (!card.ok) throw new Error(card.message ?? card.errorType ?? 'intake 拒绝');
  } catch (e) {
    const n = await bumpFail(name);
    if (n >= MAX_FAILS) {
      log(`落卡连续 ${n} 次失败，进 _failed：`, e.message);
      await move(file, FAILED);
    } else {
      log(`落卡失败 ${n}/${MAX_FAILS}：`, e.message);
    }
    return;
  }

  const target = await move(file, DONE);
  log(`已落卡 ${card.cardFile ?? '?'}；原文归档 ${path.relative(ROOT, target)}`);
  // 成功即清失败计数
  try {
    const m = JSON.parse(await fs.readFile(path.join(INBOX, '_fails.json'), 'utf8'));
    delete m[name];
    await fs.writeFile(path.join(INBOX, '_fails.json'), JSON.stringify(m, null, 2), 'utf8');
  } catch { /* 无计数文件就算了 */ }
}

async function sweep() {
  let entries = [];
  try {
    entries = await fs.readdir(INBOX, { withFileTypes: true });
  } catch { return; }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => path.join(INBOX, e.name));
  for (const f of files) {
    try { await processFile(f); } catch (e) { log('单文件异常（不中断循环）：', e.message); }
  }
  return files.length;
}

async function main() {
  await ensureDirs();
  log(`启动：inbox=${INBOX} site=${SITE} bridge=${BRIDGE} ${ONCE ? '（--once）' : `（每 ${INTERVAL_MS / 1000}s 扫描 + watch）`}`);
  if (ONCE) {
    await sweep();
    log('once 完成，退出。');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep(); } catch (e) { log('扫描异常：', e.message); }
    running = false;
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
  try {
    const { watch } = await import('node:fs');
    watch(INBOX, { persistent: true }, (_evt, fname) => {
      if (fname && String(fname).endsWith('.md')) setTimeout(tick, 2000); // 防抖：等写完
    });
  } catch (e) {
    log('fs.watch 不可用，退化为纯轮询：', e.message);
  }
}

await main();
