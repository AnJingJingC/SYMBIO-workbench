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
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : '';
};
const capture = flag('capture');
const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';

if (!site) {
  console.error('用法：node probe-site.mjs <siteId> [--capture <png路径>]');
  console.error('      node probe-site.mjs <siteId> --answer "<选择器>"   # 临时试候选，不写回站点');
  console.error('例：node probe-site.mjs deepseek');
  console.error('    node probe-site.mjs deepseek --answer "[class*=markdown]"');
  process.exit(1);
}

const qs = new URLSearchParams({ site });
if (capture) qs.set('capture', capture);
// 临时覆盖：猜错的选择器会让人误判"页面没有回答区"，这里允许现场试候选
for (const k of ['input', 'send', 'answer']) {
  const v = flag(k);
  if (v) qs.set(k, v);
}

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

if (!data.ok) {
  console.error(`\n✗ 探测失败：${data.errorType} ${data.message ?? ''}`);
  process.exit(2);
}

const m = data.matched ?? {};
const dom = data.dom ?? {};

console.log('\n—— 判定 ——');
console.log(`站点：${data.site}　${data.name ?? ''}`);
console.log(`登录态：${data.loggedIn ? '已登录' : '未登录'}`);
console.log(`输入框：${m.input ? '命中' : '未命中'}　发送：${m.send ? '可用' : '未命中'}　回答区：${m.answer ? '命中' : '未命中'}`);
if (dom.counts) console.log(`计数：input=${dom.counts.input} send=${dom.counts.send} answer=${dom.counts.answer}`);
if (data.overridden && Object.values(data.overridden).some(Boolean)) {
  const u = data.selectorsUsed ?? {};
  console.log(`本次覆盖生效：input=${u.inputSel || '(空)'}　answer=${u.answerSel || '(空)'}`);
}
if (data.captureTo || data.captured) console.log(`截图：${data.captured}`);

// 页面承载正文的最内层容器清单。选择器猜错时，靠这张表反推正确答案，
// 而不是把"我猜错了"误读成"这个站没有回答区"。
const blocks = dom.textBlocks ?? [];
if (blocks.length) {
  console.log('\n—— 页面文本块（最内层，按出现顺序）——');
  for (const b of blocks.slice(0, 20)) {
    console.log(`  <${b.tag}> ${b.len}字  cls="${b.cls}"${b.testid ? `  testid="${b.testid}"` : ''}  「${b.text}」`);
  }
}
if (dom.testIds && Object.keys(dom.testIds).length) {
  const top = Object.entries(dom.testIds)
    .slice(0, 12)
    .map(([k, v]) => `${k}(${v})`)
    .join('  ');
  console.log(`\ndata-testid：${top}`);
}
if (dom.bodyHead) console.log(`\n首屏文字：${String(dom.bodyHead).replace(/\s+/g, ' ').slice(0, 140)}`);

console.log(`\n结论：${data.calibrated ? '✓ 校准通过，可回写 verified:true' : '✗ 未通过（先确认已登录；回答区需先真的问过一句再探）'}`);
process.exitCode = data.calibrated ? 0 : 1;
