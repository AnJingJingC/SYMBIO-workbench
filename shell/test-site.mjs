// 站点薄壳回归测试（不需要 Electron、不联网）
// 目的：把两次真机踩过的坑钉死成断言，防止以后改选择器时静默退化。
//
// 真实教训：
//   1) answerSel 曾写成 [data-testid="message_text_content"]，
//      而它实测只有 1 个且是**用户自己**的气泡 → 把问句当回答交回来。
//   2) receive_message 的正文会混进"搜索 N 个关键词"状态行与"相关视频"卡片 → 需要 clean()。

import DOUBAO from './sites/doubao.mjs';
import DEEPSEEK from './sites/deepseek.mjs';
import QIANWEN from './sites/qianwen.mjs';
import ZHIPU from './sites/zhipu.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`✓ PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`✗ FAIL  ${name}  «${detail}»`);
  }
}

// --- 1. 选择器不能被改回"用户气泡" ---
check(
  'answerSel 不再指向用户气泡（message_text_content）',
  !String(DOUBAO.answerSel).includes('message_text_content'),
  DOUBAO.answerSel,
);
check('answerSel 指向助手容器 receive_message', String(DOUBAO.answerSel).includes('receive_message'), DOUBAO.answerSel);
check('answerSel 限定在 message_content 正文容器内', String(DOUBAO.answerSel).includes('message_content'), DOUBAO.answerSel);
check('inputSel 指向 ProseMirror 编辑器', String(DOUBAO.inputSel).includes('ProseMirror'), DOUBAO.inputSel);
check('sendSel 为空（实测无发送按钮，走回车）', DOUBAO.sendSel === '', JSON.stringify(DOUBAO.sendSel));
check('有未登录信号选择器', !!DOUBAO.loginIndicatorSel, String(DOUBAO.loginIndicatorSel));
check('wait 参数齐备', ['firstTokenMs', 'stableMs', 'hardTimeoutMs'].every((k) => typeof DOUBAO.wait[k] === 'number'), JSON.stringify(DOUBAO.wait));

// --- 2. clean() 用真机抓到的原样文本验 ---
// 这是 2026-11-04 真机第二次问答（推荐一本适合入门的书）拿到的**原始**文本：
const RAW_WITH_NOISE = [
  '搜索 2 个关键词，参考 11 篇资料',
  '推荐《被讨厌的勇气》',
  '对话体，轻松好读，是心理学入门首选，核心是阿德勒心理学里的课题分离，很适合新手建立心态。',
  '想要小说类、理财类还是历史类的入门书，我可以再换一本。',
  '相关视频',
  '读完这10本书，我把拧巴扔掉了❗ #世界这本书我又多读了一页 👶🏻当妈后，时间都给了孩子和家庭，心里那片地却荒了。',
  '下载豆包电脑版，体验更强大的 AI 能力',
].join('\n');

const CLEANED = DOUBAO.clean(RAW_WITH_NOISE);
check('clean 去掉"搜索 N 个关键词"状态行', !CLEANED.includes('搜索 2 个关键词'), CLEANED);
check('clean 去掉"下载电脑版"横幅', !CLEANED.includes('下载豆包电脑版'), CLEANED);
check('clean 从"相关视频"处截断卡片', !CLEANED.includes('读完这10本书'), CLEANED);
check('clean 保留正文第一行', CLEANED.startsWith('推荐《被讨厌的勇气》'), CLEANED);
check('clean 保留正文全部段落', CLEANED.split('\n').length === 3, JSON.stringify(CLEANED.split('\n')));

// --- 3. clean() 不许误伤：正常答案要原样通过 ---
const NORMAL = '好的，我来解释一下：\n1. 先定义问题\n2. 再列方案\n参考资料我贴在下面。';
check('clean 对正常答案不改动', DOUBAO.clean(NORMAL) === NORMAL, JSON.stringify(DOUBAO.clean(NORMAL)));

const SHORT = '收到';
check('clean 对极短答案不改动', DOUBAO.clean(SHORT) === SHORT, JSON.stringify(DOUBAO.clean(SHORT)));

