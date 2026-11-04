// 真机自检（Step 3 真实校验）—— 跑的是真的 Electron，不是 mock。
// 校验五件事：
//   1) 主窗口真能建、renderer 真能加载（截图存证）
//   2) preload 契约在真运行时可用（从 renderer 里回读 app.* 分组）
//   3) 桥 HTTP 真能起、真能走通（/health、404、422 机密闸）
//   4) 站点薄壳真能打开真实网页（豆包），并做真实 DOM 探测（截图存证）
//   5) 把结论写成 report.json，给"能不能进第 4 步"留证据
//
// 不会做的事：不代填账号、不自动登录、不猜选择器。

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadSites } from './core/registry.mjs';
import { createDispatcher } from './core/dispatcher.mjs';
import { startBridge } from './core/bridge-server.mjs';
import { createElectronDriver } from './drivers/electron-webview.mjs';
import { registerIpc } from './core/ipc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '_selftest');
const PORT = 31249; // 与正式 31239 错开，避免和正在跑的壳抢端口
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  kind: 'symbio-shell-selftest',
  startedAt: new Date().toISOString(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  steps: [],
  ok: false,
};

function step(name, ok, detail, opts = {}) {
  const warn = !ok && !!opts.warn;
  report.steps.push({ name, ok, warn, detail });
  const tag = ok ? 'PASS' : warn ? 'WAIT' : 'FAIL';
  console.log(`[selftest] ${tag} ${name}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  return ok;
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function run() {
  await fs.mkdir(OUT, { recursive: true });

  // ---------- 1. 站点薄壳加载 ----------
  const loaded = await loadSites();
  const siteIds = Object.keys(loaded.sites);
  step('站点薄壳加载', siteIds.length > 0 && loaded.problems.length === 0, {
    sites: siteIds,
    problems: loaded.problems,
  });

  // ---------- 2. 桥 + 真驱动 ----------
  const driver = createElectronDriver({ log: () => {} });
  const dispatcher = createDispatcher({ sites: loaded.sites, driver });
  let bridge = null;
  try {
    bridge = await startBridge({ dispatcher, port: PORT });
    step('桥服务启动', true, bridge.baseUrl);
  } catch (e) {
    step('桥服务启动', false, e?.message ?? String(e));
  }

  // ---------- 3. 主窗口 + renderer 真实加载 ----------
  // 关键：自检必须注册**同一份** IPC 白名单，否则界面拿不到 stage/session/scenario，
  // 会渲染成"阶段 未读 / 场景 —"——那是自检的假象，不是壳的缺陷。
  const state = {
    sites: loaded.sites,
    problems: loaded.problems,
    dispatcher,
    bridge,
    win: null,
    tabsOrder: [],
    session: { id: 'sess-selftest-1', title: '自检会话' },
    seq: 1,
  };
  registerIpc({ state, rootDir: path.resolve(HERE, '..') });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b1020',
    title: 'SYMBIO Shell · selftest',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let rendererErr = null;
  // Electron 45 起 console-message 改传事件对象，旧的三参形式已弃用——两种都兼容
  win.webContents.on('console-message', (e, level, message) => {
    const lv = typeof level === 'number' ? level : e?.level;
    const msg = typeof message === 'string' ? message : e?.message;
    const isErr = lv === 'error' || lv === 3 || lv === 2;
    if (isErr && msg) rendererErr = `${rendererErr ?? ''}${msg}\n`;
  });
  state.win = win;
  await win.loadFile(path.join(HERE, 'renderer', 'index.html'));
  await sleep(1500); // 等 renderer.js 的 async init 跑完

  const mainShot = path.join(OUT, 'main-window.png');
  await fs.writeFile(mainShot, (await win.webContents.capturePage()).toPNG());
  const st = await fs.stat(mainShot).catch(() => ({ size: 0 }));
  // 字节数是弱判据（深色 UI 压得很小）；真正的判据是下面"界面有真实内容"那一项
  step('主窗口截图已生成', st.size > 5000, { file: mainShot, bytes: st.size });

  // renderer 侧真实契约回读：preload 到底暴没暴露
  const exposed = await win.webContents
    .executeJavaScript(
      `(() => {
         const g = window.app || {};
         const out = {};
         for (const k of Object.keys(g)) out[k] = Object.keys(g[k] || {});
         return { groups: out, hasRequire: typeof window.require, hasProcess: typeof window.process };
       })()`,
    )
    .catch((e) => ({ error: String(e?.message ?? e) }));
  const hasBridgeAsk = Array.isArray(exposed?.groups?.bridge) && exposed.groups.bridge.includes('ask');
  step('preload 契约真运行时可用', !!hasBridgeAsk, exposed);

  // 渲染出来的文字（防白屏：截图有像素不等于界面有内容）
  const uiText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 400)').catch(() => '');
  step('界面有真实内容（非白屏）', typeof uiText === 'string' && uiText.trim().length > 10, {
    chars: (uiText || '').trim().length,
    head: (uiText || '').trim().slice(0, 80),
  });
  // 阶段/场景必须来自真配置，不能是"未读 / —"（那说明 IPC 或配置读取断了）
  const stageOk = /阶段\s*(A|AB|ABC)/.test(uiText || '');
  const sceneOk = !/场景\s*—/.test(uiText || '');
  step('阶段与场景从真配置读到', stageOk && sceneOk, {
    stage: (uiText || '').match(/阶段\s*(\S+)/)?.[1] ?? null,
    scenesLine: (uiText || '').match(/场景[^\n]*/)?.[0] ?? null,
    rendererErr,
  });

  // ---------- 4. 桥 HTTP 真往返 ----------
  if (bridge) {
    const health = await httpJson(`${bridge.baseUrl}/health`).catch((e) => ({ status: 0, body: { err: String(e) } }));
    step('桥 GET /health', health.status === 200 && health.body?.ok === true, { status: health.status, sites: health.body?.sites });

    const unknown = await httpJson(`${bridge.baseUrl}/webai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site: '__nope__', question: 'hi' }),
    }).catch((e) => ({ status: 0, body: { err: String(e) } }));
    step('桥错误分流：未注册站 → 404', unknown.status === 404 && unknown.body?.errorType === 'unknown-site', unknown);

    const secret = await httpJson(`${bridge.baseUrl}/webai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site: 'doubao', question: '帮我查身份证 110101199003074567' }),
    }).catch((e) => ({ status: 0, body: { err: String(e) } }));
    const noLeak = !JSON.stringify(secret.body ?? {}).includes('110101199003074567');
    step('桥机密闸：L1 → 422 且不回显明文', secret.status === 422 && noLeak, secret);
  }

  // ---------- 5. 真实站点 DOM 探测 ----------
  const probeShot = path.join(OUT, 'doubao-page.png');
  const probe = await dispatcher.probeSite('doubao', { captureTo: probeShot });
  if (probe?.ok) {
    step('真实站点可驱动 + DOM 已探测', true, {
      url: probe.dom?.url,
      title: probe.dom?.title,
      loggedIn: probe.loggedIn,
      hydration: probe.hydration,
      domStats: probe.dom?.domStats,
      lightCounts: probe.dom?.lightCounts,
      deepCounts: probe.dom?.counts,
      matched: probe.matched,
      calibrated: probe.calibrated,
      inputCandidates: probe.dom?.candidates?.contenteditable?.length ?? 0,
      textareaCandidates: probe.dom?.candidates?.textarea?.length ?? 0,
      buttonCandidates: probe.dom?.candidates?.sendButtons?.length ?? 0,
      bodyLen: probe.dom?.bodyLen,
    });
    const ps = await fs.stat(probeShot).catch(() => ({ size: 0 }));
    step('站点页面截图', ps.size > 5000, { file: probeShot, bytes: ps.size });
  } else {
    step('真实站点可驱动 + DOM 已探测', false, probe);
  }

  // ---------- 5b. 真一问一答（Step 3 的核心目标） ----------
  // 两轮：第一轮验最短闭环；第二轮验"已有历史时仍只取新回答"（多轮不能拿到上一轮的旧答）
  const QUESTIONS = ['请只回复两个字：收到', '推荐一本适合入门的书'];
  const askResults = [];
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    const q = QUESTIONS[i];
    const t1 = Date.now();
    const r = await dispatcher.ask({ site: 'doubao', question: q });
    askResults.push({ q, ms: Date.now() - t1, ...r });
    step(
      `真实一问一答 第${i + 1}轮`,
      !!r.ok,
      {
        q,
        ok: r.ok,
        errorType: r.errorType,
        ms: Date.now() - t1,
        chars: r.chars,
        warnings: r.warnings,
        textHead: (r.text ?? '').slice(0, 160),
        message: r.message,
      },
      // 匿名额度用尽 → 豆包要求登录。这是可预期的前置条件，不是桥的缺陷
      { warn: r.errorType === 'not-logged-in' },
    );
  }

  // 问完再截一张：肉眼确认"回答真的出现在页面上"
  const afterShot = path.join(OUT, 'doubao-after-ask.png');
  const after = await dispatcher.probeSite('doubao', { captureTo: afterShot, keepVisible: false });
  if (after?.ok) {
    report.afterAsk = after; // 存全量结构：用来校准"助手气泡 vs 用户气泡"
    step('提问后页面已截图', true, {
      file: afterShot,
      answerMatched: after.matched?.answer,
      loggedIn: after.loggedIn,
    });
  }

  // ---------- 6. 收尾 ----------
  await dispatcher.closeAll().catch(() => {});
  if (bridge) await bridge.close().catch(() => {});

  report.probe = probe;
  report.asks = askResults;
  report.exposedGroups = exposed?.groups ?? null;
  report.failed = report.steps.filter((s) => !s.ok && !s.warn).length;
  report.waiting = report.steps.filter((s) => s.warn).length;
  report.ok = report.failed === 0;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(
    `\n[selftest] 结果：${report.ok ? '无失败项' : `${report.failed} 项未通过`}｜通过 ${report.steps.filter((s) => s.ok).length}｜待宿主处理 ${report.waiting}｜共 ${report.steps.length} 项`,
  );
  report.steps
    .filter((s) => s.warn)
    .forEach((s) => console.log(`[selftest] 待处理：${s.name} —— 需要你手动登录一次该站，然后重跑 npm run selftest`));
  console.log(`[selftest] 报告：${path.join(OUT, 'report.json')}`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await run();
    code = report.ok ? 0 : 1;
  } catch (e) {
    console.error('[selftest] 崩溃：', e);
    try {
      report.error = String(e?.stack ?? e);
      await fs.mkdir(OUT, { recursive: true });
      await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    } catch {
      /* 报告都写不出就只能靠 stdout */
    }
    code = 2;
  }
  app.exit(code);
});
