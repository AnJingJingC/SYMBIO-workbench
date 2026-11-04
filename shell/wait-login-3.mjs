// 轮询 deepseek / zhipu 的登录态（校准前置）。
// 用 /webai/show 读登录态：它复用已开窗口、不刷新页面，因此不会打断扫码。
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';
const TARGETS = ['deepseek', 'zhipu'];
const deadline = Date.now() + Number(process.env.WAIT_MS || 600_000);
const last = {};

const stamp = () => new Date().toLocaleTimeString('zh-CN');

while (Date.now() < deadline) {
  const state = {};
  for (const site of TARGETS) {
    try {
      const r = await fetch(`${BRIDGE}/webai/show?site=${site}`, { method: 'POST' });
      const d = await r.json();
      state[site] = d.loggedIn === true;
    } catch (e) {
      state[site] = null;
    }
  }
  const line = TARGETS.map((s) => `${s}=${state[s] === null ? '不可达' : state[s] ? '已登录' : '未登录'}`).join('  ');
  if (line !== last.line) {
    console.log(`${stamp()}  ${line}`);
    last.line = line;
  }
  if (TARGETS.every((s) => state[s] === true)) {
    console.log('ALL_LOGGED_IN');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 8000));
}
console.log('TIMEOUT_NOT_LOGGED_IN');
process.exit(1);