// --- 4. 思考占位不算答案（2026-11-04 真机事故回归） ---
// 事故：登录后首次提问，回答区先出现「正在思考」，1500ms 不变 → 桥返回 ok:true/chars:4，
//       无人循环据此落了一张只有两行占位语的知识卡片。以下断言把它钉死。
check('站点提供 isPendingAnswer 钩子', typeof DOUBAO.isPendingAnswer === 'function');
check('「正在思考」判为未完成', DOUBAO.isPendingAnswer('正在思考') === true, '正在思考');
check('「规划知识卡片结构」判为未完成（事故原文 1）', DOUBAO.isPendingAnswer('规划知识卡片结构') === true);
check('「提炼消息队列核心表述」判为未完成（事故原文 2，前缀黑名单挡不住）', DOUBAO.isPendingAnswer('提炼消息队列核心表述') === true);
check('「深度思考中」判为未完成', DOUBAO.isPendingAnswer('深度思考中') === true);
check('「搜索中」判为未完成', DOUBAO.isPendingAnswer('搜索中') === true);
check('空文本不判为思考占位（归 empty-answer 管，勿抢归因）', DOUBAO.isPendingAnswer('') === false);
// 反向：不许误杀真实答案
check('正常长答案不判为未完成', DOUBAO.isPendingAnswer(CLEANED) === false);
check('真·短答案「收到」不判为未完成（白名单）', DOUBAO.isPendingAnswer('收到') === false);
check('真·短答案「是」不判为未完成（白名单）', DOUBAO.isPendingAnswer('是') === false);
check('正常答案（含换行与标点）不判为未完成', DOUBAO.isPendingAnswer('可以先从定义开始。\n然后再谈取舍。') === false);
// 配置防回退：stableMs 曾被 1500 误判，不许改回去
check('stableMs 不低于 2000ms（防止句子间歇误判收敛）', DOUBAO.wait.stableMs >= 2000, String(DOUBAO.wait.stableMs));
check('softTimeoutMs 已配置（占位语的等待上限）', typeof DOUBAO.wait.softTimeoutMs === 'number' && DOUBAO.wait.softTimeoutMs >= 30000, String(DOUBAO.wait.softTimeoutMs));

// --- 5. clean 去掉思考过程标题（2026-11-04 真机：正文首行混进「已完成思考」） ---
const WITH_THINKING = ['已完成思考', '消息队列是生产者与消费者之间的异步通信中间件。'].join('\n');
check('clean 去掉「已完成思考」标题行', !DOUBAO.clean(WITH_THINKING).includes('已完成思考'), DOUBAO.clean(WITH_THINKING));
check('clean 去掉思考标题后正文保留', DOUBAO.clean(WITH_THINKING).startsWith('消息队列是生产者与消费者'), DOUBAO.clean(WITH_THINKING));
const DEEP = ['已深度思考（用时 12 秒）', '结论：先做最小闭环，再谈扩展。'].join('\n');
check('clean 去掉「已深度思考（用时 N 秒）」', !DOUBAO.clean(DEEP).includes('深度思考'), DOUBAO.clean(DEEP));

// ── 三站校准防回退（2026-11-05 真机实测结果）────────────────────────────
// 教训：这三个站最初全是"合理猜测"的选择器，而猜测错了的表现极隐蔽——
//   不是报错，而是"已登录被判成未登录"（输入框不存在）或
//   "把名片卡/思考过程当答案交回来"。校准结果必须钉住，否则下次改版静默退化。
const CALIBRATED = [
  ['deepseek', DEEPSEEK],
  ['qianwen', QIANWEN],
  ['zhipu', ZHIPU],
];
for (const [id, s] of CALIBRATED) {
  check(`${id} 已校准 verified:true`, s.verified === true, String(s.verified));
  check(
    `${id} 三要素均标记实测`,
    !!(s.verifiedFields?.inputSel && s.verifiedFields?.send && s.verifiedFields?.answerSel),
  );
  check(`${id} answerSel 非空`, Boolean(s.answerSel));
  check(`${id} 有思考占位判据（占位语不许当答案）`, typeof s.isPendingAnswer === 'function');
  check(`${id} 发送方式可用（sendSel 或回车）`, s.sendSel === '' || typeof s.sendSel === 'string');
}

