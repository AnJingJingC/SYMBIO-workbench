// 站点薄壳：通义千问（tongyi.aliyun.com）
//
// ⚠️ 校准状态（2026-11-04）：**未校准**。verified=false，同 deepseek 的诚实边界。
// 校准流程：npm run bridge → /webai/show?site=qianwen 手动登录 → node probe-site.mjs qianwen
//
// 已知结构线索（待实测）：
//   - 输入：通义千问网页版用 <textarea>（placeholder 类似"千问，你好"）
//   - 回答：助手消息在 .tongyi-markdown / .answer-item 一类容器里
//   - 注意：通义页面较重，首帧等待给足

const SITE = {
  id: 'qianwen',
  name: '通义千问（网页端）',
  // 实测：tongyi.aliyun.com 会 302 到 www.qianwen.com，直接写终点减少一次跳转
  url: 'https://www.qianwen.com/',
  partitionKey: 'webai-qianwen',
  verified: true,
  verifiedFields: { inputSel: true, send: true, answerSel: true },
  verifiedNote:
    '已校准（2026-11-05 真机）：答案容器 .answer-common-card .qk-markdown（实测命中 1 个）；发送方式=Enter',

  inputSel: 'textarea[placeholder*="千问"], textarea#chat-input, div[contenteditable="true"]',
  sendSel: '',
  // 回答区实测（2026-11-05 真机）：正文在 .qk-markdown 内，外层是 .answer-common-card。
  // 原猜测的 .tongyi-markdown / .answer-item / .markDown 全都不存在——站点已改版为
  // www.qianwen.com（旧 tongyi.aliyun.com 会跳转），类名整体换了前缀（qk-md-*）。
  answerSel: '.answer-common-card .qk-markdown, .qk-markdown',

  loginIndicatorSel: '',

  async loggedIn(page) {
    return page.exists(SITE.inputSel);
  },

  async send(page) {
    if (SITE.sendSel && (await page.exists(SITE.sendSel))) {
      return page.click(SITE.sendSel);
    }
    return page.key('Enter');
  },

  // 思考占位（与豆包 2026-11-04 事故同类）：生成期间会先出现「正在思考」一类短文本，
  // 它静止后会被误判成"已收敛"。占位不是答案，命中就继续等正文。
  // 空文本不在此列——那属于 empty-answer，别抢归因。
  isPendingAnswer(text) {
    const t = String(text ?? '').replace(/\s+/g, '');
    if (!t) return false;
    if (t.length > 12) return false;
    return /^(正在|思考中|深度思考|分析中|检索中|搜索中|生成中|加载中|请稍等|整理中)/.test(t);
  },

  clean(text) {
    let t = String(text ?? '').trim();
    // 千问会在回答末尾挂一行"追问引导"，属于界面元素不是答案正文。
    // 注意它每次都换措辞（「需要我为你整理…」「需要我继续用一句话为你解释…」），
    // 所以按"以「需要我」开头 + 以问号结尾"整行删，而不是枚举具体句子。
    t = t.replace(/^\s*需要我[^\n]*[？?]\s*$/gm, '');
    // 追问按钮的点击提示会作为单独一行混进来，且措辞不固定
    // （真机见过「好的，继续」「好的，帮我解释」）→ 按"以「好的，」开头 + 短行"整行删。
    t = t.replace(/^\s*好的[，,][^\n]{0,16}$/gm, '');
    // 引用角标：既可能在行尾（「…效率。13」），也可能夹在句中（「…安全审计。348」后跟换行）
    t = t.replace(/([。！？!?])\s*\d{1,3}(?=\s|$)/g, '$1');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  },

  wait: { firstTokenMs: 35000, stableMs: 2000, hardTimeoutMs: 240000 },

  profileDir: null,
};

export default SITE;
