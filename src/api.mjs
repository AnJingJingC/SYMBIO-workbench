// SYMBIO 工作台 · 本机接口
// 面板只调自己的 /api/symbio/*；免费 AI 桥由服务端转发（避免渲染层跨域）。
//
// 事实约束：业务数字一律来自 src/state.mjs 的真实文件解析；
// 读不到 → null + issues，接口如实报，不填兜底假值。

import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readState, readHeartbeats } from './state.mjs';
import { listTools, runTool } from './tools.mjs';

export const API_PREFIX = '/api/symbio';
export const DEFAULT_DATA_ROOT = 'E:/SYMBIO';
export const VERSION = '0.5.0';

// 「设计清单」：只用来核对资产是否齐全，不代表当前读到的实时状态。
// 面板上的实时数量一律取 /state 的 assets；数据源不可读时显示「—」并说明原因。
export const EXPECTED_ASSETS = {
  skills: [
    'symbio-intake', 'symbio-pii-guard', 'symbio-memory-write', 'symbio-handoff',
    'symbio-recall', 'symbio-health', 'symbio-dispatch', 'symbio-portrait',
    'symbio-part', 'symbio-evolve',
  ],
  tools: ['pii-scan', 'memory-lint', 'index-build', 'spend-guard', 'model-probe', 'load-gate'],
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

export function createApiRoutes({ bridgeUrl, dataRoot } = {}) {
  const base = String(bridgeUrl || 'http://127.0.0.1:31239').replace(/\/+$/, '');
  const root = String(dataRoot || DEFAULT_DATA_ROOT);

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
          dataSource: source,
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
        let site = 'doubao';
        try { const p = await readJsonBody(request); if (p?.site) site = String(p.site); } catch { /* 默认 doubao */ }
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
        let site = 'doubao';
        try { const p = await readJsonBody(request); if (p?.site) site = String(p.site); } catch { /* 默认 doubao */ }
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
        const site = typeof payload.site === 'string' && payload.site ? payload.site : 'doubao';
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
