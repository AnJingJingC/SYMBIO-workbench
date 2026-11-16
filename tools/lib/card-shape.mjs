// tools/lib/card-shape.mjs —— 卡片外形收口（结构层，不做事实判断）
//
// 为什么单独抽出来放 lib/：
//   1) 这层逻辑要有断言守。原来它埋在 autopilot 里，只能"跑一次看一眼"，而
//      2026-11-11 那次的漏检（站点 UI 文案进了卡片尾部）恰恰是"看出来了但没闸"。
//   2) 放 tools/ 根目录会让面板工具箱从 6 个可点工具变成 7 个，破契约。
//
// 只做一件事：砍掉「## 标签」之后不属于标签的内容。
//
// 背景：桥是网页对话产品，回答尾部会被刮进站点自己的提示条
// （2026-11-11 真机抓到「管理记忆信息：你可以补充更多信息，或点击 记忆管理…」）。
// 用正则追着站点文案打是打不完的：文案会改、站点会换、每站都不一样。
// 改成按结构截——卡片契约只有四个小节且「## 标签」是最后一节，
// 标签之后出现的非标签行，一律不是卡片内容。
//
// 只做「删掉明显不是卡片的东西」，不做改写、不做合并、不猜句子边界：
// 卡片正文是模型写的，动一个字就等于替它说话，那不是这一层该干的事。

const TAG_LINE = /^(?:[-*+]\s*)?#\S/;
const TAG_HEADING = /^##\s+标签\s*$/;

/**
 * 砍掉「## 标签」之后不属于标签的内容。
 * 只在能找到「## 标签」小节时动手；找不到就原样返回（不猜、不乱截）。
 * @param {string[]} lines 已规范化小节（`## 标签` 已就位）的行数组
 * @returns {{ lines: string[], dropped: string[] }} dropped 供上层记日志，不静默丢东西
 */
export function trimTailAfterTags(lines) {
  const src = Array.isArray(lines) ? lines : [];
  let idx = -1;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    if (TAG_HEADING.test(String(src[i]).trim())) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { lines: [...src], dropped: [] };

  const kept = src.slice(0, idx + 1);
  const dropped = [];
  for (let i = idx + 1; i < src.length; i += 1) {
    const t = String(src[i]).trim();
    if (!t) continue;
    if (TAG_LINE.test(t)) kept.push(src[i]);
    else dropped.push(t);
  }
  return { lines: kept, dropped };
}

export const __testing = { TAG_LINE, TAG_HEADING };
