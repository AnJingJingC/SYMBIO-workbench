# SYMBIO Shell（v0.2 · 第 3 步已完成真机校验）

自研壳层的最简可运行骨架：**Main / Preload / Renderer 三文件 + 一个站点薄壳**，已在**真实 Electron + 真实豆包网页**上跑通「一问一答」。
对应 `docs/三层架构设计.md` §8 的落地顺序第 1–3 步。

> 本文件的结论全部来自真机实测（Electron 45.2.2 / Chrome 138 / 2026-11-04），不是设计推演。
> 复现命令与原始证据（截图 + `report.json`）见 §2、§3。

---

## 1. 目录与职责（依赖只允许自上而下）

```
shell/
├── main.js                 Main 进程：窗口/标签、桥服务、单实例锁（IPC 白名单已抽到 core/ipc.mjs）
├── preload.cjs             Preload：contextBridge 暴露 app.* 白名单（无 require/fs 外泄）
├── launch.mjs              ★ 启动器：自动清掉 ELECTRON_RUN_AS_NODE（见 §4 的坑）
├── selftest.js             ★ 真机自检：真 Electron + 真站点 + 截图存证 + report.json
├── renderer/
│   ├── index.html          界面骨架 + CSP（connect-src 'none'，renderer 发不出网络请求）
│   ├── renderer.js         标签栏 + 网格 + 面板注册表（数据驱动）
│   └── webai-bridge.js     免费站问答面板（含「开登录窗」「探测选择器」）
├── core/
│   ├── ipc.mjs             ★ IPC 白名单唯一真源（正式壳与自检共用，防"两套行为各说各话"）
│   ├── dispatcher.mjs      桥内核：同站串行、分步驱动、错误分流、guest 自救、新回答识别
│   ├── bridge-server.mjs   HTTP 桥：POST /webai/ask · GET /health，只绑 127.0.0.1
│   ├── secret-gate.mjs     机密闸：手机号/证件/卡号/token/密码 → 拒发且不回显
│   └── registry.mjs        站点薄壳扫描 + 场景 JSON 读取
├── drivers/
│   ├── electron-webview.mjs 真驱动：窗口承载 + persist 分区 + 真输入事件 + 深度 DOM 探测
│   └── mock.mjs             假驱动：无网络验证闭环（冒烟用）
├── sites/doubao.mjs        ★ 站点薄壳（唯一配置面，选择器已按真机校准）
├── scenarios/knowledge-digest.json   场景 = 面板组合（数据，不是代码）
├── test-site.mjs           ★ 站点薄壳回归测试（14 条，防选择器退化，不联网）
├── smoke.mjs               冒烟：15 条断言，真起 HTTP 桥（不联网）
└── verify-contract.mjs     三文件契约一致性（channel 对齐、无死接口、renderer 调用可解析）
```

---

## 2. 怎么跑

```bash
cd E:/SYMBIO/shell

# ① 离线三件套（不需要 Electron / 不联网，随时可跑）
npm test
#   期望：站点回归 14/14 → 冒烟 15/15 → 契约"无缺失、无死接口"

# ② 真机自检（需要 Electron；会真的打开窗口、真的访问豆包、存截图）
npm install          # 首次，约 100MB（国内建议加镜像，见下）
npm run selftest     # 期望：无失败项；未登录时问答两轮会标 WAIT

# ③ 正常使用界面
npm start
#   界面里选站点 → 点「开登录窗」手动登录一次 → 收起窗口 → 直接提问

# ④ 直接打桥（壳跑起来后）
curl -s -X POST http://127.0.0.1:31239/webai/ask \
  -H "content-type: application/json" \
  -d '{"site":"doubao","question":"用一句话解释什么是幂等"}'
```

装 Electron 慢的话：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

---

## 3. 真机校验结果（2026-11-04，Electron 45.2.2）

### 3.1 自检通过项（12 项）

| 项 | 实测结果 |
|---|---|
| 站点薄壳加载 | `doubao` 载入，无字段问题 |
| 桥服务启动 | `http://127.0.0.1:31249`（自检用端口，与正式 31239 错开） |
| 主窗口渲染 | 真窗口截图 44KB，界面文字 340 字 |
| preload 契约真运行时可用 | 8 分组 17 channel 全在，`window.require` / `window.process` 均为 `undefined` |
| 界面非白屏 | 实际渲染出「阶段 A · 6 模块开 / 场景 知识消化」 |
| 阶段与场景来自真配置 | 读 `symbio.config.json` 得 `stage=A`，不是硬编码 |
| 桥 GET /health | 200，正确列出站点 |
| 错误分流：未注册站 | 404 `unknown-site` |
| 机密闸 L1 | 422 `secret-blocked`，**报错正文不含身份证号** |
| 真实站点可驱动 + DOM 探测 | 打开真豆包，输入框命中（`input:1`），水合 1067ms |
| 站点页面截图 | 46KB 真实页面 |
| 提问后截图 | 登录弹窗实况 |

### 3.2 真一问一答：**已跑通（两轮）**

| 轮次 | 问句 | 结果 |
|---|---|---|
| 1 | 请只回复两个字：收到 | `ok`，**返回「收到」**（2 字），约 4.0s |
| 2 | 推荐一本适合入门的书 | `ok`，**返回 382 字**正文（《被讨厌的勇气》推荐），约 8.0s |

第二轮的价值：验证"**已有历史时只取新回答**"——多轮对话不会把上一轮的旧答案当成本轮结果。

### 3.3 待宿主处理（2 项，不是失败）

