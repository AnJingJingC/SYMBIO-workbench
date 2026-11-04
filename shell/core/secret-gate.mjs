// 机密闸（桥调用前置拦截）—— 架构 §3.5：含密码/token/证件/银行卡/手机号 → 直接拒发
// 铁律：命中后只返回"类型"，绝不回显原文片段。

const RULES = [
  { type: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: 'api-token', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/ },
  { type: 'id-card', re: /(?:^|[^\d])\d{17}[\dXx](?![\d])/ },
  { type: 'bank-card', re: /(?:^|[^\d])\d{16,19}(?![\d])/ },
  { type: 'phone', re: /(?:^|[^\d])1[3-9]\d{9}(?![\d])/ },
  { type: 'password', re: /(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*\S+/i },
  { type: 'cookie', re: /\b(?:sessionid|session_id|csrf[_-]?token)\s*[:=]\s*\S{8,}/i },
];

/** @returns {{blocked:boolean, type?:string, message?:string}} */
export function checkSecret(text) {
  const s = String(text ?? '');
  if (!s) return { blocked: false };
  for (const r of RULES) {
    if (r.re.test(s)) {
      return {
        blocked: true,
        type: r.type,
        // 只说类型，不回显命中内容
        message: `检测到疑似机密内容（${r.type}），已按红线拦截，未发往网页端。请删掉该段后重试。`,
      };
    }
  }
  return { blocked: false };
}
