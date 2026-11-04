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
  verified: false,
  verifiedFields: { inputSel: false, send: false, answerSel: false },
  verifiedNote: '未校准：选择器为合理猜测，真机 node probe-site.mjs 校准前不得用于真实问答',

  inputSel: 'textarea#chat-input, textarea.chat-input, div[contenteditable="true"]',
  sendSel: '',
  answerSel: '.chat-content .markdown-body, .answer-content',

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

  clean(text) {
    return String(text ?? '').trim();
  },

  wait: { firstTokenMs: 30000, stableMs: 2000, hardTimeoutMs: 180000 },

  profileDir: null,
};

export default SITE;
