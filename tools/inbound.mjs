#!/usr/bin/env node
/**
 * SYMBIO · 投递式入站（外部消息 → 任务）
 *
 * 补的位置：工作台原来只能"人开口"才开始干活。收件口两个，各管一头——
 *   memory/50-inbox/*.md          知识材料 → autopilot 消化成卡片
 *   memory/50-inbox/_inbound/*    任务来件 → 本工具判定场景并派单
 * 两者同在一个"收件"层，但消费方不同，互不干扰（autopilot 只扫顶层 .md）。
 *
 * 链路：文件进来 → 隐私闸 → route.mjs 判场景（关键词优先，判不准才问桥）
 *       → bus dispatch 落任务看板 → 归档到 _routed/
 * 判不出来：不硬猜，落 _unrouted/ 等人指派。
 * 隐私命中：不外发（连路由都不走，因为路由可能把原文发给桥），落 _blocked/。
 *
 * 用法：
 *   node tools/inbound.mjs --once                 # 处理一轮就退出（点测/定时任务用）
 *   node tools/inbound.mjs --interval 60000       # 循环扫描（默认 30s）
 *   node tools/inbound.mjs --once --dry           # 只判定、不派单、不移动文件
 *   node tools/inbound.mjs --once --json
 *
 * 退出码：0 = 本轮全部处理完（含重复跳过）；1 = 有未路由或被拦的件（要人看）；2 = 用法错
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SYMBIO_HOME ? path.resolve(process.env.SYMBIO_HOME) : path.resolve(HERE, '..');
const INBOX = path.join(ROOT, 'memory/50-inbox');
const DIR = path.join(INBOX, '_inbound');
const ROUTED = path.join(DIR, '_routed');
const UNROUTED = path.join(DIR, '_unrouted');
const BLOCKED = path.join(DIR, '_blocked');
const STATE = path.join(DIR, '_state.json');
const LOG = path.join(DIR, '_inbound-log.md');

const MAX_CHARS = 4000; // 路由只需要意图，长文截断；原文留在归档里
const EXTS = new Set(['.md', '.txt']);

const has = (n) => process.argv.includes(`--${n}`);
function flag(n) {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function die(msg, code = 2) {
  console.error(JSON.stringify({ error: msg }, null, 2));
  process.exit(code);
}

async function ensureDirs() {
  for (const d of [INBOX, DIR, ROUTED, UNROUTED, BLOCKED]) await fs.mkdir(d, { recursive: true });
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {
    return { seen: {} };
  }
}
const saveState = (s) => fs.writeFile(STATE, JSON.stringify(s, null, 2), 'utf8');

async function appendLog(line) {
  const stamped = `- ${new Date().toISOString()} ${line}\n`;
  try {
    await fs.access(LOG);
    await fs.appendFile(LOG, stamped, 'utf8');
  } catch {
    await fs.writeFile(LOG, `# 入站登记\n\n${stamped}`, 'utf8');
  }
}

async function move(file, dir) {
  const target = path.join(dir, path.basename(file));
  try {
    await fs.rename(file, target);
  } catch (e) {
    if (e?.code === 'EXDEV' || e?.code === 'EPERM') {
      await fs.copyFile(file, target);
      await fs.unlink(file);
    } else throw e;
  }
  return target;
}

async function runTool(script, args) {
  // 工具从**脚本自身所在目录**取（部署位），数据根仍走 SYMBIO_HOME：
  // 自测时 root 是临时目录，里面没有 tools/，按 ROOT 找会全部落空。
  const p = path.join(HERE, script);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [p, ...args], {
      cwd: ROOT,
      env: process.env,
      timeout: 240_000, // 路由可能问桥（200s 超时），留余量
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e) };
  }
}

/** 隐私闸：命中即不外发。退出码 2 = L1 拦下；3 = 规则坏了（同样不放行）。 */
async function piiVerdict(text) {
  const r = await runTool('pii-scan.mjs', ['--text', text]);
  if (r.code === 0) return { ok: true };
  if (r.code === 2) return { ok: false, why: 'pii-blocked' };
  return { ok: false, why: `pii-gate-error(${r.code})` };
}

