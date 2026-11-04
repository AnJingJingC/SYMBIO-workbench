// 轮询桥的 show 接口读登录态（show 复用窗口、不刷新页面，不会打断扫码）
const BRIDGE = 'http://127.0.0.1:31239';
const deadline = Date.now() + 150_000;
let last = '';
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BRIDGE}/webai/show?site=doubao`, { method: 'POST' });
    const d = await r.json();
    const s = `loggedIn=${d.loggedIn} visible=${d.visible}`;
    if (s !== last) { console.log(new Date().toLocaleTimeString('zh-CN'), s); last = s; }
    if (d.loggedIn === true) { console.log('LOGIN_OK'); process.exit(0); }
  } catch (e) {
    console.log('桥暂时不可达：', e.message);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
console.log('TIMEOUT_NOT_LOGGED_IN');
process.exit(1);
