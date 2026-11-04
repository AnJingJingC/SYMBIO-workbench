// 站点薄壳：智谱清言（chatglm.cn）
//
// ⚠️ 校准状态（2026-11-04）：**未校准**。verified=false，同 deepseek 的诚实边界。
// 校准流程：npm run bridge → /webai/show?site=zhipu 手动登录 → node probe-site.mjs zhipu
//
// 已知结构线索（待实测）：
//   - 输入：清言网页版用 <textarea>（chat-input 类）
//   - 回答：助手消息容器类名常见 .chat-content / markdown-body 一族

const SITE = {
  id: 'zhipu',
  name: '智谱清言（网页端）',
  url: 'https://chatglm.cn/main/alltoolsdetail',
  partitionKey: 'webai-zhipu',
  verified: true,
  verifiedFields: { inputSel: true, send: true, answerSel: true },
  verifiedNote:
    '已校准（2026-11-05 真机）：probe 三要素命中；答案选择器用 :not([class*=thinking]) 排除思考块；发送方式=Enter',

  // 实测（2026-11-05，真机 Electron，已登录态）：输入框是**无 id 的 textarea**，
  // class 为 "scroll-display-none"。原猜测的 #chat-input / .chat-input 都不存在，
  // 于是 loggedIn() 把"已登录"误判成"未登录"（页面里其实有用户名与「退出」）。
  inputSel: 'textarea.scroll-display-none, textarea#chat-input, textarea.chat-input, div[contenteditable="true"]',
  sendSel: '',
  // 回答区实测（2026-11-05 真机）：页面**同时**有两块 .markdown-body——
  //   思考过程：祖先 .answer-content-wrap.text-advance-thinking-content（190 字推演）
  //   最终答案：祖先 .answer-content-wrap（无 thinking 修饰）
  // 原猜测的 .answer-content 会命中侧边名片卡（文本只有「ChatGLM」），
  // 所以第一问抓到的是品牌文字而不是答案。用 :not([class*=thinking]) 精确排除思考块。
  answerSel:
    '.answer-content-wrap:not([class*="thinking"]) .markdown-body, .markdown-body',

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

  // 思考占位（与豆包 2026-11-04 事故同类）：生成期间回答区先显示「回答中」，
  // 该短文本静止后会被误判成"已收敛"。占位不是答案，命中就继续等正文。
  // 空文本不在此列——那是 empty-answer 的语义，别抢归因。
  isPendingAnswer(text) {
    const t = String(text ?? '').replace(/\s+/g, '');
    if (!t) return false;
    if (t.length > 12) return false;
    return /^(回答中|思考中|正在思考|正在生成|生成中|加载中|请稍等|分析中|检索中|整理中)/.test(t);
  },

  clean(text) {
    let t = String(text ?? '').trim();
    // 页脚固定的 AI 生成声明会混进正文
    t = t.replace(/^.*以上内容为\s*AI\s*生成.*$/gm, '');
    // 行尾的引用角标，形如 " kepuchina.cn +1" / " baike.baidu.com +2"
    t = t.replace(/[\s　]*[a-z0-9-]+(\.[a-z0-9-]+)*\.(cn|com|net|org)\s*\+\d+\s*$/gim, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  },

  wait: { firstTokenMs: 30000, stableMs: 2000, hardTimeoutMs: 180000 },

  profileDir: null,
};

export default SITE;
