// 站点薄壳：豆包（唯一配置面）—— 架构 §3.2 的 site 对象
//
// 校准状态（2026-11-04 真机实测，Electron 45 真实页面）：
//   ✅ inputSel  —— 实测命中 2 个：div.tiptap.ProseMirror[contenteditable]（可视编辑器，912×24）
//                  与 textarea.textarea-*[data-testid=chat_input_input]（隐藏兜底）
//   ✅ send      —— 实测页面上**没有**发送按钮（6 个 button 全是登录/对话/工作/下载），发送走回车
//   ✅ loggedIn  —— 实测存在 data-testid="to_login_button" 即未登录；原来的"有输入框就算已登录"是错的
//   ⏳ answerSel —— 尚未验证：回答区只有真正提问后才会出现，需登录后跑一次才能确认
//
// 所以 verified 仍是 false（三要素只校准了两个），不要假装它能用。

const SITE = {
  id: 'doubao',
  name: '豆包（网页端）',
  url: 'https://www.doubao.com/chat/',
  partitionKey: 'webai-doubao', // → partition=persist:webai-doubao，登录态持久
  // 三要素都已在真机实测通过（2026-11-04，两轮真实问答拿到正确助手文本）
  verified: true,
  verifiedFields: { inputSel: true, send: true, answerSel: true },
  // 但"登录态下的长期稳定性"尚未验收：匿名额度耗尽会弹登录框，需宿主登录后复验
  verifiedNote: '选择器真机实测通过；登录态稳定性未验收（需手动登录一次后 npm run selftest）',

  // 输入：ProseMirror 是真实编辑器；textarea 是隐藏兜底，放后面
  inputSel: 'div.ProseMirror[contenteditable="true"], textarea[data-testid="chat_input_input"]',
  // 发送：实测该按钮只在"输入框有字"时才出现，且回车已验证可发送 → 走回车更稳
  sendSel: '',
  // 回答：⚠️ 两次踩坑记录
  //   1) 原来写 [data-testid="message_text_content"] —— 实测只有 1 个且是**用户自己**的气泡
  //      （祖先是 send-msg-bubble-radius / flex justify-end），会把问句当回答交回来。
  //   2) 改成 receive_message —— 能拿到助手消息，但会连带推荐词条与"下载电脑版"横幅。
  //   实测助手气泡结构：receive_message > div.flex-col > [data-testid="message_content"] > 正文块
  //   所以取 message_content（正文），再用 clean() 去掉推广噪声。
  answerSel: '[data-testid="receive_message"] [data-testid="message_content"]',

  // 去噪：只删"确定的 UI 噪声"，不动正文。规则保守——宁可多留一行，也不许改用户答案。
  // 实测 message_content 里会混进：① 搜索状态行"搜索 2 个关键词，参考 11 篇资料"
  //                              ② 末尾"相关视频 / 读完这10本书…"卡片
  // 推荐追问（suggest_message_item）与下载横幅是 message_content 的**兄弟节点**，本来就不在正文里。
  clean(text) {
    const lines = String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim());
    const dropLine = [
      /^下载豆包电脑版.*$/,
      /^立即下载.*$/,
      /^解锁本地任务.*$/,
      /^可在本地电脑协助.*$/,
      /^搜索\s*\d+\s*个关键词.*$/,
      // 思考过程折叠标题：2026-11-04 实测回答正文首行会混进「已完成思考」
      // （深度思考模式下还会带「已深度思考（用时 12 秒）」），都不是答案正文。
      /^已完成思考$/,
      /^已深度思考.*$/,
    ];
    const cutFrom = /^(相关视频|相关推荐|相关阅读|参考资料|参考视频|延伸阅读)$/;
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      if (cutFrom.test(l)) break; // 卡片类内容一律截断，不猜它后面还有多少
      if (dropLine.some((re) => re.test(l))) continue;
      out.push(l);
    }
    return out.join('\n').trim();
  },
  // 未登录信号：页面右上角出现「登录」按钮
  loginIndicatorSel: '[data-testid="to_login_button"]',

  // 登录判定：有输入框 且 没有"登录"按钮
  async loggedIn(page) {
    const hasInput = await page.exists(SITE.inputSel);
    if (!hasInput) return false;
    if (!SITE.loginIndicatorSel) return true;
    const needLogin = await page.exists(SITE.loginIndicatorSel);
    return !needLogin;
  },

  // 发送动作：有按钮点按钮，没有就回车（豆包实测属后者）
  async send(page) {
    if (SITE.sendSel && (await page.exists(SITE.sendSel))) {
      return page.click(SITE.sendSel);
    }
    return page.key('Enter');
  },

  // 思考态占位：**真实事故 2026-11-04** —— 登录后提问，回答区先后出现
  // 「正在思考」「规划知识卡片结构」「提炼消息队列核心表述」，这些文本长时间不变，
  // 桥按"已收敛"返回 ok:true，无人循环据此落了只有两行占位语的知识卡片。
  //
  // 教训：**不能靠动词前缀列黑名单**——占位语是模型自由生成的动宾短语，列举不完。
  // 改用结构性判据：真实回答一定有句末标点、冒号或换行；占位摘要是一句无标点的短短语。
  // 宁可多等（softTimeout 兜底），也不把占位当答案。
  isPendingAnswer(text) {
    const t = String(text ?? '').trim();
    if (!t) return false; // 空文本归 empty-answer 管，不抢归因
    const flat = t.replace(/\s+/g, '');
    if (/^(正在|思考中|深度思考|搜索中|生成中|加载中|请稍等)/.test(flat)) return true;
    // 真·短答案白名单：用户问是/否或确认类问题时，答案本来就没有标点，不许被拖 60 秒
    if (/^(是|否|对|不对|可以|不可以|不行|好的|好|收到|明白|ok|OK|yes|no)$/.test(flat)) return false;
    if (flat.length > 16) return false;
    // 短句且完全没有标点/换行 → 高概率是"思考摘要"，不是答案
    if (!/[。！？!?；;：:，,、\n]/.test(t)) return true;
    return false;
  },

  // 等待参数：首帧可以慢，收敛要等住，硬超时兜底
  // stableMs 1500 → 2500：豆包流式输出有停顿，1.5s 太容易在句子间歇误判收敛。
  // softTimeoutMs：占位语最多拖这么久，超过就交给 dispatcher 如实报 answer-pending。
  wait: { firstTokenMs: 25000, stableMs: 2500, softTimeoutMs: 60000, hardTimeoutMs: 180000 },

  profileDir: null, // null = 用 Electron 默认 userData 下的持久分区
};

export default SITE;