匿名额度用尽后，豆包会弹登录框（实测截图：手机号 / 飞书 / 扫码三种方式），此时问答两轮进入 `WAIT`：

```
WAIT 真实一问一答 第1轮 — errorType=not-logged-in（25s 首帧超时后如实报错）
WAIT 真实一问一答 第2轮 — 同上
```

桥的行为是正确的：**不编造、不重试骚扰、明确告诉你需要登录**。
处理方式：`npm start` → 界面点「开登录窗」→ 手动登录一次（壳不代填任何账号/验证码）→ `npm run selftest` 复验。

---

## 4. 真机踩到的 5 个坑（都已修，写下来省得再踩）

1. **`ELECTRON_RUN_AS_NODE=1` 环境变量**（最坑）
   现象：`electron --version` 打印 Node 版本；启动即报 `does not provide an export named 'BrowserWindow'`。
   原因：该变量让 `electron.exe` 退化成纯 Node。
   修法：`launch.mjs` 启动前自动清除；`npm start` / `npm run selftest` 都走它。

2. **库和调用方用了两套 IPC**
   现象：自检窗口"阶段 未读 / 会话 — / 场景 —"，3 个 channel 报 `No handler registered`。
   原因：自检自己建窗口却没注册 IPC（是自检缺陷，不是壳缺陷）。
   修法：IPC 白名单抽到 `core/ipc.mjs` 唯一真源，正式壳与自检共用。

3. **选择器假阴性：在 SPA 水合前探测**
   现象：页面截图明明是完整界面，探测却 `bodyLen=0`、候选元素全 0。
   原因：`loadURL` 只保证文档到达，React/SPA 界面是之后才挂上的。
   修法：以「**目标选择器真命中**」为水合信号 + 探测不命中时每秒重探（最多 8 次）。

4. **答案选择器选到用户自己的气泡**（最危险）
   现象：一问一答"通过"了，但返回的文本就是我的问句。
   原因：`[data-testid="message_text_content"]` 实测只有 1 个，且是**用户气泡**（祖先 `send-msg-bubble-radius` / `flex justify-end`）；助手消息在 `receive_message` 里。
   修法：`answerSel` 改为 `[data-testid="receive_message"] [data-testid="message_content"]`，并改成"**发送前数一遍，只认新增的最后一条**"（`waitForNew`），不再取"最后一个匹配节点"。

5. **正文混入 UI 噪声**
   现象：答案尾部带「相关视频 / 读完这10本书…」卡片与「搜索 2 个关键词，参考 11 篇资料」状态行。
   原因：这些都渲染在 `message_content` 内部。
   修法：站点层 `clean()` 保守去噪（精确匹配的推广行 + 从"相关视频/相关资料"处截断）；**推荐追问与下载横幅是兄弟节点，本来就不在正文里**。

> 第 4、5 条已固化成 `test-site.mjs` 的 14 条断言（用真机抓到的原样文本做样本），改选择器就会红。

---

## 5. 已校准的选择器（都在 `sites/doubao.mjs`，唯一配置面）

| 字段 | 实测值 | 依据 |
|---|---|---|
| `inputSel` | `div.ProseMirror[contenteditable="true"], textarea[data-testid="chat_input_input"]` | 真机命中 2 个（可视编辑器 912×24 + 隐藏 textarea） |
| `sendSel` | `''`（走回车） | 真机 6 个 button 里**没有**发送键；回车已验证可发送 |
| `answerSel` | `[data-testid="receive_message"] [data-testid="message_content"]` | 助手消息容器与用户气泡互斥 |
| `loginIndicatorSel` | `[data-testid="to_login_button"]` | 该元素在 = 未登录 |
| `wait` | `firstTokenMs 25000 / stableMs 1500 / hardTimeoutMs 180000` | 实测首答 4–8s，留足余量 |

---

## 6. 诚实边界（别当成已完成）

1. **必须手动登录一次**：匿名额度会耗尽并弹登录框；壳**不代填**账号、不碰验证码。登录态靠 `persist:webai-doubao` 分区持久。
2. **只支持一问一答纯文字**：长任务、多轮复杂推理、需要上传文件的场景不适用。
3. **只有一个站点薄壳**（豆包）：加站 = 加 `sites/*.mjs`，但要按 §5 重新实测选择器（别照抄）。
4. **只有一个场景 JSON**：第二场景（验证复用与串台隔离）是第 5 步。
5. **`answerSel` 之外的站点结构可能随版本变化**：改了 DOM 就重跑 `npm run selftest`，报错会指到具体选择器。

---

## 7. 三条硬约束（写死在代码里，不是建议）

- **renderer 无 Node**：`contextIsolation: true` + `nodeIntegration: false` + CSP `connect-src 'none'`。
- **桥只绑 `127.0.0.1`**：`server.listen(port, '127.0.0.1')`，且校验 remoteAddress 防 DNS rebinding。
- **错误必须分流**：严禁把 5 类失败混成一个"失败"，否则无法定位是登录、选择器、风控还是超时。

---

## 8. 已知取舍

- 用**窗口承载网页**而非 renderer 里的 `<webview>`：落实架构 §4.3「renderer 不得自建 webview」，也省一层 IPC 转发。
- 桥内核抽在 `core/` 而非塞进 `main.js`：为了能在没有 Electron 的环境里真跑验证——**这个项目已经吃过"写了不生效"的亏**。
- 网页窗口默认隐藏，只有「开登录窗」才显示：减少打扰，登录完即收起。
