/**
 * 出网隐私闸的**判定**部分（纯函数，零依赖，不联网、不读文件）。
 *
 * 为什么单独拆出来：autopilot 原来把"解析失败"当成"没命中"——
 * 扫描器崩溃（exit 1）、输出不是 JSON、文件干脆缺失，三种情况都会走到
 * `outbound = body`，**原文照样发给第三方站点**。2026-11-11 用故障演练实测确认：
 * 造一份含身份证/银行卡/手机号的入料，只把 pii-scan 换成 exit 1，
 * autopilot 立刻换着 4 个站往外发。规则本身 24/24 判得对，死在接线。
 *
 * 这跟 2026-11-07 那条 `(?i)` 规则静默失效是同一个病：闸没在跑，输出却显示正常。
 * 所以这里只留三种结局，没有第四种：
 *   allow  —— 判过了，可以出去（正文是脱敏后的）
 *   block  —— 判出 L1，不许出去
 *   halt   —— **判不出来**，既不许出去，也不许当"没事"（系统性问题，该停下喊人）
 *
 * 放 tools/lib/ 而不是 tools/：tools 根下的 .mjs 会被面板算成可点工具，
 * 硬断言 6 个（workbench/test/contract.test.mjs），多一个就破契约。
 */

const VERDICTS = new Set(['PASS', 'REDACT', 'BLOCK']);
/** 解析 pii-scan 的普通输出。判不出就 ok:false，绝不猜。 */
export function parseScan(stdout) {
  const raw = String(stdout ?? '');
  if (!raw.trim()) return { ok: false, reason: '扫描器没有任何输出' };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '扫描器输出不是 JSON（可能崩溃或被打断）' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: '扫描器输出不是对象' };
  if (j.error) return { ok: false, reason: `扫描器自报错误：${String(j.error).slice(0, 120)}` };
  const verdict = typeof j.verdict === 'string' ? j.verdict.toUpperCase() : '';
  if (!VERDICTS.has(verdict)) return { ok: false, reason: `verdict 不合法（${j.verdict === undefined ? '缺失' : String(j.verdict)}）` };
  return {
    ok: true,
    verdict,
    level: typeof j.level === 'string' ? j.level : '',
    keywordOnly: !!j.keywordOnly,
    hits: Array.isArray(j.hits) ? j.hits : [],
  };
}

/** 解析 --redact 的输出。redactedText 必须是字符串，空串也算失败。 */
export function parseRedaction(stdout) {
  const raw = String(stdout ?? '');
  if (!raw.trim()) return { ok: false, reason: '脱敏步骤没有任何输出' };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '脱敏输出不是 JSON' };
  }
  if (!j || typeof j.redactedText !== 'string' || !j.redactedText) {
    return { ok: false, reason: '脱敏输出里没有 redactedText' };
  }
  return {
    ok: true,
    redactedText: j.redactedText,
    replacements: Array.isArray(j.replacements) ? j.replacements : [],
  };
}

/**
 * 出网前的最终裁决。scan 必须是 parseScan 的结果。
 * 返回 { allow:true, outbound, level, replacements } 或 { allow:false, halt, code, reason }。
 */
