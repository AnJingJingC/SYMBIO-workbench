// SYMBIO 工作台 · 本机接口
// 面板只调自己的 /api/symbio/*；免费 AI 桥由服务端转发（避免渲染层跨域）。
//
// 事实约束：业务数字一律来自 src/state.mjs 的真实文件解析；
// 读不到 → null + issues，接口如实报，不填兜底假值。

import { access, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readState, readHeartbeats } from './state.mjs';
import { listTools, runTool, runScript } from './tools.mjs';

export const API_PREFIX = '/api/symbio';
export const DEFAULT_DATA_ROOT = 'E:/SYMBIO';
export const VERSION = '0.5.6';

// 判定"这里是不是一个工作台根"：光有目录不算，得同时有记忆层与工具层。
// 两个都没有的目录（比如 C:/Windows）绝不会被误认成数据根。
const ROOT_MARKERS = ['memory', 'tools'];

function looksLikeWorkbenchRoot(dir) {
  if (!dir) return false;
  try {
    return ROOT_MARKERS.every((marker) => statSync(path.join(dir, marker)).isDirectory());
  } catch {
    return false;
  }
}

/**
 * 解析业务数据根。包本身不带数据，所以**不能**替用户决定盘符。
 * 顺序：环境变量 → 宿主配置 → 包同位目录（仓库布局）→ 历史默认（存在才用）→ 未配置。
 * 返回 source 供面板显示"这些数字是从哪读的"，未配置时面板给的是修复指引而不是一片空表。
 */
export function resolveDataRoot({ envRoot, configRoot, selfDir, legacyRoot = DEFAULT_DATA_ROOT } = {}) {
  const env = typeof envRoot === 'string' ? envRoot.trim() : '';
  if (env) return { root: path.resolve(env), source: 'env' };

  const cfg = typeof configRoot === 'string' ? configRoot.trim() : '';
  if (cfg) return { root: path.resolve(cfg), source: 'config' };

  // 开发/自托管布局：<repo>/workbench/dsh/index.mjs → selfDir 上跳两级即仓库根
  if (selfDir) {
    const guess = path.resolve(selfDir, '..', '..');
    if (looksLikeWorkbenchRoot(guess)) return { root: guess, source: 'sibling' };
  }

  // 历史默认：只在这台机器真的存在时采用，不联网、不猜
  if (looksLikeWorkbenchRoot(legacyRoot)) return { root: legacyRoot, source: 'legacy' };

  return { root: null, source: 'unset' };
}

/** 未配置数据根时给前端的可执行指引（不含任何本机绝对路径猜测）。 */
export const DATA_ROOT_HINT =
  '未找到工作台根目录。请在插件配置里填 dataRoot，或设环境变量 SYMBIO_HOME 指向你的工作台根' +
  '（该目录下应同时有 memory/ 与 tools/）。';

// 「设计清单」：只用来核对资产是否齐全，不代表当前读到的实时状态。
// 面板上的实时数量一律取 /state 的 assets；数据源不可读时显示「—」并说明原因。
export const EXPECTED_ASSETS = {
  skills: [
    'symbio-intake', 'symbio-pii-guard', 'symbio-memory-write', 'symbio-handoff',
    'symbio-recall', 'symbio-health', 'symbio-dispatch', 'symbio-portrait',
    'symbio-part', 'symbio-evolve',
  ],
  // 六道闸 + 0.5.6 的两件：出站红线闸（redline-scan）与投递入站（inbound）。
  // 后两件不走工具箱下拉（入站无输入、红线闸要整段外发文本），各有面板卡片。
  tools: ['pii-scan', 'memory-lint', 'index-build', 'spend-guard', 'model-probe', 'load-gate', 'redline-scan', 'inbound'],
  layers: ['00-constitution', '10-shared', '20-scenes', '30-personal', '90-archive'],
};

