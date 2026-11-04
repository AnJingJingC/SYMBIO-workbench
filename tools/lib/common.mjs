// tools/lib/common.mjs —— 工具的公共零件（不是工具本身：tools/lib/ 不在面板工具清单里）
//
// 为什么单独抽出来：shared-skill / parts / project / route / heartbeat 五个新工具
// 都要做同一件事——定位根目录、解析 --flag、生成时间戳、安全读写 JSON、转义表格单元格。
// 复制五遍等于五份口径，迟早不一致（本项目已经吃过「VERSION 常量没同步」的亏）。

import fs from 'node:fs/promises';
import path from 'node:path';

/** 业务数据根。测试用 SYMBIO_HOME 指到临时目录，绝不写真实记忆。 */
export function root() {
  return process.env.SYMBIO_HOME || 'E:/SYMBIO';
}

/** 解析 `--name value` 形式的参数；后跟另一个 -- 或结尾时返回空串。 */
export function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return '';
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

/** 布尔开关：`--force` 只要出现就算 true。 */
export function has(args, name) {
  return args.includes(`--${name}`);
}

export function nowStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`,
    iso: date.toISOString(),
  };
}

/** 表格单元格转义：竖线会把表格切坏，换行会把行切断。 */
export function esc(s) {
  return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

/** 文件名安全化：中文保序，只替换路径分隔符与 Windows 非法字符。 */
export function slug(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 写 JSON 用临时文件 + rename：中途崩了也不会留下半个文件。 */
export async function writeJsonAtomic(p, value) {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

export async function readText(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 两段文本是否实质相同（忽略行尾 CR 与首尾空白），用于防覆盖判断。 */
export function sameText(a, b) {
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b);
}

/**
 * 解析 SKILL.md 的 front matter（只认顶部的 --- ... ---）。
 * 不引 yaml 依赖：这里只需要 name/description/metadata.stage 这几个扁平字段。
 */
export function frontMatter(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
