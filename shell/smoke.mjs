// 冒烟验证：真起 HTTP 桥，用 mock 驱动跑通「一问一答」，并逐条验证错误分流/串行/机密闸。
// 它证明的是「桥是通的、契约是成立的」，不证明「豆包选择器是对的」。

import { createDispatcher } from './core/dispatcher.mjs';
import { startBridge } from './core/bridge-server.mjs';
import { createMockDriver } from './drivers/mock.mjs';
import DOUBAO from './sites/doubao.mjs';

const clone = (id) => ({ ...DOUBAO, id, partitionKey: `webai-${id}`, name: `测试站-${id}`, verified: false });

const sites = {};
for (const id of ['t-happy', 't-nologin', 't-stale', 't-silent', 't-nofirst', 't-heal', 't-slow']) {
  sites[id] = clone(id);
}

let healCount = 0;
const plan = {
  't-happy': {},
  't-nologin': { loggedIn: false },
  't-stale': { stale: true },
  't-silent': { silent: true },
  't-nofirst': { noFirstToken: true },
  't-heal': () => ({ answer: '重建后成功', crashOnWait: healCount++ === 0 }),
  't-slow': { delayMs: 120, answer: '慢答' },
};

const rows = [];
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    rows.push(['PASS', name, detail]);
  } else {
    fail += 1;
    rows.push(['FAIL', name, detail]);
  }
}

const driver = createMockDriver({ plan });
const dispatcher = createDispatcher({ sites, driver, log: () => {} });
const bridge = await startBridge({ dispatcher, port: 0 }); // 0 = 随机端口，避免撞车

async function post(body) {
  const r = await fetch(`${bridge.baseUrl}/webai/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

try {
  // 1. 一问一答（真 HTTP 往返）
  const happy = await post({ site: 't-happy', question: '一加一等于几' });
  check('一问一答：HTTP 200 且 ok', happy.status === 200 && happy.json.ok === true, `status=${happy.status}`);
  check(
    '一问一答：答案原样返回（问句确实输入进了页面）',
    typeof happy.json.text === 'string' && happy.json.text.includes('一加一等于几'),
    JSON.stringify(happy.json.text),
  );

  // 2. 健康检查
  const h = await fetch(`${bridge.baseUrl}/health`).then((r) => r.json());
  check('GET /health：桥在线且列出站点', h.ok === true && h.sites.length === Object.keys(sites).length, `sites=${h.sites.length}`);

  // 3. 未登录 → 401 not-logged-in
  const nologin = await post({ site: 't-nologin', question: '你好' });
  check(
    '未登录 → 401 not-logged-in',
    nologin.status === 401 && nologin.json.errorType === 'not-logged-in',
    `status=${nologin.status} type=${nologin.json.errorType}`,
  );

  // 4. 选择器过期 → 500 selector-stale
  const stale = await post({ site: 't-stale', question: '你好' });
  check(
    '选择器过期 → selector-stale',
    stale.status === 500 && stale.json.errorType === 'selector-stale',
    `status=${stale.status} type=${stale.json.errorType}`,
  );

  // 5. 空回答 → empty-answer（不编造）
  const silent = await post({ site: 't-silent', question: '你好' });
  check(
    '空回答 → 502 empty-answer',
    silent.status === 502 && silent.json.errorType === 'empty-answer',
    `status=${silent.status} type=${silent.json.errorType}`,
  );

  // 6. 首帧未出现 → empty-answer
  const nofirst = await post({ site: 't-nofirst', question: '你好' });
  check(
    '首帧未出现 → empty-answer',
    nofirst.status === 502 && nofirst.json.errorType === 'empty-answer',
    `status=${nofirst.status} type=${nofirst.json.errorType}`,
  );

  // 7. 机密闸：手机号被拦，且不回显明文
  const secret = await post({ site: 't-happy', question: '我电话 13800138000，帮我查一下' });
  const leaked = JSON.stringify(secret.json).includes('13800138000');
  check(
    '机密闸：手机号 → 422 secret-blocked',
    secret.status === 422 && secret.json.errorType === 'secret-blocked',
    `status=${secret.status} type=${secret.json.errorType}`,
  );
  check('机密闸：报错里不回显明文', leaked === false);

  // 8. guest 失效自愈：第一次崩，重建后成功
  const heal = await post({ site: 't-heal', question: '自愈测试' });
  check(
    'guest 失效 → 重建一次后成功',
    heal.status === 200 && heal.json.ok === true && heal.json.text === '重建后成功',
    `status=${heal.status} text=${JSON.stringify(heal.json.text)}`,
  );

  // 9. 同站串行：并发两问，峰值并发必须是 1（防串话）
  const before = dispatcher.stats().asked;
  await Promise.all([post({ site: 't-slow', question: '第一问' }), post({ site: 't-slow', question: '第二问' })]);
  check('同站串行：并发两问的峰值并发 = 1', driver.peakConcurrency('t-slow') === 1, `peak=${driver.peakConcurrency('t-slow')}`);
  check('同站串行：两问都完成了', dispatcher.stats().asked - before === 2);

  // 10. 未注册站点 → 404
  const unknownSite = await post({ site: 'nope', question: '你好' });
  check(
    '未注册站点 → 404 unknown-site',
    unknownSite.status === 404 && unknownSite.json.errorType === 'unknown-site',
    `status=${unknownSite.status}`,
  );

  // 11. 空问题 → 400
  const bad = await post({ site: 't-happy', question: '   ' });
  check('空问题 → 400 bad-request', bad.status === 400 && bad.json.errorType === 'bad-request', `status=${bad.status}`);

  // 11b. 伴生模式的登录窗口通道：路由必须存在，且 mock 驱动不支持时如实报错（不假装能开窗）
  const show = await fetch(`${bridge.baseUrl}/webai/show?site=t-happy`, { method: 'POST' });
  const showBody = await show.json();
  check('POST /webai/show：路由存在且如实回报驱动能力', show.status !== 404 && showBody.ok === false, `status=${show.status} type=${showBody.errorType}`);
  const hide = await fetch(`${bridge.baseUrl}/webai/hide?site=t-happy`, { method: 'POST' });
  const hideBody = await hide.json();
  check('POST /webai/hide：未开窗时如实回报', hide.status === 200 && hideBody.ok === true && hideBody.visible === false, `status=${hide.status}`);
  const nope = await fetch(`${bridge.baseUrl}/webai/nope`, { method: 'POST' });
  check('未知路径仍为 404', nope.status === 404, `status=${nope.status}`);

  // 12. 统计口径
  const st = dispatcher.stats();
  check('统计：asked = ok + failed', st.asked === st.ok + st.failed, JSON.stringify(st));
} finally {
  await bridge.close();
  await dispatcher.closeAll();
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
console.log('\n=== SYMBIO 单站桥 · 冒烟验证 ===');
for (const [s, name, detail] of rows) {
  console.log(`${s === 'PASS' ? '✓' : '✗'} ${pad(s, 5)} ${name}${detail ? '   «' + detail + '»' : ''}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