export const RED_LINES = [
  '隐私：L1 硬拦截、L2 脱敏，绝不外发',
  '余额：免费优先，预算硬闸，不偷跑付费模型',
  '事实：不确定就说不知道，绝不编造',
  '记忆：落文件不落会话，交接必留痕',
  '自治：不自我提权、不绕过宿主审批',
];

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/** 探测伴生桥。失败只如实报离线，绝不编造在线状态。 */
export async function probeBridge(bridgeUrl) {
  const base = String(bridgeUrl || 'http://127.0.0.1:31239').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return { online: !!body.ok, url: base, sites: body.sites ?? [], stats: body.stats ?? null };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unreachable';
    return { online: false, url: base, sites: [], stats: null, reason };
  }
}

async function probeRoot(root) {
  if (!root) return { root: null, reachable: false, reason: 'unset', hint: DATA_ROOT_HINT };
  try {
    await access(root);
    return { root, reachable: true, reason: null };
  } catch (error) {
    return { root, reachable: false, reason: error?.code ?? String(error?.message ?? '不可达') };
  }
}

/** 兼容宿主传入的 Request：优先标准 .json()，退化到 body reader。 */
export async function readJsonBody(request, maximum = 16 * 1024) {
  if (request && typeof request.json === 'function') {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。');
    return value;
  }
  const reader = request?.body?.getReader?.();
  if (!reader) throw new Error('请求缺少 JSON body。');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value?.byteLength ?? 0;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('请求体过大。');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。');
    return value;
  } catch {
    throw new Error('请求体不是合法 JSON。');
  }
}

/**
 * 待处理的入站来件（只读）。
 *
 * 口径必须与 tools/inbound.mjs 的 listInbound 完全一致，否则面板显示"3 件"、
 * 点扫描却处理 0 件——这种不一致比不显示更坏。所以同样只认：顶层文件、
 * 不以 _ 或 . 开头、扩展名 .md/.txt。
 */
const INBOUND_EXTS = new Set(['.md', '.txt']);

async function listInboundPending(root) {
  const dir = path.resolve(root, 'memory', '50-inbox', '_inbound');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { available: false, reason: error?.code ?? String(error?.message ?? '不可读'), dir, files: [], archived: null };
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('_') && !e.name.startsWith('.') && INBOUND_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
  const countDir = async (name) => {
    try {
      return (await readdir(path.join(dir, name))).filter((n) => !n.startsWith('.')).length;
    } catch {
      return null;
    }
  };
  return {
    available: true,
    dir,
    files,
    archived: {
      routed: await countDir('_routed'),
      unrouted: await countDir('_unrouted'),
      blocked: await countDir('_blocked'),
    },
  };
}

/**
 * 解析脚本吐出的 JSON。
 *
 * 不能只取最后一行：redline-scan 的 --json 是 pretty-print（多行），
 * 取最后一行只会拿到 "}"。先整段解析，失败再截首尾大括号兜底。
 * 两条都失败就返回 null，由调用方按「判不出来」处理，不猜。
 */
