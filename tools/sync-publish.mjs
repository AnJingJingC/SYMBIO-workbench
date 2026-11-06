// tools/sync-publish.mjs —— 把「产品部分」同步到干净发布仓（默认只报告，不写）
//
// 为什么需要它：发布仓 E:/symbio-publish 一直是**手工复制**同步的，结果两边一定漂移——
// 这次同步前就发现发布仓里还躺着一个 0.3.5 的 tgz、tools/ 里缺着 5 个新工具。
// 手工复制的问题不是慢，是"没人知道漏了哪个"，而漏掉的那些恰恰不会报错。
//
// 边界（只做搬运，不做判断）：
//   - 只搬白名单里的路径，一个都不多
//   - memory/ 永远不搬（个人画像、私有记忆、任务流水）
//   - node_modules / *.tgz / .assembled / 心跳 永远不搬
//   - **删除只在报告里出现，永不自动删**（删错是找不回来的，宁可让人看一眼）
//
// 用法：
//   node tools/sync-publish.mjs                    # 只看差异
//   node tools/sync-publish.mjs --write            # 真写
//   node tools/sync-publish.mjs --to E:/xxx        # 换个目标目录
//   node tools/sync-publish.mjs --json

import fs from 'node:fs/promises';
import path from 'node:path';
import { root, has, flag, exists } from './lib/common.mjs';

