// 契约一致性校验（无需 Electron）：三文件之间的白名单必须严丝合缝。
// 检查三件事：
//   1) preload 暴露的每个 channel，main 都必须 handle
//   2) main handle 的每个 channel，preload 都必须用得上（防死接口）
//   3) renderer 调用的每一个 app.<组>.<方法>，preload 都必须真暴露

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const preload = read('preload.cjs');
// IPC 白名单已抽到 core/ipc.mjs（唯一真源），main.js 只是调用方
const main = read('main.js') + '\n' + read('core/ipc.mjs');
const renderer = ['renderer/renderer.js', 'renderer/webai-bridge.js'].map(read).join('\n');

const uniq = (arr) => [...new Set(arr)];
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

const preloadChannels = uniq(all(/invoke\('([^']+)'/g, preload));
const mainChannels = uniq(all(/handle\('([^']+)'/g, main));

// 解析 exposeInMainWorld 的分组/方法（按缩进，preload 格式固定 2/4 空格）
const groups = {};
let current = null;
for (const line of preload.split(/\r?\n/)) {
  const g = /^ {2}(\w+):\s*\{\s*$/.exec(line);
  if (g) {
    current = g[1];
    groups[current] = [];
    continue;
  }
  if (/^ {2}\},?\s*$/.test(line)) {
    current = null;
    continue;
  }
  const m = /^ {4}(\w+):/.exec(line);
  if (m && current) groups[current].push(m[1]);
}

const calls = uniq([...renderer.matchAll(/window\.app\.(\w+)\.(\w+)\s*\(/g)].map((m) => `${m[1]}.${m[2]}`));

const problems = [];

for (const c of preloadChannels) {
  if (!mainChannels.includes(c)) problems.push(`preload 调了 ${c}，但 main 没有 handle`);
}
for (const c of mainChannels) {
  if (!preloadChannels.includes(c)) problems.push(`main 暴露了 ${c}，但 preload 从未调用（死接口）`);
}
for (const call of calls) {
  const [g, m] = call.split('.');
  if (!groups[g]) problems.push(`renderer 调 app.${call}，但 preload 没有暴露分组 ${g}`);
  else if (!groups[g].includes(m)) problems.push(`renderer 调 app.${call}，但 preload 的 ${g} 里没有 ${m}`);
}

console.log('=== 壳层契约一致性 ===');
console.log(`preload channel: ${preloadChannels.length} 个`);
console.log(`main    handle : ${mainChannels.length} 个`);
console.log(`renderer 调用  : ${calls.length} 个 → ${calls.join(', ')}`);
console.log(`暴露分组       : ${Object.keys(groups).map((k) => `${k}(${groups[k].length})`).join(' ')}`);
if (problems.length) {
  console.log('\n问题：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n✓ 契约一致：无缺失、无死接口');
