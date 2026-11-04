// ① Main 进程 —— 能力与权威：窗口/标签、文件(只读 8KB)、会话、桥服务、IPC 路由
// 依赖方向：Main 不 import renderer，也不 import 任何 UI 代码。
// IPC 白名单在 core/ipc.mjs（唯一真源），与真机自检共用同一份。

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSites } from './core/registry.mjs';
import { createDispatcher } from './core/dispatcher.mjs';
import { startBridge } from './core/bridge-server.mjs';
import { createElectronDriver } from './drivers/electron-webview.mjs';
import { registerIpc } from './core/ipc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_PORT = 31239;

// 伴生模式：只跑桥（HTTP + 隐藏网页窗口），不建任何 UI。
// 用途：把作品挂到别人的 DSH Desktop（如 dataelement/dsh-desktop）时，
// 宿主负责 GUI，本进程只做「免费网页 AI 桥」守护进程，双方互不侵入。
const BRIDGE_ONLY = process.argv.includes('--bridge-only');

/** @type {{sites:Record<string,object>, dispatcher:any, bridge:any, win:BrowserWindow|null}} */
const state = {
  sites: {},
  problems: [],
  dispatcher: null,
  bridge: null,
  win: null,
  tabsOrder: [],
  session: { id: 'sess-local-1', title: '本地会话' },
  seq: 1,
};

const log = (ev) => console.log('[symbio-shell]', JSON.stringify(ev));

// ---------- 单实例锁：防多开抢桥端口 ----------
// 伴生模式下不抢锁：宿主可能同时开着正式壳，抢锁会误判成"已有一份在跑"而退出。
// 真正的互斥由桥端口（31239）保证 —— 端口被占会有明确日志。
const hasLock = BRIDGE_ONLY ? true : app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.win) {
      if (state.win.isMinimized()) state.win.restore();
      state.win.focus();
    }
  });
  app.whenReady().then(boot).catch((e) => {
    console.error('[symbio-shell] 启动失败：', e);
    app.quit();
  });
}

async function boot() {
  // 站点薄壳 + 桥
  const loaded = await loadSites();
  state.sites = loaded.sites;
  state.problems = loaded.problems;
  if (loaded.problems.length) console.warn('[symbio-shell] 站点薄壳问题：', loaded.problems);

  const driver = createElectronDriver({ log });
  state.dispatcher = createDispatcher({ sites: state.sites, driver, log });

  // 端口占用时顺延 3 次（同机可能有别的服务）
  let lastErr;
  for (let i = 0; i < 3; i += 1) {
    try {
      state.bridge = await startBridge({ dispatcher: state.dispatcher, port: BRIDGE_PORT + i });
      break;
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EADDRINUSE') break;
    }
  }
  if (!state.bridge) {
    console.error('[symbio-shell] 桥服务启动失败：', lastErr?.message ?? lastErr);
    if (BRIDGE_ONLY) {
      // 伴生模式没有界面可回退，端口被占就等于没启动，直接非零退出让宿主看见
      process.exitCode = 1;
      app.quit();
      return;
    }
  } else {
    log({ level: 'info', msg: 'bridge up', baseUrl: state.bridge.baseUrl, sites: Object.keys(state.sites), mode: BRIDGE_ONLY ? 'bridge-only' : 'full' });
  }

  if (BRIDGE_ONLY) {
    // 无 UI：macOS 上也不要在 Dock 里留图标
    if (app.dock?.hide) app.dock.hide();
    log({ level: 'info', msg: 'bridge-only ready', note: '无窗口模式，供外部 DSH Desktop 挂载' });
    return;
  }

  registerIpc({ state, rootDir: ROOT });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b1020',
    title: 'SYMBIO Shell',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true, // 硬约束：隔离
      nodeIntegration: false, // 硬约束：renderer 无 Node
      sandbox: true,
      webSecurity: true,
    },
  });

  state.win = win;
  win.loadFile(path.join(HERE, 'renderer', 'index.html'));

  // 外链一律交给系统浏览器，壳内不导航出去
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.on('closed', () => {
    state.win = null;
  });
}

app.on('window-all-closed', () => {
  if (BRIDGE_ONLY) return; // 伴生模式没有 UI，窗口全没也不该退出
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try {
    await state.dispatcher?.closeAll?.();
    await state.bridge?.close?.();
  } catch {
    /* 退出时的清理失败不阻塞退出 */
  }
});