async function listInbound() {
  let entries = [];
  try {
    entries = await fs.readdir(DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('_') && !e.name.startsWith('.') && EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(DIR, e.name))
    .sort();
}

async function processOne(file, ctx) {
  const name = path.basename(file);
  const raw = await fs.readFile(file, 'utf8');
  const text = raw.trim();
  if (!text) {
    if (!ctx.dry) await move(file, UNROUTED);
    await appendLog(`${name} → 空文件，落 _unrouted`);
    ctx.warn += 1;
    return { file: name, verdict: 'empty' };
  }

  const hash = crypto.createHash('sha1').update(text.replace(/\s+/g, ' ').slice(0, 8000)).digest('hex').slice(0, 12);
  if (ctx.state.seen[hash]) {
    if (!ctx.dry) await move(file, ROUTED);
    await appendLog(`${name} → 重复件（hash ${hash} 已在 ${ctx.state.seen[hash].at} 处理过），跳过`);
    return { file: name, verdict: 'duplicate', hash };
  }

  // ① 隐私闸先过：路由可能把原文发给免费桥，等于外发
  const pii = await piiVerdict(text);
  if (!pii.ok) {
    if (!ctx.dry) await move(file, BLOCKED);
    await appendLog(`${name} → ${pii.why}，不外发、不路由`);
    ctx.warn += 1;
    return { file: name, verdict: pii.why };
  }

  // ② 路由：判不出就停，不硬猜
  const brief = text.slice(0, MAX_CHARS);
  const args = [brief];
  if (ctx.dry) args.push('--dry');
  args.push('--json');
  args.push('--accept', `按来源内容完成并在任务看板回执（来源文件：${name}）`);
  args.push('--from', '外来');
  const r = await runTool('route.mjs', args);

  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    parsed = null;
  }

  if (r.code === 0 && parsed?.ok) {
    const hashNote = parsed.dispatched?.hash ? ` · 任务 hash ${parsed.dispatched.hash}` : '';
    await appendLog(`${name} → ${parsed.scene}（${parsed.by}：${parsed.reason}）${hashNote}`);
    if (!ctx.dry) {
      ctx.state.seen[hash] = { at: new Date().toISOString(), scene: parsed.scene, file: name };
      await saveState(ctx.state);
      await move(file, ROUTED);
    }
    ctx.routed += 1;
    return { file: name, verdict: 'routed', scene: parsed.scene, hash: parsed.dispatched?.hash ?? null };
  }

  // 判定失败：可能是判不出来，也可能是路由/桥故障——两种都交给人，不伪装成功
  const why = parsed?.message ?? parsed?.reason ?? (r.stdout || r.stderr || '').slice(0, 200);
  if (!ctx.dry) await move(file, UNROUTED);
  await appendLog(`${name} → 未路由（${parsed?.errorType ?? `exit ${r.code}`}）：${String(why).replace(/\n/g, ' ').slice(0, 160)}`);
  ctx.warn += 1;
  return { file: name, verdict: 'unrouted', why: parsed?.errorType ?? `exit ${r.code}` };
}

async function sweep(ctx) {
  const files = await listInbound();
  if (!files.length) {
    // --json 也是"有结果"：空轮必须回一个空结果对象，否则调用方（面板接口）
    // 拿到空 stdout 只能判成解析失败——把"没事干"报成"工具坏了"，是两种不同的错。
    if (ctx.json) process.stdout.write(`${JSON.stringify({ routed: 0, warn: 0, results: [] })}\n`);
    else console.log('[入站] 没有待处理文件');
    return [];
  }
  const results = [];
  for (const f of files) {
    try {
      results.push(await processOne(f, ctx));
    } catch (e) {
      await appendLog(`${path.basename(f)} → 异常：${e.message}`);
      ctx.warn += 1;
      results.push({ file: path.basename(f), verdict: 'error', why: e.message });
    }
  }
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ routed: ctx.routed, warn: ctx.warn, results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      const mark = r.verdict === 'routed' ? '✓' : '·';
      console.log(`  ${mark} ${r.file} → ${r.verdict}${r.scene ? `（${r.scene}）` : ''}${r.why ? `：${r.why}` : ''}`);
    }
    console.log(`[入站] 本轮 ${results.length} 件：派单 ${ctx.routed}，需人看 ${ctx.warn}`);
  }
  return results;
}

async function main() {
  const interval = Number(flag('interval') || 30_000);
  const once = has('once') || has('dry');
  const ctx = { dry: has('dry'), json: has('json'), state: await loadState(), routed: 0, warn: 0 };

  await ensureDirs();

  if (once) {
    await sweep(ctx);
    return ctx.warn ? 1 : 0;
  }

  console.log(`[入站] 启动：目录 ${DIR}，每 ${Math.max(10_000, interval) / 1000}s 扫描（Ctrl+C 退出）`);
  for (;;) {
    await sweep({ ...ctx, state: await loadState() });
    ctx.routed = 0;
    ctx.warn = 0;
    await new Promise((r) => setTimeout(r, Math.max(10_000, interval)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => die(`入站失败：${e.message}`, 2));
}
