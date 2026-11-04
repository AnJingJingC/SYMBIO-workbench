// tools/route.mjs —— 命令路由：一句话 → 派给哪个场景
//
// 补的是「宿主代理场景」这一环。原来跨场景协作得人先想清楚"这活归谁"，再手打 bus dispatch；
// 现在可以直接说人话，由路由判定目标场景并落派单。
//
// 判定顺序（**先便宜后昂贵，且必须留证据**）：
//   1. 关键词规则（本地、零成本、离线可用）——命中足够强就直接用，不打扰桥
//   2. 免费 AI 桥（要联网 + 站点已登录）——规则判不准时才问，要求返回严格 JSON
//   3. 都不行 → 如实说"判不出来"，**绝不硬猜一个场景派出去**
//
// 用法：
//   node tools/route.mjs "把这篇讲缓存的文章消化成卡片"
//   node tools/route.mjs "帮我调研一下文件总线到底适不适合小团队" --dry
//   node tools/route.mjs "..." --json
//   node tools/route.mjs scenes                 # 看场景清单与各自的关键词
//
// 退出码：0 = 判出来了（并已派单，或 --dry 只判定）；1 = 判不出来；2 = 用法错

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, flag, has, esc, readText, readJson } from './lib/common.mjs';
import { beat } from './lib/heartbeat.mjs';

const execFileP = promisify(execFile);
const SCENES = 'memory/20-scenes';
const SELF = 'route';

// 关键词兜底表。**它是兜底，不是主判据**：中文短句的语义靠词表永远不全（这轮已经吃过
// "枚举不完的占位语"一次亏）。所以阈值定得高——宁可判不出来问桥，也不靠几条词硬猜。
const DEFAULT_KEYWORDS = {
  'knowledge-digest': ['卡片', '消化', '长文', '文章', '整理', '摘要', '笔记', '归档', '落卡', '读书', '字幕', 'pdf'],
  'deep-research': ['调研', '研究', '对比', '比较', '查证', '核实', '分析', '报告', '问题', '为什么', '评估', '选型'],
};
const RULE_MIN_SCORE = 2;   // 命中 2 个以上关键词才算规则可判
const BRIDGE_MIN_CONF = 0.55; // 桥给的置信度低于这个值，视为判不出来

const args = process.argv.slice(2);
const isText = (a) => a && !a.startsWith('--');
const TEXT = args.find(isText) && args[0] !== 'scenes' ? args.find(isText) : '';

