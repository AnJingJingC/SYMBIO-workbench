// 校准批量探针：对同一个站点连续尝试多个候选选择器，输出每个候选的命中数与文本。
// 用途：verified:false 的站点，靠它一次找出"哪个选择器才是正文容器"。
//
// 用法：node cali-candidates.mjs zhipu "sel1" "sel2" ...
// 输出：命中数 + 首/末个节点文本 + 是否含目标关键词

const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:31239';
const [site, ...cands] = process.argv.slice(2);
const HINT = process.env.HINT || '';

if (!site || !cands.length) {
  console.error('用法：node cali-candidates.mjs <site> "sel1" "sel2" ...');
  process.exit(1);
}

for (const sel of cands) {
  const qs = new URLSearchParams({ site, answer: sel });
  let d;
  try {
    const r = await fetch(`${BRIDGE}/webai/probe?${qs}`, { method: 'POST', signal: AbortSignal.timeout(120_000) });
    d = await r.json();
  } catch (e) {
    console.log(`✗ ${sel}\n    探测失败：${e.message}`);
    continue;
  }
  if (!d.ok) {
    console.log(`✗ ${sel}\n    ${d.errorType} ${d.message ?? ''}`);
    continue;
  }
  const n = d.dom?.counts?.answer ?? 0;
  const nodes = d.dom?.answerNodes ?? [];
  const last = nodes[nodes.length - 1];
  const first = nodes[0];
  const brief = (x) => (x ? String(x.text || '').replace(/\s+/g, ' ').slice(0, 46) : '(无)');
  const hitHint = HINT && nodes.some((x) => String(x.text || '').includes(HINT));
  console.log(`${n > 0 ? '✓' : '✗'} 命中 ${n} 个  ${sel}${hitHint ? '   ★含关键字' : ''}`);
  if (n > 0) {
    console.log(`    首：${brief(first)}`);
    if (n > 1) console.log(`    末：${brief(last)}`);
    if (n === 1) console.log(`    内：${brief(first)}`);
  }
}
