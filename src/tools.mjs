// SYMBIO 工作台 · 工具运行器（服务端）
//
// 安全边界（写死的，不靠调用方自觉）：
//   · 只允许清单里的 6 个文件，绝不允许任意命令或路径穿越。
//   · 用 execFile（无 shell），参数以数组传递，不做字符串拼接。
//   · 用户输入经 safeStr 剔除换行与 shell 元字符；数额只认数字。
//   · 运行在 dataRoot 下，超时 60s，输出裁剪到 10K。
//   · 不写任何文件；spend-guard 的 --record 是用户在自己台账上记账，属预期能力。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stat } from 'node:fs/promises';

const execFileP = promisify(execFile);

// 统一的宿主 Agent / 面板调用面：每个工具都给出「怎么调」(endpoint+example) 与「会不会写文件」(sideEffects)。
// intake 是内部 Worker，不入册（见 src/state.mjs 的工具计数排除）。
export const TOOL_RUN_ENDPOINT = '/api/symbio/tools/run';

export const TOOL_REGISTRY = {
  'pii-scan': {
    title: '隐私扫描',
    desc: '检测文本里的隐私（PII），命中 L1 即 BLOCK（退出码 2）。绝不联网。',
    input: 'text',
    flags: ['redact'],
    jsonCapable: true,
    hint: '把待检文本贴进输入框，或留空直接跑 --stdin 占位。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'pii-scan', text: '待检文本', redact: false, json: true },
    sideEffects: 'read-only',
  },
  'memory-lint': {
    title: '记忆体检',
    desc: '扫描记忆层，按 FAIL / WARN / PASS 分级。退出码 1 = 有 FAIL。',
    input: 'scene',
    flags: [],
    jsonCapable: true,
    hint: '可选填场景名（如 knowledge-digest），留空扫全部。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'memory-lint', scene: 'knowledge-digest', json: true },
    sideEffects: 'read-only',
  },
  'index-build': {
    title: '索引生成',
    desc: '扫描指定目录的 .md，抽取「标题 + 一句话 + 标签」生成索引。',
    input: 'dir',
    flags: [],
    jsonCapable: false,
    hint: '可选填目录（相对 dataRoot），留空用默认卡片目录。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'index-build', dir: 'memory/20-scenes/knowledge-digest/cards' },
    sideEffects: 'writes <dir>/索引.md',
  },
  'spend-guard': {
    title: '预算硬闸',
    desc: '付费前判定 GO / CAUTION / STOP；退出码 2 = STOP（必须中止）。',
    input: 'amount',
    flags: [],
    jsonCapable: true,
    hint: '留空=只读判定；填数额(¥)则记一笔到今日台账。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'spend-guard', amount: 0.5, json: true },
    sideEffects: 'reads ledger; writes ledger only when amount/--record given',
  },
  'model-probe': {
    title: '免费模型探针',
    desc: '列出活着的免费模型与「免费优先」兜底链。退出码恒 0。',
    input: 'none',
    flags: ['chain'],
    jsonCapable: true,
    hint: '可选 --json / --chain。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'model-probe', chain: true, json: true },
    sideEffects: 'read-only',
  },
  'load-gate': {
    title: '负载闸',
    desc: 'CPU/内存过高时禁止派活。退出码 0=可派单 / 10=停止 / 20=停重活。',
    input: 'none',
    flags: [],
    jsonCapable: true,
    hint: '直接运行，约 3~4s。',
    endpoint: `POST ${TOOL_RUN_ENDPOINT}`,
    example: { name: 'load-gate', json: true },
    sideEffects: 'read-only',
  },
};

export function listTools() {
  return Object.entries(TOOL_REGISTRY).map(([name, t]) => ({
    name,
    title: t.title,
    desc: t.desc,
    input: t.input,
    flags: t.flags,
    jsonCapable: t.jsonCapable,
    hint: t.hint,
    endpoint: t.endpoint,
    example: t.example,
    sideEffects: t.sideEffects,
  }));
}

function safeStr(v) {
  return String(v ?? '').replace(/[\r\n;|&`$()<>]/g, '').slice(0, 2000);
}

function buildArgs(name, tool, opts) {
  const args = [];
  switch (name) {
    case 'pii-scan':
      if (opts.input && String(opts.input).trim()) args.push('--text', String(opts.input).slice(0, 4000));
      if (opts.redact) args.push('--redact');
      break;
    case 'memory-lint':
      if (opts.scene && String(opts.scene).trim()) args.push('--scene', safeStr(opts.scene));
      break;
    case 'index-build':
      if (opts.dir && String(opts.dir).trim()) args.push('--dir', safeStr(opts.dir));
      break;
    case 'spend-guard':
      if (opts.amount !== undefined && opts.amount !== '' && !Number.isNaN(Number(opts.amount))) {
        args.push('--record', String(Number(opts.amount)));
      }
      break;
    case 'model-probe':
      if (opts.chain) args.push('--chain');
      break;
  }
  if (opts.json && tool.jsonCapable) args.push('--json');
  return args;
}

function cap(s, limit = 10000) {
  if (!s) return '';
  s = String(s);
  return s.length > limit ? s.slice(0, limit) + '\n…(输出过长已截断)' : s;
}

export async function runTool(name, dataRoot, opts = {}) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { ok: false, errorType: 'unknown-tool', message: `未知工具：${name}` };

  const toolPath = path.resolve(dataRoot, 'tools', `${name}.mjs`);
  try {
    await stat(toolPath);
  } catch {
    return { ok: false, errorType: 'missing', message: `工具文件不存在：${name}.mjs（dataRoot=${dataRoot}）` };
  }

  const args = buildArgs(name, tool, {
    input: opts.input,
    scene: opts.scene,
    dir: opts.dir,
    amount: opts.amount,
    redact: !!opts.redact,
    chain: !!opts.chain,
    json: !!opts.json,
  });

  try {
    const { stdout, stderr } = await execFileP('node', [toolPath, ...args], {
      cwd: dataRoot,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, exitCode: 0, stdout: cap(stdout), stderr: cap(stderr) };
  } catch (e) {
    // execFile 在退出码非 0 时也走这里：e.code 是退出码
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    const timedOut = e.killed || e.signal === 'SIGTERM';
    return {
      ok: true,
      exitCode,
      stdout: cap(e.stdout || ''),
      stderr: cap(e.stderr || ''),
      timedOut,
      message: timedOut ? '工具执行超时（>60s）' : undefined,
    };
  }
}
