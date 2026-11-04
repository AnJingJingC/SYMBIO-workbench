// 站点薄壳：DeepSeek（chat.deepseek.com）
//
// ⚠️ 校准状态（2026-11-04）：**未校准**。本文件只提供"结构正确的站点定义"，
//    选择器是社区常见结构的合理猜测，没在真机 Electron 里验证过。
//    verified=false 是诚实值——三要素（input/send/answer）一个都没实测过。
//
// 校准流程（与 doubao 同一套，别跳步）：
//   1. 启动桥：cd E:/SYMBIO/shell && npm run bridge
//   2. 开登录窗手动登录：curl -X POST "http://127.0.0.1:31239/webai/show?site=deepseek"
//   3. 校准选择器：node probe-site.mjs deepseek   （把实测结果回写进本文件，verified 才能改 true）
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
  verified: true,
  verifiedFields: { inputSel: true, send: true, answerSel: true },
  verifiedNote: '已校准（2026-11-05 真机）：probe calibrated:true（input=1/answer=1）；实问答 58 字、3.6s；发送方式=Enter（页面无独立发送按钮）',

  // 实测（2026-11-05，真机 Electron，已登录态）：输入框是**无 id 的 textarea**，
  // class 为 "_27c9245 ds-scroll-area ds-scroll-area--show-on-focus-within"。
  // 原猜测的 textarea#chat-input 不存在，导致"已登录也被判成未登录"——
  // 因为 loggedIn() 用输入框存在与否作判据。改用实测类名，保留旧候选作后备。
  inputSel: 'textarea.ds-scroll-area, textarea#chat-input, div[contenteditable="true"].ProseMirror',
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

  // 思考占位（与豆包 2026-11-04 事故同类）：生成期间回答区先出现「思考中」一类短文本，
  // 它静止后会被误判成"已收敛"。占位不是答案，命中就继续等正文。
  // 空文本不在此列——那属于 empty-answer 的语义，别抢归因。
  isPendingAnswer(text) {
    const t = String(text ?? '').replace(/\s+/g, '');
    if (!t) return false;
    if (t.length > 12) return false;
    return /^(思考中|正在思考|正在生成|生成中|加载中|请稍等|分析中|检索中|搜索中|正在搜索)/.test(t);
  },

  clean(text) {
    let t = String(text ?? '').trim();
    // 深度思考模式的完成标记会作为单独一行混进正文
    t = t.replace(/^已深度思考（用时\s*\d+\s*秒）\s*$/gm, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  },

  // 未校准：等待参数放宽，实测后再收紧
  wait: { firstTokenMs: 30000, stableMs: 2000, hardTimeoutMs: 180000 },

  profileDir: null,
};

export default SITE;
