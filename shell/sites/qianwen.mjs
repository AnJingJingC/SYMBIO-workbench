// 站点薄壳：通义千问（tongyi.aliyun.com）
//
// ⚠️ 校准状态（2026-11-04）：**未校准**。verified=false，同 deepseek 的诚实边界。
// 校准流程：npm run bridge → /webai/show?site=qianwen 手动登录 → node test-site.mjs qianwen
//
// 已知结构线索（待实测）：
//   - 输入：通义千问网页版用 <textarea>（placeholder 类似"千问，你好"）
//   - 回答：助手消息在 .tongyi-markdown / .answer-item 一类容器里
//   - 注意：通义页面较重，首帧等待给足

const SITE = {
  id: 'qianwen',
  name: '通义千问（网页端）',
  url: 'https://tongyi.aliyun.com/qianwen/',
  partitionKey: 'webai-qianwen',
  verified: false,
  verifiedFields: { inputSel: false, send: false, answerSel: false },
  verifiedNote: '未校准：选择器为合理猜测，真机 npm run test-site 校准前不得用于真实问答',

  inputSel: 'textarea[placeholder*="千问"], textarea#chat-input, div[contenteditable="true"]',
  sendSel: '',
  answerSel: '.tongyi-markdown, .answer-item, .markDown',

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

  wait: { firstTokenMs: 35000, stableMs: 2000, hardTimeoutMs: 240000 },

  profileDir: null,
};

export default SITE;
