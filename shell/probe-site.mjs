// probe-site.mjs —— 站点选择器实测（校准用 CLI）
//
// 用途：sites/*.mjs 里 verified:false 的站点，靠这条命令拿真机 DOM 命中情况。
// 前置：桥必须在跑（cd E:/SYMBIO/shell && npm run bridge），且该站已手动登录。
//
// 用法：
//   node probe-site.mjs deepseek
//   node probe-site.mjs qianwen --capture E:/SYMBIO/shell/_selftest/qianwen.png
//
// 判定：
//   calibrated:true  → 三个选择器都真实命中且已登录，可回写 verified:true
//   matched.answer:false → 常见于"没问过就没有回答区"，先手动问一句再探
//   窗口会短暂显示（截图需要），探测完自动收回。

const args = process.argv.slice(2);
const site = args[0];
const captureIdx = args.indexOf('--capture');
const capture = captureIdx >= 0 ? args[captureIdx + 1] : '';
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';

if (!site) {
  console.error('用法：node probe-site.mjs <siteId> [--capture <png路径>]');
  console.error('例：node probe-site.mjs deepseek');
  process.exit(1);
}

const qs = new URLSearchParams({ site });
if (capture) qs.set('capture', capture);

let res;
try {
  res = await fetch(`${BRIDGE}/webai/probe?${qs}`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
  });
} catch (e) {
  console.error(`桥不可达（${BRIDGE}）：${e.message}\n先启动桥：cd E:/SYMBIO/shell && npm run bridge`);
  process.exit(2);
}

const data = await res.json().catch(() => ({}));
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  console.error(`\n✗ 探测失败：${data.errorType} ${data.message ?? ''}`);
  process.exit(2);
}

const m = data.matched ?? {};
console.log('\n—— 判定 ——');
console.log(`登录态：${data.loggedIn ? '已登录' : '未登录'}`);
console.log(`输入框：${m.input ? '命中' : '未命中'}　发送：${m.send ? '可用' : '未命中'}　回答区：${m.answer ? '命中' : '未命中'}`);
console.log(`结论：${data.calibrated ? '✓ 校准通过，可回写 verified:true' : '✗ 未通过（先确认已登录；回答区需先手动问一句再探）'}`);
process.exitCode = data.calibrated ? 0 : 1;
