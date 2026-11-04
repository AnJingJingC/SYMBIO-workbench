// 启动器 —— 唯一目的：把 ELECTRON_RUN_AS_NODE 这个环境坑挡在门外。
//
// 背景：某些终端/宿主会设 ELECTRON_RUN_AS_NODE=1，此时 electron.exe 会退化成纯 Node，
// 于是 import { BrowserWindow } from 'electron' 直接报
// "The requested module 'electron' does not provide an export named 'BrowserWindow'"，
// 而且 `electron --version` 会打印 Node 的版本 —— 极具误导性。
//
// 用法：
//   node launch.mjs                  → 跑正式壳（main.js）
//   node launch.mjs selftest.js      → 跑真机自检
//   node launch.mjs --bridge-only    → 只跑免费 AI 桥（无窗口，供外部宿主挂载）

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

let electronPath;
try {
  electronPath = require('electron'); // 该包默认导出可执行文件路径
} catch (e) {
  console.error('[launch] 找不到 electron，请先在 shell/ 下执行：npm install');
  process.exit(1);
}

const env = { ...process.env };
if (env.ELECTRON_RUN_AS_NODE) {
  console.warn('[launch] 检测到 ELECTRON_RUN_AS_NODE=1，已为本进程清除（否则 Electron 会退化成纯 Node）');
  delete env.ELECTRON_RUN_AS_NODE;
}

// 第一个非选项参数是入口脚本；其余选项（如 --bridge-only）原样透传给 Electron
const argv = process.argv.slice(2);
let target = '.';
if (argv[0] && !argv[0].startsWith('-')) target = argv.shift();
const child = spawn(electronPath, [target, ...argv], { stdio: 'inherit', env, cwd: HERE });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