export function decideEgress({ scan, redactStdout, body }) {
  const text = String(body ?? '');
  if (!scan || scan.ok !== true) {
    return { allow: false, halt: true, code: 'gate-unavailable', reason: `隐私闸判不出结论：${scan?.reason ?? '扫描结果缺失'}` };
  }
  if (scan.verdict === 'BLOCK') {
    return { allow: false, halt: false, code: 'blocked-l1', reason: '命中 L1 硬红线' };
  }

  const red = parseRedaction(redactStdout);
  if (!red.ok) {
    // 出网一律脱敏，脱敏做不出来就不出去——不管扫描器说 PASS 还是 REDACT。
    // 踩过：只对 L2 脱敏时，PASS 的正文把示例密钥原样送出，被桥自己的检测拦下。
    return { allow: false, halt: true, code: 'redact-unavailable', reason: `脱敏步骤失败：${red.reason}` };
  }

  // 脱敏结果明显被截断 = 这一步不可信。短文本不设闸，避免把正常情况判死。
  if (text.length >= 200 && red.redactedText.length < text.length * 0.3) {
    return {
      allow: false,
      halt: true,
      code: 'redact-truncated',
      reason: `脱敏结果 ${red.redactedText.length} 字，只有原文 ${text.length} 字的 ${Math.round((red.redactedText.length / text.length) * 100)}%`,
    };
  }

  const n = red.replacements.length;
  // 判了 REDACT 却一处都没替换：要么是只有关键词（keywordOnly，确实没值可替），
  // 要么是两份规则的 kind 对不上——后者意味着一处 L2 真值被原样放出去了。
  if (scan.verdict === 'REDACT' && n === 0 && !scan.keywordOnly) {
    return { allow: false, halt: true, code: 'redact-noop', reason: '判为 L2 有真值命中，但脱敏一处未替换' };
  }

  let level;
  if (scan.verdict === 'PASS') level = n ? 'L3 已占位' : 'L0 公开';
  else if (scan.keywordOnly) level = `${scan.level || 'L1'} 仅提及已脱敏`;
  else level = `${scan.level || 'L2'} 已脱敏`;

  return { allow: true, outbound: red.redactedText, level, replacements: n, scan };
}

/**
 * 在指定工作台根下跑一次扫描器（落卡前那道闸用）。
 * 与 decideEgress 的区别：这里只管"扫"，不管"发不发"；调用方拿 blocked/unavailable 自己决定。
 *
 * 两处刻意的设计：
 *   1) 整段扫，不截断。原来 intake 只看 text.slice(0,4000)——今天卡正文上限 1200
 *      所以不触发，但那是靠另一个常量兜住的默契，一旦 cardMaxChars 调大就是静默漏检。
 *   2) 判不出就 unavailable，**不按放行处理**。写卡没有第二道闸，
 *      放行就等于"闸坏了照样往可同步的记忆树里写"。
 */
export async function scanText({ root, text, argvSafe = 3000 }) {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const scanPath = path.join(root, 'tools', 'pii-scan.mjs');
  try {
    await fsp.access(scanPath);
  } catch {
    return { blocked: true, unavailable: true, hint: 'pii-scan.mjs 缺失，判不出隐私等级' };
  }

  // Windows 命令行约 32K 字节，中文长文会爆；超长就走临时文件。
  let tmp = '';
  let args;
  if (String(text).length <= argvSafe) {
    args = ['--text', String(text), '--json'];
  } else {
    tmp = path.join(os.tmpdir(), `symbio-pii-${process.pid}-${Date.now()}.md`);
    try {
      await fsp.writeFile(tmp, String(text), 'utf8');
    } catch (e) {
      return { blocked: true, unavailable: true, hint: `隐私闸临时文件写不进去：${e.message}` };
    }
    args = ['--file', tmp, '--json'];
  }

  try {
    const { stdout } = await run(process.execPath, [scanPath, ...args], {
      cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    const r = parseScan(stdout);
    if (!r.ok) return { blocked: true, unavailable: true, hint: `隐私闸判不出结论：${r.reason}` };
    if (r.verdict === 'BLOCK') return { blocked: true, hits: r.hits };
    return { blocked: false, level: r.level, keywordOnly: r.keywordOnly };
  } catch (e) {
    // 退出码 2（BLOCK）也会落到这里，但 stdout 仍含 JSON
    const r = parseScan(e?.stdout || '');
    if (r.ok && r.verdict === 'BLOCK') return { blocked: true, hits: r.hits };
    return { blocked: true, unavailable: true, hint: `隐私闸异常：${r.ok ? `verdict=${r.verdict}` : r.reason}` };
  } finally {
    if (tmp) await fsp.unlink(tmp).catch(() => {});
  }
}