/** 读场景清单：id + 名称 + 「我负责什么」前三条。 */
export async function loadScenes({ rootDir = null } = {}) {
  const home = rootDir || root();
  let dirs = [];
  try {
    dirs = (await fs.readdir(path.join(home, SCENES), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const id of dirs) {
    const card = await readText(path.join(home, SCENES, id, '定位卡.md'));
    let title = id;
    let duties = [];
    if (card) {
      const rawTitle = card.match(/^#\s*定位卡\s*[—-]\s*(.+)$/m)?.[1]?.trim() || id;
      // 定位卡标题形如「deep-research（深度调研场景）」：优先用括号里的中文名，
      // 否则 id 会在列表里出现两次（`deep-research　deep-research（…）`），看着像 bug。
      title = rawTitle.match(/[（(]([^（()）]+)[)）]\s*$/)?.[1]?.trim() || rawTitle.replace(new RegExp(`^${id}\\s*`), '');
      const sec = card.match(/##\s*我负责什么\s*\n([\s\S]*?)(?=\n##\s|$)/);
      if (sec) {
        duties = sec[1]
          .split('\n')
          .map((l) => l.replace(/^[-*]\s*/, '').trim())
          .filter((l) => l && !l.startsWith('#'))
          .slice(0, 3);
      }
    }
    out.push({ id, name: title, duties });
  }
  return out;
}

async function keywordsFor(rootDir) {
  const cfg = await readJson(path.join(rootDir, 'config/symbio.config.json'));
  const custom = cfg?.routing?.keywords;
  if (custom && typeof custom === 'object') {
    const merged = { ...DEFAULT_KEYWORDS };
    for (const [k, v] of Object.entries(custom)) {
      if (Array.isArray(v)) merged[k] = v;
    }
    return merged;
  }
  return DEFAULT_KEYWORDS;
}

/** 规则判定：返回 {scene, score, hits} 或 null。 */
export async function routeByKeywords(text, { rootDir = null, scenes = null } = {}) {
  const home = rootDir || root();
  const kw = await keywordsFor(home);
  const list = scenes || (await loadScenes({ rootDir: home }));
  const scores = [];

  for (const s of list) {
    const words = kw[s.id] ?? [];
    const hits = words.filter((w) => text.includes(w));
    scores.push({ scene: s.id, score: hits.length, hits });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  if (!top || top.score < RULE_MIN_SCORE) return null;
  // 并列第一 = 判不出来，别硬选一个（两个场景都命中 2 个词时，选谁是掷硬币）
  if (scores[1] && scores[1].score === top.score) return null;
  return { scene: top.scene, score: top.score, hits: top.hits, scores };
}

async function bridgeHealth(bridgeUrl) {
  try {
    const r = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(2500) });
    const b = await r.json();
    return !!b.ok;
  } catch {
    return false;
  }
}

function promptFor(text, scenes) {
  const lines = scenes.map((s) => `- ${s.id}（${s.name}）：${s.duties.join('；') || '（无描述）'}`).join('\n');
  return [
    '你是任务路由器。判断下面这句话该交给哪个场景处理。',
    '',
    '可用场景：',
    lines,
    '',
    `用户这句话：「${text}` + '」',
    '',
    '只输出一行 JSON，不要解释，不要 markdown 代码块：',
    '{"scene":"<上面某个场景 id，或 none>","confidence":<0到1的小数>,"reason":"<20字以内理由>"}',
  ].join('\n');
}

function pickJson(raw) {
  const s = String(raw ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** 桥判定：失败一律返回 null（调用方据此退化），不抛异常、不编造。 */
export async function routeByBridge(text, { rootDir = null, scenes = null, site = 'doubao', bridgeUrl = null } = {}) {
  const home = rootDir || root();
  const base = String(bridgeUrl || process.env.BRIDGE_URL || 'http://127.0.0.1:31239').replace(/\/+$/, '');
  if (!(await bridgeHealth(base))) return { scene: null, reason: '桥离线', raw: null };

  const list = scenes || (await loadScenes({ rootDir: home }));
  try {
    await beat({ scene: SELF, phase: 'think', detail: '路由判定（问桥）', ttlMs: 120_000, rootDir: home });
    const res = await fetch(`${base}/webai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site, question: promptFor(text, list) }),
      signal: AbortSignal.timeout(150_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { scene: null, reason: `桥返回 ${res.status}：${data.errorType ?? ''}`, raw: null };
    }
    const raw = String(data.answer ?? data.text ?? '');
    const parsed = pickJson(raw);
    if (!parsed) return { scene: null, reason: '桥没给出可解析的 JSON', raw: raw.slice(0, 200) };

    const id = String(parsed.scene ?? '').trim();
    const known = list.some((s) => s.id === id);
    const conf = Number(parsed.confidence ?? 0);
    if (!known) return { scene: null, reason: `桥判定为「${id || '空'}」（不在场景清单里）`, raw };
    if (!(conf >= BRIDGE_MIN_CONF)) return { scene: null, reason: `桥置信度 ${conf} 低于 ${BRIDGE_MIN_CONF}`, raw };
    return { scene: id, confidence: conf, reason: String(parsed.reason ?? ''), raw };
  } catch (e) {
    return { scene: null, reason: `桥调用失败：${e?.message ?? e}`, raw: null };
  }
}

async function dispatch({ from, to, task, accept, rootDir }) {
  const busPath = path.join(rootDir, 'tools', 'bus.mjs');
  try {
    const { stdout } = await execFileP(process.execPath, [busPath, 'dispatch', '--from', from, '--to', to, '--task', task, '--accept', accept], {
      cwd: rootDir, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim());
  } catch (e) {
    try {
      return JSON.parse(String(e.stdout ?? '').trim());
    } catch {
      return { ok: false, errorType: 'bus-failed', message: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

/** 主入口：判定 + （可选）派单。 */
export async function routeText(text, { dry = false, site = 'doubao', rootDir = null, accept = '' } = {}) {
  const home = rootDir || root();
  const scenes = await loadScenes({ rootDir: home });
  if (!scenes.length) {
    return { ok: false, errorType: 'no-scenes', message: `没有可用场景（${SCENES} 下没有含定位卡的目录）` };
  }

  const result = {
    ok: true,
    text,
    scene: null,
    sceneName: null,
    confidence: null,
    reason: '',
    by: null,
    scenes: scenes.map((s) => s.id),
    dispatched: null,
  };

  // ① 规则
  const rule = await routeByKeywords(text, { rootDir: home, scenes });
  if (rule) {
    result.scene = rule.scene;
    result.confidence = Math.min(0.95, 0.5 + rule.score * 0.15);
    result.reason = `命中关键词：${rule.hits.join('、')}`;
    result.by = 'keywords';
  } else {
    // ② 桥
    const br = await routeByBridge(text, { rootDir: home, scenes, site });
    if (br.scene) {
      result.scene = br.scene;
      result.confidence = br.confidence ?? null;
      result.reason = br.reason || '桥判定';
      result.by = 'bridge';
    } else {
      result.reason = br.reason || '判不出来';
      result.by = 'none';
    }
  }

  if (!result.scene) {
    result.ok = false;
    result.errorType = 'unroutable';
    result.message = `判不出该交给谁：${result.reason}。已停止，不硬猜。\n可用场景：${result.scenes.join(' / ')}\n可以直接指定：node tools/bus.mjs dispatch --from <你> --to <场景> --task "..."`;
    return result;
  }

  result.sceneName = scenes.find((s) => s.id === result.scene)?.name ?? result.scene;

  if (!dry) {
    const taskText = text.length > 200 ? text.slice(0, 200) : text;
    result.dispatched = await dispatch({
      from: SELF,
      to: result.scene,
      task: taskText,
      accept: accept || `${result.sceneName} 按自己的定位卡产出；完成后在任务看板回执`,
      rootDir: home,
    });
    if (result.dispatched && result.dispatched.ok === false) result.ok = false;
  } else {
    await beat({ scene: SELF, phase: 'idle', detail: `路由（dry）：${result.scene}`, ttlMs: 20_000, rootDir: home });
  }

  return result;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  if (!TEXT && args[0] !== 'scenes') {
    if (args[0] === 'scenes' || has(args, 'scenes')) {
      const list = await loadScenes();
      const kw = await keywordsFor(root());
      console.log(`场景 ${list.length} 个：\n`);
      for (const s of list) {
        console.log(`· ${s.id}　${s.name}`);
        if (s.duties.length) console.log(`  负责：${s.duties.join('；')}`);
        console.log(`  关键词：${(kw[s.id] ?? []).join('、') || '（未配）'}`);
      }
      return 0;
    }
    console.log(`命令路由：一句话 → 派给哪个场景

  node tools/route.mjs "<一句话>" [--dry] [--json] [--site doubao]
  node tools/route.mjs scenes                     看场景清单与关键词

判定顺序：关键词规则 → 免费 AI 桥 → 判不出来就停（不硬猜）。
--dry 只判定不派单。`);
    return 0;
  }

  if (args[0] === 'scenes') {
    const list = await loadScenes();
    const kw = await keywordsFor(root());
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(list.map((s) => ({ ...s, keywords: kw[s.id] ?? [] })), null, 1)}\n`);
      return 0;
    }
    console.log(`场景 ${list.length} 个：\n`);
    for (const s of list) {
      console.log(`· ${s.id}　${s.name}`);
      if (s.duties.length) console.log(`  负责：${s.duties.join('；')}`);
      console.log(`  关键词：${(kw[s.id] ?? []).join('、') || '（未配）'}`);
    }
    return 0;
  }

  const r = await routeText(TEXT, {
    dry: has(args, 'dry'),
    site: flag(args, 'site') || 'doubao',
    accept: flag(args, 'accept'),
  });

  if (has(args, 'json')) {
    process.stdout.write(`${JSON.stringify(r, null, 1)}\n`);
    return r.ok ? 0 : 1;
  }

  if (!r.ok) {
    console.error(`✗ ${r.message ?? r.reason}`);
    return 1;
  }

  const conf = r.confidence == null ? '' : `（置信度 ${Number(r.confidence).toFixed(2)}）`;
  console.log(`✓ → ${r.scene}（${r.sceneName}）${conf}`);
  console.log(`  判定依据：${r.by === 'keywords' ? '关键词规则' : r.by === 'bridge' ? '免费 AI 桥' : '—'} · ${r.reason}`);
  if (r.dispatched) {
    console.log(`  派单：${r.dispatched.ok ? '已写入任务看板' : '失败'} · ${r.dispatched.message ?? r.dispatched.message ?? ''}`);
    if (r.dispatched.hash) console.log(`  hash：${r.dispatched.hash}（回执时要用）`);
  } else if (has(args, 'dry')) {
    console.log('  （--dry：只判定，未派单）');
  }
  return 0;
}

if (process.argv[1]?.endsWith('route.mjs')) {
  main().then((code) => process.exit(code));
}