// deepseek：输入框是**无 id 的 textarea**（旧猜测 textarea#chat-input 不存在，
// 导致 loggedIn() 把已登录判成未登录）
check('deepseek 输入框用实测类名', DEEPSEEK.inputSel.includes('.ds-scroll-area'), DEEPSEEK.inputSel);

// 智谱：页面同时有"思考块"和"答案块"，两者都是 .markdown-body。
// 必须靠祖先 :not([class*=thinking]) 排除，否则交回的是思考过程。
check(
  'zhipu 答案选择器排除思考容器',
  /:not\(\[class\*="thinking"\]\)/.test(ZHIPU.answerSel),
  ZHIPU.answerSel,
);
check('zhipu 输入框用实测类名', ZHIPU.inputSel.includes('.scroll-display-none'), ZHIPU.inputSel);
check('zhipu 思考占位「回答中」判为未完成', ZHIPU.isPendingAnswer('回答中') === true);
check('zhipu 正常答案不判为占位', ZHIPU.isPendingAnswer('索引是对数据库表中一列或多列的值进行排序的辅助结构') === false);
check(
  'zhipu clean 去掉「以上内容为 AI 生成」声明',
  !/以上内容为/.test(ZHIPU.clean('索引是辅助数据结构。\n以上内容为 AI 生成，不代表开发者立场，请勿删除或修改本标记')),
  ZHIPU.clean('索引是辅助数据结构。\n以上内容为 AI 生成，不代表开发者立场，请勿删除或修改本标记'),
);
check('zhipu clean 去掉行尾引用角标', !/kepuchina/.test(ZHIPU.clean('索引是辅助数据结构。 kepuchina.cn +1')));

// 千问：已从 tongyi.aliyun.com 迁到 qianwen.com，类名整体换成 qk-md-*，
// 旧选择器 .tongyi-markdown/.answer-item/.markDown 全部不存在。
check('qianwen 不再用旧版类名', !/tongyi-markdown|answer-item|\.markDown/.test(QIANWEN.answerSel), QIANWEN.answerSel);
check('qianwen 答案容器为 qk-markdown', QIANWEN.answerSel.includes('qk-markdown'), QIANWEN.answerSel);
check(
  'qianwen clean 去掉追问引导行',
  !/需要我为你/.test(QIANWEN.clean('缓存就是先存到更快的地方。\n需要我为你整理一份报告吗？')),
  QIANWEN.clean('缓存就是先存到更快的地方。\n需要我为你整理一份报告吗？'),
);
// 追问引导的措辞每次都不一样（真机见过「需要我为你整理…」「需要我继续用一句话为你解释…」），
// 断言要点是"按结构删"而不是"枚举句子"，否则换一个说法就漏。
check(
  'qianwen clean 去掉换措辞的追问行',
  !/需要我/.test(QIANWEN.clean('索引是快速定位数据的数据结构。\n需要我继续用一句话为你解释“事务”吗？\n好的，继续')),
  QIANWEN.clean('索引是快速定位数据的数据结构。\n需要我继续用一句话为你解释“事务”吗？\n好的，继续'),
);
// 真机原样样本（2026-11-05 三站验证时抓到的）：角标夹在句中 + 追问提示换了说法
const QW_RAW = '日志是计算机系统在运行过程中按时间顺序记录的事件和状态信息。348\n\n好的，帮我解释';
check(
  'qianwen clean 去掉句中角标与「好的，帮我解释」',
  QIANWEN.clean(QW_RAW) === '日志是计算机系统在运行过程中按时间顺序记录的事件和状态信息。',
  QIANWEN.clean(QW_RAW),
);
check('qianwen clean 去掉句末引用角标', QIANWEN.clean('索引是辅助数据结构。13') === '索引是辅助数据结构。', QIANWEN.clean('索引是辅助数据结构。13'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
