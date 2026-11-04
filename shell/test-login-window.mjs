// 真机点测：桥窗口登录（/webai/show · /webai/hide · 登录态自检）
//
// 目的：验证「匿名额度耗尽后，桥能把站点窗口显出来让用户手动登录，且绝不代填账号/验证码」。
// 前置：本机已 `npm run bridge`（或 `node launch.mjs --bridge-only`）把伴生桥跑起来。
// 注意：本脚本不替你登录，也不自动填任何东西——它只负责开窗、读登录态、等你手动登录、再验问答。
//
// 用法：
//   node shell/test-login-window.mjs                # 默认 doubao，桥在 127.0.0.1:31239
//   BRIDGE_URL=http://127.0.0.1:31239 node shell/test-login-window.mjs
//   SITE=tongyi node shell/test-login-window.mjs
//
// 退出码：0 = 全部通过；非 0 = 有未过关项（看 stderr）。

import process from 'node:process';

const BASE = (process.env.BRIDGE_URL || 'http://127.0.0.1:31239').replace(/\/+$/, '');
const SITE = process.env.SITE || 'doubao';
const ASK = '只回答四个字：收到收到';
const POLL_MS = 5000;
const POLL_CAP_MS = 150000; // 最多等 150s 让你手动登录

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('→', ...a);

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(path) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`); failed += 1; }
}

async function main() {
  log(`桥 ${BASE} · 站点 ${SITE}`);

  // 1) 桥在线
  const health = await get('/health');
  check('桥服务在线 (/health)', health.ok && health.body?.ok, `sites=${JSON.stringify(health.body?.sites || [])}`);
  if (health.status !== 200 || !health.body?.ok) {
    console.error('\n桥没起来：先 `cd E:/SYMBIO/shell && npm run bridge`，再跑本脚本。');
    process.exit(2);
  }

  // 2) 开窗 + 读登录态
  log('开窗（POST /webai/show）…');
  let shown = await post(`/webai/show?site=${encodeURIComponent(SITE)}`);
  check('开窗成功', shown.status === 200 && shown.body?.ok, `visible=${shown.body?.visible}`);
  check('契约字段存在', !!shown.body?.contract, shown.body?.contract || '');
  if (!shown.body?.ok) {
    console.error('\n开窗失败：', shown.body?.message || `HTTP ${shown.status}`);
    process.exit(2);
  }

  // 3) 登录态自检：若未登录，轮询等你在窗口里手动登录（绝不代填）
  let login = shown.body;
  if (login.loginRequired) {
    log(`该站未登录。请在弹出的 ${SITE} 窗口里手动登录（我们不代填、不自动登录）。`);
    log(`轮询登录态，最多等 ${POLL_CAP_MS / 1000}s，登录后会自动继续…`);
    const t0 = Date.now();
    while (Date.now() - t0 < POLL_CAP_MS) {
      await sleep(POLL_MS);
      const p = await post(`/webai/show?site=${encodeURIComponent(SITE)}`); // 已显示的窗口重复调用幂等，只重读登录态
      login = p.body || login;
      if (login.loggedIn) { log('检测到已登录。'); break; }
      process.stderr.write('.');
    }
    process.stderr.write('\n');
  }
  check('登录态已满足（已登录或未要求登录）', !login.loginRequired || login.loggedIn,
    login.loginRequired ? '超时仍未登录——请确认窗口里是否完成登录' : '已登录');

  // 4) 登录后问答应成功（确认窗口确实可用）
  log(`发一句短问「${ASK}」验证问答链路…`);
  const ask = await post(`/webai/ask?site=${encodeURIComponent(SITE)}&question=${encodeURIComponent(ASK)}`);
  // /webai/ask 用 JSON body；上面用 query 兜底，若桥只认 body 则改用 body
  let askBody;
  if (!ask.body?.ok) {
    const r2 = await fetch(`${BASE}/webai/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site: SITE, question: ASK }),
    });
    askBody = { status: r2.status, body: await r2.json().catch(() => null) };
  } else {
    askBody = ask;
  }
  check('登录后问答成功', askBody.status === 200 && askBody.body?.ok, `chars=${askBody.body?.chars ?? '-'}`);
  if (askBody.body?.text) console.log('    回答前 60 字：', String(askBody.body.text).slice(0, 60).replace(/\s+/g, ' '));

  // 5) 收回窗口
  log('收回窗口（POST /webai/hide）…');
  const hidden = await post(`/webai/hide?site=${encodeURIComponent(SITE)}`);
  check('收回成功', hidden.status === 200 && hidden.body?.ok, hidden.body?.message || '');

  console.log('\n' + (failed ? `⚠ ${failed} 项未通过` : '✓ 全部通过：开窗 / 登录态自检 / 登录后问答 / 收回 都正常'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('点测异常：', e?.message || e); process.exit(2); });
