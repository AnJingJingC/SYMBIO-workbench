// lint-weekly.mjs —— 记忆体检自动化（作者机制清单"每周日体检"的落地）
//
// 由 lint-weekly.cmd（Windows 计划任务）调用；也可手动跑：node tools/lint-weekly.mjs
// 行为：
//   1. 跑 tools/memory-lint.mjs（拿 stdout）
//   2. 写 reports/体检-<YYYY-MM-DD>.json（stdout 若是 JSON 就存对象，否则存 {raw}）
//   3. 只保留最近 8 份，旧的删除
//   4. 本轮 verdict 非 PASS 时把退出码置 1（计划任务"上次运行结果"里能看出红）
//
// 注册计划任务（一次性，管理员不需要——当前用户任务即可）：
//   schtasks /Create /F /TN "SYMBIO 记忆体检" /SC WEEKLY /D SUN /ST 09:00 /TR "cmd /c E:\SYMBIO\tools\lint-weekly.cmd"

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = process.env.SYMBIO_HOME || 'E:/SYMBIO';
const REPORTS = path.join(ROOT, 'reports');
const KEEP = 8;

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

let code = 0;
let stdout = '';
try {
  const r = await execFileP(process.execPath, [path.join(ROOT, 'tools', 'memory-lint.mjs')], {
    cwd: ROOT, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  stdout = r.stdout;
} catch (e) {
  code = typeof e.code === 'number' ? e.code : 1;
  stdout = e.stdout ?? '';
  console.error(`memory-lint 退出码 ${code}`);
}

let payload;
try {
  payload = JSON.parse(stdout);
} catch {
  payload = { raw: stdout, note: 'memory-lint 输出不是 JSON，原样保存' };
}

await fs.mkdir(REPORTS, { recursive: true });
const reportPath = path.join(REPORTS, `体检-${today}.json`);
await fs.writeFile(reportPath, JSON.stringify({ date: today, ...payload }, null, 2) + '\n', 'utf8');
console.log(`已写报告：${path.relative(ROOT, reportPath)}`);

// 清理：只留最近 KEEP 份
const files = (await fs.readdir(REPORTS))
  .filter((f) => /^体检-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
  await fs.unlink(path.join(REPORTS, old));
  console.log(`清理旧报告：${old}`);
}

const verdict = payload?.verdict ?? payload?.level ?? null;
if (verdict && !/PASS/i.test(String(verdict))) {
  console.error(`本轮体检非 PASS：${verdict}`);
  process.exitCode = 1;
}
