// 站点薄壳：DeepSeek（chat.deepseek.com）
//
// ⚠️ 校准状态（2026-11-04）：**未校准**。本文件只提供"结构正确的站点定义"，
//    选择器是社区常见结构的合理猜测，没在真机 Electron 里验证过。
//    verified=false 是诚实值——三要素（input/send/answer）一个都没实测过。
//
// 校准流程（与 doubao 同一套，别跳步）：
//   1. 启动桥：cd E:/SYMBIO/shell && npm run bridge
//   2. 开登录窗手动登录：curl -X POST "http://127.0.0.1:31239/webai/show?site=deepseek"
//   3. 校准选择器：node test-site.mjs deepseek   （把实测结果回写进本文件，verified 才能改 true）
//
// 已知结构线索（仅凭公开页面记忆，待实测推翻或确认）：
//   - 输入：DeepSeek 网页版长期用 <textarea id="chat-input">；新版可能换 ProseMirror
//   - 回答：助手消息常带 ds-markdown 类名（类名带 hash 后缀，可能变）
//   - 未登录：无输入框 / 弹登录引导

const SITE = {
  id: 'deepseek',
  name: 'DeepSeek（网页端）',
  url: 'https://chat.deepseek.com/',
  partitionKey: 'webai-deepseek',
  verified: false,
  verifiedFields: { inputSel: false, send: false, answerSel: false },
  verifiedNote: '未校准：选择器为合理猜测，真机 npm run test-site 校准前不得用于真实问答',

  inputSel: 'textarea#chat-input, div[contenteditable="true"].ProseMirror',
  sendSel: '', // 未实测；先走回车（多数站点回车可发送）
  answerSel: '.ds-markdown',

  // 未校准阶段不写死登录指示器：先靠"有无输入框"判
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
    // 未校准阶段：保守原样返回，不加任何截断规则（宁多留不误删）
    return String(text ?? '').trim();
  },

  // 未校准：等待参数放宽，实测后再收紧
  wait: { firstTokenMs: 30000, stableMs: 2000, hardTimeoutMs: 180000 },

  profileDir: null,
};

export default SITE;
