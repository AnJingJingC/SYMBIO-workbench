// IPC 白名单（唯一真源）—— 正式壳（main.js）与真机自检（selftest.js）都调这里。
// 抽出来的原因：自检曾经自己建窗口却没注册 IPC，导致界面"阶段 未读 / 场景 —"，
// 那是自检缺陷，不是壳缺陷。白名单只有一份，才不会再各说各话。

import { ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

import { listScenarios, getScenario } from './registry.mjs';

const READ_CAP = 8 * 1024; // 契约：只读前 8KB

/**
 * @param {object} opts
 * @param {object} opts.state       主进程共享状态（sites / dispatcher / bridge / win / session …）
 * @param {string} opts.rootDir     工作台根目录（文件与配置读写的边界）
 */
export function registerIpc({ state, rootDir }) {
  const root = path.resolve(rootDir);
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  handle('app:file:list', async (dir = '.') => {
    const target = path.resolve(root, String(dir || '.'));
    if (!target.startsWith(root)) throw new Error('越界路径被拒绝');
    const entries = await fs.readdir(target, { withFileTypes: true });
    const out = [];
    for (const e of entries.slice(0, 200)) {
      if (e.name.startsWith('.git')) continue;
      const full = path.join(target, e.name);
      let size = 0;
      if (e.isFile()) {
        try {
          size = (await fs.stat(full)).size;
        } catch {
          size = 0;
        }
      }
      out.push({ name: e.name, path: path.relative(root, full).split(path.sep).join('/'), dir: e.isDirectory(), size });
    }
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  });

  // 只读前 8KB —— 契约写死，不因为"想看全文"而放宽
  handle('app:file:read', async (p) => {
    const target = path.resolve(root, String(p ?? ''));
    if (!target.startsWith(root)) throw new Error('越界路径被拒绝');
    const fh = await fs.open(target, 'r');
    try {
      const buf = Buffer.alloc(READ_CAP);
      const { bytesRead } = await fh.read(buf, 0, READ_CAP, 0);
      const stat = await fh.stat();
      return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > bytesRead, size: stat.size };
    } finally {
      await fh.close();
    }
  });

  handle('app:session:current', async () => state.session);
  handle('app:session:rotate', async () => {
    state.seq += 1;
    state.session = { id: `sess-local-${state.seq}`, title: `本地会话 ${state.seq}` };
    return state.session;
  });

  // 单一权威：tab 顺序只落 Main
  handle('app:tabs:getOrder', async () => state.tabsOrder);
  handle('app:tabs:setOrder', async (ids) => {
    if (!Array.isArray(ids)) throw new Error('ids 必须是数组');
    const clean = ids.filter((x) => typeof x === 'string' && x.length < 64).slice(0, 50);
    state.tabsOrder = [...new Set(clean)];
    return state.tabsOrder;
  });

  handle('app:scenario:list', async () => listScenarios());
  handle('app:scenario:get', async (id) => getScenario(id));

  // 阶段以 config/symbio.config.json 为唯一真相源，UI 不许自己猜
  handle('app:config:stage', async () => {
    try {
      const raw = await fs.readFile(path.join(root, 'config', 'symbio.config.json'), 'utf8');
      const cfg = JSON.parse(raw);
      return { current: cfg?.stage?.current ?? 'unknown', modules: cfg?.stage?.modules ?? {} };
    } catch {
      return { current: 'unknown', modules: {} };
    }
  });

  handle('app:bridge:sites', async () =>
    Object.values(state.sites).map((s) => ({ id: s.id, name: s.name, verified: !!s.verified, url: s.url })),
  );
  handle('app:bridge:health', async () => ({
    up: !!state.bridge,
    baseUrl: state.bridge?.baseUrl ?? null,
    stats: state.dispatcher?.stats?.() ?? null,
    problems: state.problems,
  }));

  // 桥调用：renderer 只拿结果，永远拿不到网页句柄
  handle('app:bridge:ask', async ({ site, question } = {}) => {
    if (!state.dispatcher) return { ok: false, errorType: 'unknown', message: '桥未就绪' };
    const { status: _drop, ...body } = await state.dispatcher.ask({ site, question });
    return body;
  });

  // 登录：只开窗，不代填。壳绝不碰账号/验证码（红线）
  handle('app:bridge:login', async ({ site } = {}) => {
    if (!state.dispatcher) return { ok: false, errorType: 'unknown', message: '桥未就绪' };
    const { status: _drop, ...body } = await state.dispatcher.showSite(site);
    return body;
  });
  handle('app:bridge:hide', async ({ site } = {}) => {
    if (!state.dispatcher) return { ok: false, errorType: 'unknown', message: '桥未就绪' };
    const { status: _drop, ...body } = await state.dispatcher.hideSite(site);
    return body;
  });
  // 选择器实测：把 verified:false 的选择器校准成真实值
  handle('app:bridge:probe', async ({ site } = {}) => {
    if (!state.dispatcher) return { ok: false, errorType: 'unknown', message: '桥未就绪' };
    const { status: _drop, ...body } = await state.dispatcher.probeSite(site);
    return body;
  });

  handle('app:window:minimize', async () => {
    state.win?.minimize();
    return true;
  });
  handle('app:window:close', async () => {
    state.win?.close();
    return true;
  });
}
