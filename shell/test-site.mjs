// 站点薄壳回归测试（不需要 Electron、不联网）
// 目的：把两次真机踩过的坑钉死成断言，防止以后改选择器时静默退化。
//
// 真实教训：
//   1) answerSel 曾写成 [data-testid="message_text_content"]，
//      而它实测只有 1 个且是**用户自己**的气泡 → 把问句当回答交回来。
//   2) receive_message 的正文会混进"搜索 N 个关键词"状态行与"相关视频"卡片 → 需要 clean()。

import DOUBAO from './sites/doubao.mjs';

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

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