function parseScriptJson(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch { /* 继续兜底 */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createApiRoutes({ bridgeUrl, dataRoot, dataRootSource, selfDir, legacyRoot } = {}) {
  const base = String(bridgeUrl || 'http://127.0.0.1:31239').replace(/\/+$/, '');
  // 显式传了根就照用（测试、多实例都靠这条）；没传才探测，绝不默认指向某个盘。
  const resolved = dataRoot
    ? { root: path.resolve(String(dataRoot)), source: dataRootSource || 'config' }
    : resolveDataRoot({ envRoot: process.env.SYMBIO_HOME, configRoot: dataRoot, selfDir, legacyRoot });
  const root = resolved.root;
  const rootSource = resolved.source;

  // 没有根时，所有读接口都不许拿 null 去拼路径（path.join(null) 会直接抛）。
  const missingRoot = () => json({
    ok: false,
    error: 'data-root-unset',
    message: DATA_ROOT_HINT,
    hint: DATA_ROOT_HINT,
    dataSource: { root: null, reachable: false, reason: 'unset', source: 'unset', hint: DATA_ROOT_HINT },
    checkedAt: new Date().toISOString(),
  }, 503);

  // 负载胶囊缓存：load-gate 采样 3 次 × 1.5s ≈ 4.5s，不能让面板每次轮询都跑一遍。
  // 15s 足够"接近实时"，又不会把宿主进程卡住。
  const LOAD_TTL_MS = 15_000;
  let loadCache = { at: 0, value: null };

  return [
    {
      path: `${API_PREFIX}/health`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        const [bridge, source] = await Promise.all([probeBridge(base), probeRoot(root)]);
        return json({
          ok: true,
          workbench: 'SYMBIO',
          codename: '协同进化工作台',
          version: VERSION,
          identity: 'local:symbio-workbench',
          expectedAssets: EXPECTED_ASSETS,
          redLines: RED_LINES,
          dataSource: { ...source, source: rootSource },
          bridge,
          checkedAt: new Date().toISOString(),
        });
      },
    },
    {
      path: `${API_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        if (!root) return missingRoot();
        const state = await readState(root);
        return json({
          ok: true,
          version: VERSION,
          redLines: RED_LINES,
          expectedAssets: EXPECTED_ASSETS,
          state,
        });
      },
    },
    {
      // 亮灯：谁被唤醒、谁在思考、谁在落卡。轮询接口，故意做得很轻（只读几个小 JSON）。
      path: `${API_PREFIX}/activity`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        if (!root) return missingRoot();
        const activity = await readHeartbeats(root);
        return json({
          ok: true,
          available: activity.available,
          reason: activity.reason ?? null,
          active: activity.active ?? [],
          total: activity.beats?.length ?? 0,
          stale: activity.stale ?? 0,
          checkedAt: new Date().toISOString(),
        });
      },
    },
    {
      // 负载胶囊：CPU/内存条的数据源。
      // 复用 tools/run 的严格白名单执行器（execFile 无 shell、60s 超时、输出裁剪），
      // 不在这里另开一条"任意命令"的口子。带 15s 缓存，采样成本不落到每次轮询上。
      path: `${API_PREFIX}/load`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        if (!root) return missingRoot();
        const now = Date.now();
        if (loadCache.value && now - loadCache.at < LOAD_TTL_MS) {
          return json({ ...loadCache.value, cached: true, ageMs: now - loadCache.at });
        }

        const run = await runTool('load-gate', root, { json: true });
        if (!run.ok) {
          return json({ ok: false, errorType: run.errorType ?? 'run-failed', message: run.message ?? '负载闸不可用' }, 200);
        }

        let parsed = null;
        try {
          parsed = JSON.parse(String(run.stdout ?? '').trim().split('\n').pop());
        } catch {
          parsed = null;
        }
        if (!parsed) {
          // 采样失败就说失败，绝不编一个"看起来正常"的假数字
          return json({
            ok: false,
            errorType: 'parse-failed',
            message: '负载闸没有返回可解析的 JSON',
            exitCode: run.exitCode,
            stderr: String(run.stderr ?? '').slice(0, 300),
          });
        }

        const value = {
          ok: true,
          cpu: parsed.cpu ?? null,
          ram: parsed.ram ?? null,
          samples: parsed.samples ?? [],
          verdict: parsed.verdict ?? null,
          exitCode: run.exitCode,
          minOk: parsed.minOk ?? 90,
          minWarn: parsed.minWarn ?? 95,
          cores: parsed.cores ?? null,
          ramUsedMB: parsed.ramUsedMB ?? null,
          ramTotalMB: parsed.ramTotalMB ?? null,
          top: Array.isArray(parsed.topMem) ? parsed.topMem.slice(0, 3) : (parsed.top ?? []).slice(0, 3),
          time: parsed.time ?? null,
          cached: false,
          ageMs: 0,
        };
        loadCache = { at: Date.now(), value };
        return json(value);
      },
    },
    {
      path: `${API_PREFIX}/bridge/health`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        return json(await probeBridge(base));
      },
    },
    {
      // 面板「开登录窗」：把请求转给伴生桥的 /webai/show，由桥把站点窗口显出来手动登录。
      // 桥只开窗 + 如实报登录态，绝不代填账号/验证码、不自动登录。
      path: `${API_PREFIX}/bridge/login`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let site = 'qianwen';
        try { const p = await readJsonBody(request); if (p?.site) site = String(p.site); } catch { /* 默认 qianwen */ }
        try {
          const response = await fetch(`${base}/webai/show?site=${encodeURIComponent(site)}`, { method: 'POST' });
          const body = await response.json();
          return json(body, response.status);
        } catch {
          return json({ ok: false, errorType: 'bridge-unreachable', message: '免费 AI 桥未启动或不可达，无法开窗。' }, 503);
        }
      },
    },
    {
      // 面板「收回窗口」：转给伴生桥的 /webai/hide，登录完成后把站点窗口藏回后台。
      path: `${API_PREFIX}/bridge/hide`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let site = 'qianwen';
        try { const p = await readJsonBody(request); if (p?.site) site = String(p.site); } catch { /* 默认 qianwen */ }
        try {
          const response = await fetch(`${base}/webai/hide?site=${encodeURIComponent(site)}`, { method: 'POST' });
          const body = await response.json();
          return json(body, response.status);
        } catch {
          return json({ ok: false, errorType: 'bridge-unreachable', message: '免费 AI 桥未启动或不可达。' }, 503);
        }
      },
    },
    {
      // 工具箱：列出可在面板内直接运行的 6 个工具（含输入形态、endpoint、example、sideEffects）。
      // 该响应同时是「宿主 Agent / 任意 HTTP 调用方」调用本工具箱的机器可读清单。
      path: `${API_PREFIX}/tools`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        return json({
          ok: true,
          runEndpoint: `${API_PREFIX}/tools/run`,
          invocation: 'POST runEndpoint，body 取某个工具的 example（name 必填，其余字段按需）。返回 { ok, exitCode, stdout, stderr }。',
          tools: listTools(),
        });
      },
    },
    {
      // 工具箱：运行一个工具。name 受白名单约束，参数经净化，无 shell。
      path: `${API_PREFIX}/tools/run`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload;
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          return json({ ok: false, errorType: 'bad-request', message: error?.message ?? '请求体无效' }, 400);
        }
        const name = typeof payload.name === 'string' ? payload.name : '';
        if (!root) return missingRoot();
        const result = await runTool(name, root, {
          input: payload.input,
          scene: payload.scene,
          dir: payload.dir,
          amount: payload.amount,
          redact: payload.redact,
          chain: payload.chain,
          json: payload.json,
        });
        if (!result.ok && (result.errorType === 'unknown-tool' || result.errorType === 'missing')) {
          return json(result, 404);
        }
        return json(result);
      },
    },
    {
      // 面板内「试问一句」：把问题转给伴生桥，由桥的 secret-gate 做机密拦截。
      // 这里不做 PII 判定（规则数据在业务根、且桥已有唯一闸口），只做长度与类型约束。
      path: `${API_PREFIX}/ask`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload;
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          return json({ ok: false, errorType: 'bad-request', message: error?.message ?? '请求体无效' }, 400);
        }
        const site = typeof payload.site === 'string' && payload.site ? payload.site : 'qianwen';
        const question = typeof payload.question === 'string' ? payload.question.trim() : '';
        if (!question) return json({ ok: false, errorType: 'bad-request', message: 'question 为空，未发送任何内容。' }, 400);
        if (question.length > 2000) return json({ ok: false, errorType: 'bad-request', message: 'question 超过 2000 字，未发送任何内容。' }, 400);

        try {
          const response = await fetch(`${base}/webai/ask`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ site, question }),
            signal: AbortSignal.timeout(200000),
          });
          const result = await response.json();
          // 原样保留桥的结果与状态码：失败也如实回，不改写、不编造答案
          return json({ ...result, forwarded: true, bridgeUrl: base }, response.status);
        } catch (error) {
          const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
          return json({
            ok: false,
            errorType: 'bridge-unreachable',
            message: timedOut ? '免费 AI 桥响应超时，未拿到回答。' : '免费 AI 桥未启动或不可达，未发送任何内容。',
          }, 503);
        }
      },
    },
    {
      // 会话衔接（半自动）：读工作台数据根里真实的「当前交接.md」，拼出一段可直接
      // 粘进新对话的衔接提示。宿主没有"程序化新建会话"的 API，所以这里**只产出提示**，
      // 不碰宿主会话、不写文件——新建对话与粘贴由宿主侧人工完成，绝不伪造"一键换对话"。
      path: `${API_PREFIX}/handoff/prepare`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        if (!root) return missingRoot();
        const handoffPath = path.resolve(root, 'memory', '20-scenes', 'knowledge-digest', '当前交接.md');
        let raw;
        try {
          raw = await readFile(handoffPath, 'utf8');
        } catch (error) {
          return json({
            ok: false,
            errorType: 'handoff-unreadable',
            message: `读不到交接文件：${error?.code ?? String(error?.message ?? '未知原因')}`,
            hint: '换会话衔接依赖 memory/20-scenes/knowledge-digest/当前交接.md；请先在该文件写好交接再试。',
          }, 404);
        }
        if (!raw.trim()) {
          return json({ ok: false, errorType: 'handoff-empty', message: '交接文件为空，未生成衔接提示。' }, 422);
        }
        // 交接体积上限：只取 honest 内容，不把整个文件无脑塞进剪贴板。
        const body = raw.trim().slice(0, 8000);
        const prompt = [
          '【SYMBIO 会话衔接】新一轮对话请从这里续上：',
          '',
          '以下是上一轮留下的交接（原文摘录，来自本工作台数据根）：',
          '---',
          body,
          '---',
          '',
          '请先读上面的「当前状态 / 下一步 / 未决问题 / 关键路径」，再从「下一步」继续。',
          '如与事实不符，以文件与对话历史为准，不要照抄旧状态当作现状。',
        ].join('\n');
        return json({
          ok: true,
          prompt,
          chars: prompt.length,
          source: 'memory/20-scenes/knowledge-digest/当前交接.md',
          truncated: raw.trim().length > 8000,
          mode: 'semi-automatic',
          hint: '已生成衔接提示。请人工新建对话后粘贴；本接口不新建/命名/归档任何会话。',
        });
      },
    },
    {
      // 出站红线闸（面板「发送前检查」的后端）。
      // 只判定、不代发：本接口不连任何 IM/邮件，也不把文本发到桥或外网——
      // 它跑的是本机 tools/redline-scan.mjs，纯正则、零网络。
      // 失败一律 fail-closed：脚本缺失 → 503；规则坏（退出码 3）→ verdict=rule-error 且 allowed=false，
      // 让面板显红字"闸坏了先别发"，绝不把判定不出来的情况当成放行。
      path: `${API_PREFIX}/outbound/check`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload;
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          return json({ ok: false, errorType: 'bad-request', message: error?.message ?? '请求体无效' }, 400);
        }
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text.trim()) {
          return json({ ok: false, errorType: 'bad-request', message: 'text 为空，未做任何检查。' }, 400);
        }
        if (text.length > 4000) {
          return json({ ok: false, errorType: 'bad-request', message: 'text 超过 4000 字，请分段检查（本接口不截断，截断会漏判）。' }, 400);
        }
        if (!root) return missingRoot();

        const run = await runScript(root, 'redline-scan.mjs', ['--text', text, '--json'], { timeout: 20000 });
        if (!run.ok) {
          return json({ ok: false, errorType: 'redline-unavailable', message: run.message ?? '红线闸不可用', allowed: false }, 503);
        }

        const parsed = parseScriptJson(run.stdout);
        if (!parsed) {
          // 判不出来就不许放行，也不许假装"已检查通过"
          return json({
            ok: false,
            errorType: 'redline-parse-failed',
            message: '红线闸没有返回可解析结果，按「先别发」处理。',
            allowed: false,
            exitCode: run.exitCode,
            stderr: String(run.stderr ?? '').slice(0, 400),
          });
        }

        const verdict = run.exitCode === 2 ? 'block'
          : run.exitCode === 1 ? 'warn'
            : run.exitCode === 0 ? 'pass'
              : 'rule-error';
        return json({
          ok: true,
          verdict,
          allowed: verdict === 'pass' || verdict === 'warn',
          exitCode: run.exitCode,
          blocked: parsed.blocked ?? 0,
          warned: parsed.warned ?? 0,
          matches: Array.isArray(parsed.matches) ? parsed.matches.slice(0, 12) : [],
          policy: '只检查，不代发。通过后自行复制到目标处；本接口不写文件、不联网。',
          checkedAt: new Date().toISOString(),
        });
      },
    },
    {
      // 入站待处理清单（只读）：面板显示"待处理 N 件"，避免点扫描前一片空白。
      path: `${API_PREFIX}/inbound/pending`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        if (!root) return missingRoot();
        return json({ ok: true, ...(await listInboundPending(root)) });
      },
    },
    {
      // 入站扫描：把 _inbound/ 里的来件按「隐私闸 → 判场景 → 派单 → 归档」处理一轮。
      // 会移动文件、会写任务看板，属显式动作；默认真跑，dry=true 只判定不动文件。
      // 退出码 1 表示"有件需人看"（未路由/被拦），不是接口失败，如实回 warn 数。
      path: `${API_PREFIX}/inbound/scan`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let dry = false;
        try {
          const p = await readJsonBody(request);
          dry = !!p?.dry;
        } catch { /* 空 body 视为真跑 */ }
        if (!root) return missingRoot();

        const args = ['--once', '--json'];
        if (dry) args.push('--dry');
        const run = await runScript(root, 'inbound.mjs', args, { timeout: 120000 });
        if (!run.ok) {
          return json({ ok: false, errorType: 'inbound-unavailable', message: run.message ?? '入站工具不可用' }, 503);
        }

        const parsed = parseScriptJson(run.stdout);
        if (!parsed) {
          return json({
            ok: false,
            errorType: 'inbound-parse-failed',
            message: '入站工具没有返回可解析结果。',
            exitCode: run.exitCode,
            stderr: String(run.stderr ?? '').slice(0, 400),
          });
        }
        return json({
          ok: true,
          dry,
          exitCode: run.exitCode,
          routed: parsed.routed ?? 0,
          warn: parsed.warn ?? 0,
          results: Array.isArray(parsed.results) ? parsed.results.slice(0, 50) : [],
          // 退出码 1 = 有件进了 _unrouted/_blocked，要人看；与"接口坏了"是两回事
          needsAttention: run.exitCode === 1,
          note: run.exitCode === 1
            ? '有来件需人工处置：未路由的在 _unrouted/，隐私命中的在 _blocked/（后者连路由都没走）。'
            : null,
          checkedAt: new Date().toISOString(),
        });
      },
    },
    {
      // 知识摄入的「确定性落卡」入口：只接收已经消化好的卡片正文（body），
      // 由本机 tools/intake.mjs 执行隐私闸(L1 硬拦) → 字数闸(≤cardMaxChars) → 防覆盖写盘 → 重建索引。
      // 消化（LLM）本身不在此处做，由宿主技能 symbio-intake 或免费 AI 桥完成。
      path: `${API_PREFIX}/intake`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload;
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          return json({ ok: false, errorType: 'bad-request', message: error?.message ?? '请求体无效' }, 400);
        }
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (!root) return missingRoot();
        const source = typeof payload.source === 'string' ? payload.source.trim() : '';
        const body = typeof payload.body === 'string' ? payload.body : '';
        if (!body.trim()) {
          if (typeof payload.text === 'string' && payload.text.trim()) {
            return json({
              ok: false, errorType: 'needs-digestion',
              message: 'intake 只接收已消化好的卡片正文（body）。长文消化请交给宿主技能 symbio-intake 或免费 AI 桥，再传入 body。',
            }, 422);
          }
          return json({ ok: false, errorType: 'bad-request', message: 'body 为空：intake 不负责消化，请提供卡片正文。' }, 400);
        }
        try {
          const intakeUrl = pathToFileURL(path.resolve(root, 'tools', 'intake.mjs')).href;
          const mod = await import(intakeUrl);
          const result = await mod.runIntake({ root, title, source, body });
          if (!result.ok) {
            const status = result.errorType === 'over-cap' || result.errorType === 'privacy-block' ? 422 : 400;
            return json(result, status);
          }
          return json({ ok: true, ...result });
        } catch (error) {
          return json({ ok: false, errorType: 'intake-unavailable', message: `摄入模块加载失败：${error?.message ?? error}` }, 503);
        }
      },
    },
  ];
}
