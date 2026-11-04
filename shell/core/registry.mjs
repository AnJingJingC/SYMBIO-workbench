// 注册表 —— 站点薄壳扫描 + 场景 JSON 读取（UI 侧只拿到数据，拿不到权限）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = path.resolve(HERE, '..');
export const SITES_DIR = path.join(SHELL_ROOT, 'sites');
export const SCENARIOS_DIR = path.join(SHELL_ROOT, 'scenarios');

const REQUIRED_SITE_FIELDS = ['id', 'name', 'url', 'inputSel', 'answerSel', 'send', 'loggedIn', 'wait'];

/** 扫描 sites/*.mjs → { id: site }。任一站点缺字段直接报出，不静默跳过。 */
export async function loadSites(dir = SITES_DIR) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sites = {};
  const problems = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const full = path.join(dir, e.name);
    try {
      const mod = await import(pathToFileURL(full).href);
      const site = mod.default;
      const missing = REQUIRED_SITE_FIELDS.filter((k) => site?.[k] === undefined);
      if (missing.length) {
        problems.push(`${e.name} 缺少字段：${missing.join(', ')}`);
        continue;
      }
      if (typeof site.send !== 'function' || typeof site.loggedIn !== 'function') {
        problems.push(`${e.name} 的 send / loggedIn 必须是函数`);
        continue;
      }
      if (sites[site.id]) problems.push(`${e.name} 的 id 与已有站点重复：${site.id}`);
      sites[site.id] = site;
    } catch (err) {
      problems.push(`${e.name} 加载失败：${err.message}`);
    }
  }
  return { sites, problems };
}

export async function listScenarios(dir = SCENARIOS_DIR) {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function getScenario(id, dir = SCENARIOS_DIR) {
  if (!/^[a-z0-9-]+$/i.test(String(id ?? ''))) throw new Error(`非法场景 id：${id}`);
  const full = path.join(dir, `${id}.json`);
  const raw = await fs.readFile(full, 'utf8');
  return JSON.parse(raw);
}
