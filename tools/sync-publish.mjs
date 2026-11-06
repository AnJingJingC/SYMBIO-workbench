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
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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
  // 行尾策略也要跟着走：发布仓没有它，Windows 上 clone 出来就是 CRLF，
  // 再打包得到的字节与仓库根那份不一致
  ['.gitattributes', '.gitattributes'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.assembled', '心跳', 'temp', 'dist']);
const SKIP_EXT = new Set(['.tgz', '.log']);
// 只在本机有意义的开发期探针：读宿主 app.asar、默认路径绑死本机用户名，
// 进公开库既没用又误导（别人 clone 下来跑不通）。留在私仓即可。
const SKIP_REL_PREFIX = ['tools/dev/'];

/**
 * 从 .tgz 里读出 package/package.json（只解析 tar 头，不依赖 tar 命令）。
 *
 * 为什么要读包内版本而不是信文件名：文件名是手写的，包内 version 是打包时写死的。
 * 2026-11-07 那次是人工从 GitHub 网页上传 0.5.0 的包——上传这条路能走通，但"传的是不是
 * 那个版本"没有任何环节会替你确认。包名对、内容错，下载的人装完才发现。
 */
async function readTgzPackageJson(file) {
  const buf = await fs.readFile(file);
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 归档结束
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const body = tar.subarray(off + 512, off + 512 + size);
    if (name === 'package/package.json') return JSON.parse(body.toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 发布仓根的安装包：源 = workbench/<name>-<version>.tgz。
 *
 * 为什么单独一条：RULES 是写死的路径，版本号会变；而且 *.tgz 在 SKIP_EXT 里被全局挡掉
 * （主仓不该存构建产物）。发布仓不一样——它要有当前版本的包，否则别人只能 clone 后自己 pack。
 */
async function tgzEntry(srcRoot) {
  const pkgFile = path.join(srcRoot, 'workbench', 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
  } catch {
    return { error: '读不到 workbench/package.json，无法确定当前版本' };
  }
  const file = `${pkg.name}-${pkg.version}.tgz`;
  const src = path.join(srcRoot, 'workbench', file);
  if (!(await exists(src))) {
    return { error: `缺当前版本的安装包：workbench/${file}（先 pnpm pack 再同步）`, file };
  }
  const buf = await fs.readFile(src);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  let inner = null;
  try {
    inner = await readTgzPackageJson(src);
  } catch (e) {
    return { error: `包解不开（${e.message}）：workbench/${file}`, file };
  }
  if (!inner) return { error: `包里没有 package/package.json：workbench/${file}`, file };
  if (inner.name !== pkg.name || inner.version !== pkg.version) {
    return {
      error: `包内版本是 ${inner.name}@${inner.version}，源码是 ${pkg.name}@${pkg.version} —— 传错包了`,
      file,
    };
  }
  return { file, src, md5, size: buf.length, version: pkg.version };
}

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
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    if (ba.equals(bb)) return true;
    // 尺寸不同不代表内容变了：发布仓在 Windows 上会被 git 转成 CRLF（主仓是 LF），
    // 一份没改过的文件尺寸也必然不等。先归一化行尾再比，否则每次同步都报一堆假改动，
    // 真改动就混在这些噪音里没人看。
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

  // 安装包单独处理：能取到才进计划；取不到只报告，不阻断其余同步
  const tgz = await tgzEntry(srcRoot);
  if (tgz.error) missing.push(tgz.error);
  else plan.push([tgz.file, tgz.src]);

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
    tgz: tgz.error ? { ok: false, message: tgz.error } : { ok: true, file: tgz.file, version: tgz.version, size: tgz.size, md5: tgz.md5 },
    // 根上多出来的 .tgz = 上一个版本没删。它不会报错，只会被下载 —— 0.3.4 那次事故的成因
    staleTgz: extras.filter((f) => f.toLowerCase().endsWith('.tgz')),
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

  if (r.tgz?.ok) {
    console.log(`安装包：${r.tgz.file}（${(r.tgz.size / 1024).toFixed(1)} KB，md5 ${r.tgz.md5}，包内版本已核 = ${r.tgz.version}）`);
  } else if (r.tgz) {
    console.log(`⚠ 安装包：${r.tgz.message}`);
  }
  if (r.staleTgz?.length) {
    console.log(`⚠ 发布仓根上有 ${r.staleTgz.length} 个非当前版本的包，下载的人会拿到旧的：${r.staleTgz.join('、')}`);
  }

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