// [源（相对本仓）, 目标（相对发布仓）]；目标是 '' 表示铺到发布仓根
const RULES = [
  ['workbench/dsh', 'dsh'],
  ['workbench/lib', 'lib'],
  ['workbench/src', 'src'],
  ['workbench/test', 'test'],
  ['workbench/package.json', 'package.json'],
  ['workbench/icon.svg', 'icon.svg'],
  ['workbench/cordis.patch.yml', 'cordis.patch.yml'],
  ['workbench/README.md', 'README.md'],
  ['workbench/LICENSE', 'LICENSE'],
  ['workbench/INSTALL-PROMPT.txt', 'INSTALL-PROMPT.txt'],
  // INSTALL.md 原本只存在于发布仓（没有正本），改一次就没人知道另一处是旧的——
  // 已收回主仓 workbench/INSTALL.md 作正本，此后每次同步都以主仓为准
  ['workbench/INSTALL.md', 'INSTALL.md'],
  ['tools', 'tools'],
  ['config', 'config'],
  ['docs', 'docs'],
  ['.dsh/skills', '.dsh/skills'],
  ['shell', 'shell'],
  ['AGENTS.md', 'AGENTS.md'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.assembled', '心跳', 'temp', 'dist']);
const SKIP_EXT = new Set(['.tgz', '.log']);
// 只在本机有意义的开发期探针：读宿主 app.asar、默认路径绑死本机用户名，
// 进公开库既没用又误导（别人 clone 下来跑不通）。留在私仓即可。
const SKIP_REL_PREFIX = ['tools/dev/'];

function skipFile(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (SKIP_REL_PREFIX.some((p) => rel.startsWith(p))) return true;
  return SKIP_EXT.has(path.extname(rel).toLowerCase());
}

/** 递归列出目录下所有文件（相对路径，正斜杠）。 */
async function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkFiles(full, base, out);
    } else if (e.isFile() && !skipFile(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** 把一条规则展开成 [相对发布仓的目标路径, 源绝对路径] 列表。 */
async function expandRule(srcRoot, from, to) {
  const src = path.join(srcRoot, from.replace(/\//g, path.sep));
  if (!(await exists(src))) return { missing: from, pairs: [] };

  const st = await fs.stat(src);
  if (st.isFile()) {
    return { missing: null, pairs: [[to || path.basename(src), src]] };
  }
  const files = await walkFiles(src);
  return {
    missing: null,
    // 注意用「发布仓目标路径」做排除判断：walkFiles 给的 rel 是相对本条规则根的
    // （例如 tools/ 下得到 dev/x.mjs），拿它比 tools/dev/ 前缀永远不匹配。
    pairs: files
      .filter((f) => !skipFile(`${to}/${f}`))
      .map((f) => [`${to}/${f}`.replace(/^\/+/, ''), path.join(src, f.replace(/\//g, path.sep))]),
  };
}

async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    // 换行符不同不算内容变化（Windows 上 CRLF/LF 混用，逐字节比会天天报"有差异"）
    return ba.toString('utf8').replace(/\r\n/g, '\n') === bb.toString('utf8').replace(/\r\n/g, '\n');
  } catch {
    return false;
  }
}

export async function syncPublish({ to = '', write = false, rootDir = null } = {}) {
  const srcRoot = rootDir || root();
  const dstRoot = path.resolve(to || 'E:/symbio-publish');

  if (!(await exists(dstRoot))) {
    return { ok: false, message: `发布仓不存在：${dstRoot}` };
  }

  const plan = [];
  const missing = [];
  for (const [from, to2] of RULES) {
    const r = await expandRule(srcRoot, from, to2);
    if (r.missing) missing.push(r.missing);
    plan.push(...r.pairs);
  }

  const added = [];
  const changed = [];
  const same = [];
  for (const [rel, src] of plan) {
    const dst = path.join(dstRoot, rel.replace(/\//g, path.sep));
    if (!(await exists(dst))) added.push(rel);
    else if (await sameFile(src, dst)) same.push(rel);
    else changed.push(rel);
  }

  // 发布仓里有、白名单里没有的 = 该删（只报告）
  const planned = new Set(plan.map(([rel]) => rel));
  const extras = [];
  for (const [from, to2] of RULES) {
    const dstDir = path.join(dstRoot, (to2 || '').replace(/\//g, path.sep));
    const st = await fs.stat(dstDir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    for (const f of await walkFiles(dstDir)) {
      const rel = `${to2}/${f}`.replace(/^\/+/, '');
      if (!planned.has(rel)) extras.push(rel);
    }
  }
  // 根级散文件也要查：规则里每条根文件是单独一项，漏掉的（比如手放的旧 tgz）不会落在任何
  // 被扫描的目录里，以前就因此一直没人发现发布仓根上躺着一个 0.3.5 的包
  const rootEntries = await fs.readdir(dstRoot, { withFileTypes: true }).catch(() => []);
  for (const e of rootEntries) {
    if (!e.isFile() || e.name === '.gitignore') continue;
    if (!planned.has(e.name)) extras.push(e.name);
  }
  extras.sort();

  let copied = 0;
  if (write) {
    for (const [rel, src] of plan) {
      const dst = path.join(dstRoot, rel.replace(/\//g, path.sep));
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      copied += 1;
    }
  }

  return {
    ok: true,
    target: dstRoot,
    write,
    copied,
    counts: { planned: plan.length, added: added.length, changed: changed.length, same: same.length, extras: extras.length },
    missing,
    added,
    changed,
    extras,
  };
}

function line(tag, rel) {
  return `  ${tag} ${rel}`;
}

async function main() {
  const to = flag(process.argv.slice(2), 'to');
  const write = has(process.argv.slice(2), 'write');
  const json = has(process.argv.slice(2), 'json');

  const r = await syncPublish({ to, write });
  if (!r.ok) {
    console.error(`✗ ${r.message}`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }

  console.log(`同步目标：${r.target}${write ? '（已写入）' : '（只看不写，加 --write 才动手）'}`);
  console.log(`计划 ${r.counts.planned} 个文件：新增 ${r.counts.added} / 改动 ${r.counts.changed} / 一致 ${r.counts.same} / 该删 ${r.counts.extras}\n`);

  if (r.missing.length) console.log(`⚠ 本仓缺这些路径（规则写错或还没建）：${r.missing.join('、')}`);
  if (r.added.length) {
    console.log('新增：');
    for (const f of r.added.slice(0, 30)) console.log(line('+', f));
    if (r.added.length > 30) console.log(`  … 另 ${r.added.length - 30} 个`);
  }
  if (r.changed.length) {
    console.log('改动：');
    for (const f of r.changed.slice(0, 30)) console.log(line('~', f));
    if (r.changed.length > 30) console.log(`  … 另 ${r.changed.length - 30} 个`);
  }
  if (r.extras.length) {
    console.log('发布仓里有、白名单没有（**不会自动删**，确认后可 git rm）：');
    for (const f of r.extras.slice(0, 30)) console.log(line('-', f));
    if (r.extras.length > 30) console.log(`  … 另 ${r.extras.length - 30} 个`);
  }
  if (write) console.log(`\n✓ 已复制 ${r.copied} 个文件。到 ${r.target} 看一眼 git status 再提交。`);
  return 0;
}

if (process.argv[1]?.endsWith('sync-publish.mjs')) {
  main().then((c) => process.exit(c));
}
