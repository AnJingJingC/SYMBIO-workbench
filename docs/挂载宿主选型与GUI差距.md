# 挂载宿主选型 + 挂载后 GUI 差距

> 问题：GitHub 上不少基于 DSH（DeepSeek Harness）的 Desktop 项目，选哪个挂我们的作品？挂上去之后，离原作者那套工作台还差什么？
> 结论时间：2026-11-04 · 数据取自 GitHub API 实时查询
> 我方：`E:/SYMBIO`（标准 DSH 形态：10 技能 + 6 工具 + 六层记忆 + 自研免费 AI 桥）

---

## 0. 结论

**宿主选 `dataelement/dsh-desktop`。**

它是唯一把「工作台」做成**公开、可交付、可验收插件契约**的 DSH 桌面壳；我们的 10 个技能、6 个工具、记忆都能原样搬进去，自研壳降级成**伴生进程**（只跑免费 AI 桥），不改宿主一行代码。

代价：GUI 要重写成「一块业务面板」，宿主不提供多面板网格 / 拓扑画布 / 状态栏。

---

## 1. 候选盘点（实时数据）

| 仓库 | Stars | 语言 | 最近推送 | 许可 | 有工作台插件契约？ | 判定 |
|---|---:|---|---|---|---|---|
| **dataelement/dsh-desktop** | 17,210 | JavaScript | 2026-11-04 | MIT | ✅ `desktopWorkbenches.register` + 市场 + `install_local_workbench` | **选它** |
| dsh-market/dsh-market | 10,564 | TypeScript | 2026-11-04 | MIT | 是插件市场，不是壳 | 配件，装进宿主 |
| JustGenius-s/DSH-Desktop | 22 | TypeScript | 2026-10-11 | MIT | ❌ 纯壳，无面板契约 | 挂不上业务面板 |
| xiaoge200/dsh-desktop | 2 | Rust | 2026-09-19 | Apache-2.0 | ❌ 面向小白的一键壳 | 无扩展面 |
| fellow99/dsh-desktop | 1 | TypeScript | 2026-11-02 | MIT | ❌ 自称 reference implementation | **备选**：只有想 fork 改壳才选它 |
| mkt-agents/dsh-desktop | 0 | JavaScript | 2026-09-04 | 无 | ❌ | 排除：无许可证 |
| deepseek-ai/deepseek-harness | 271,436 | TypeScript | 2026-11-03 | MIT | 是我们作品的**运行时**，不是桌面壳 | 底座，不是宿主 |

差异不是"谁功能多"，而是**有没有地方插进去**：只有 dataelement 一家给出了「npm 包 + cordis.patch.yml + 服务端 entry + 客户端 `register()`」的完整契约，还配了市场验收规范和一键本地安装工具。

---

## 2. 为什么是它（五条硬理由）

1. **有公开契约，不用逆向。** `docs/workbench-standard.zh.md` 写清了包格式、`layout`、`customFrame`、`headerLayout`、服务端 `/api/<id>/` 前缀、`dshHomePath()` 数据目录、`desktopWorkbenchOwnership.read()` 归属校验。
2. **原生对话复用。** 宿主提供 `conversation` 节点，消息流 / 流式 / 工具确认 / 轨迹全归它。我们不做聊天 UI——这原本是工作量最大的一块。
3. **版本对得上。** 它跟 `@deepseek-ai/dsh@0.2.2-alpha.2`，我们是 0.2.1。技能是 markdown，工具是独立 node 脚本，都不走 Harness 内部 API，升级无痛；只有插件包按 0.2.2 写。
4. **它替我们兜住运维。** 安装包签名、自动更新、Safe Mode、崩溃恢复、诊断日志、手机扫码续聊——这些我们一个都没做，也轮不到我们做。
5. **17k stars、日更、MIT。** 不是玩票项目，也不是黑盒；真出问题可以 fork，但大概率不需要。

---

## 3. 我们的资产怎么落进去

| 我们的资产 | 挂载后位置 | 改造量 |
|---|---|---|
| `.dsh/skills/` 10 个技能 | 工作区里的 `.dsh/skills/`，Harness 原样加载 | **0** |
| `tools/` 6 个工具 | 工作台服务端 entry 包成 `/api/symbio/*` + 注册成 scoped Agent 工具 | 小：加一层包装，逻辑不动 |
| `memory/` 六层记忆 | 继续用文件；索引目录改到 `dshHomePath('symbio')` | 小：改路径常量 |
| `config/symbio.config.json` | 工作台插件 `config`（Schemastery schema） | 小 |
| `shell/` 自研壳 | **降级为伴生进程**：`npm run bridge`，无窗口，只开 31239 | **已完成（本轮）** |
| 主界面三面板 | 重写成工作台业务面板（React 单文件） | **大：新写** |

包结构（照规范）：

```
symbio-workbench/
├── package.json          # name + dsh.bundle.patch + dsh.client.{platform,inject}
├── cordis.patch.yml      # insert 一行，config.root = dshHomePath('symbio')
├── dsh/index.js          # 服务端：/api/symbio/*，注册 scoped 工具
└── lib/client.js         # 客户端单文件：desktopWorkbenches.register(...)
```

---

## 4. 三个必须知道的硬约束

### 4.1 宿主不是"没有 webview"，是"把 webview 收窄了"

它的侧栏浏览器走 `dshDesktop.protocolVersion = 1` + `browser` 桥，只暴露 `acquire(workspace)` / `release(lease)`；guest 被强制：无 Node、无 preload、contextIsolation、Chromium sandbox、**不允许嵌套 webview**、**分区随进程销毁（ephemeral）**。

我们的桥需要的是：持久 `persist:` 分区（保住登录态）+ `executeJavaScript` + `sendInputEvent` 打字。**三样都被挡。**

**所以不 fork、不硬撬，改成伴生进程**——我们自己的 Electron 只做桥，宿主只做 GUI，两边通过 `http://127.0.0.1:31239` 说话：

```
DSH Desktop（宿主：GUI / 对话 / 插件 / 会话）
        │  HTTP  POST /webai/ask   GET /health
        ▼
SYMBIO Bridge（伴生 Electron，--bridge-only，无窗口）
        │  BrowserWindow(show:false, partition=persist:webai-doubao)
        ▼
豆包 / 通义 / DeepSeek 网页版（用你自己的登录态）
```

这条路径**已经实测跑通**（见第 7 节），且与作者 `webai.mjs` 的 `31239 /webai/ask` 约定天然兼容。

### 4.2 宿主是 0.2.2-alpha.2，我们是 0.2.1

- 技能：markdown，无损。
- 工具：独立 node 脚本，无损。
- 插件包：按 0.2.2 写；`peerDependencies` 版本范围必须显式含预发布分支（如 `">=0.1.5-rc.2 <0.2.0-0"`），否则 `ERESOLVE`。

### 4.3 Windows 上宿主用 `ELECTRON_RUN_AS_NODE=1` 跑 Harness

它自己的机制（用 Electron 当 Node）。但如果由宿主 spawn 我们的桥，**必须走 `launch.mjs`**，不能直接 `electron main.js`——`launch.mjs` 会清掉这个变量，否则 Electron 退化成纯 Node，`import { BrowserWindow }` 直接崩。这个坑我们踩过。

---

## 5. 挂载后 GUI 差距（对比原作者那套工作台）

### 5.1 白拿的（宿主已经给了，作者是自己写的）

| 能力 | 作者工作台 | 挂载后 |
|---|---|---|
| 对话界面 | 自研 | **上游官方实现，更强**：流式、工具确认、轨迹、文件引用 |
| 左侧栏 / 工作区 / 会话管理 | 自研 | 宿主自带 |
| 插件市场 | 无 | **dsh-market，10.5k stars，一键装** |
| 工作台市场 | 无 | 宿主有，可投稿 |
| 模型设置 / 多供应商 | 配置级 | 宿主 GUI |
| Preset 导入导出 | 无 | `.dshpreset` 包，带冲突检查 |
| 手机扫码续聊 | 无 | 宿主自带（局域网 + 隧道） |
| Safe Mode / 崩溃恢复 / 诊断日志 | 无 | 宿主自带 |
| 标题栏 / 菜单 / 主题 / 托盘 | 自研 | 宿主 + 市场主题 |
| 签名分发 / 自动更新 | 无 | 宿主 |

### 5.2 仍缺的（四件硬的，只能自研）

| 差距 | 作者有 | 宿主给什么 | 我们怎么办 |
|---|---|---|---|
| **多面板网格** | 可拖拽的多面板布局 | 只有**一块**业务面板：`businessSide` left/right + `businessWidth` 0.25–0.7，或 `customFrame` 整页 | 在自己这一块里用 CSS Grid 做内部分栏。**跨宿主面板的自由拖拽做不到**——这是形态差异，不是工作量问题 |
| **2D 拓扑画布** | 场景节点 + 连线 + 亮灯 | 无 | 自研 SVG/Canvas，塞进面板的一个 tab |
| **常驻状态栏** | CPU / 内存 / 余额 / 桥在线 | 无状态栏；只有模型选择器 | 用 `headerLayout: 'compact'` 的工具栏 + 面板底栏自绘 |
| **多场景同屏** | 顶栏 tab，10+ 场景并列切换 | 一个工作台 = 一个会话归属，切换会建/换会话 | 能力等价（左侧栏切换），但**不能同屏并列两个场景** |

一句话：**从"缺一整层界面"缩到"缺 4 个可视件"，其中 1 个（多面板）是形态决定的，做不了。**

### 5.3 反超的（作者没有、我们挂上就有）

对话质量与交互、插件生态、工作台市场分发、手机接入、Safe Mode/崩溃恢复、签名与自动更新、插件契约的可验收性。

原作者的 200+ 工具 / 25 技能至今**未公开代码**；我们挂上去之后，"工具少"这个假差距会彻底消失——因为宿主生态里能装的插件远多于他一个人写的。

---

## 6. 推进路径

| 阶段 | 做什么 | 验收 | 估时 |
|---|---|---|---|
| **S1 挂载骨架** | 建包（4 文件）→ `pnpm pack` → `install_local_workbench` | 左侧栏出现「SYMBIO」，面板能显示 `/api/symbio/health` | 0.5 天 |
| **S2 面板成型** | 知识消化面板：今日卡片 / 待消化队列 / 记忆热度 / 桥状态 / 分区 | 真实内容不竖排、不裁切、窄窗可用 | 2–3 天 |
| **S3 工具接线** | 6 工具 → `/api/symbio/*` + scoped Agent 工具（`symbio_intake` / `symbio_recall` …） | 对话里能让 Agent 调工具读写同一份 state | 1–2 天 |

---

## 7. 本轮已实测（不是纸面推演）

改了两个文件，加了伴生模式：

- `shell/main.js`：新增 `--bridge-only`；此模式不抢单实例锁、不建窗口、不注册 IPC、macOS 隐藏 Dock、端口被占则非零退出。
- `shell/launch.mjs`：参数透传，`node launch.mjs --bridge-only` 可用。
- `shell/package.json`：新增 `npm run bridge`。

实测结果：

| 项 | 结果 |
|---|---|
| `node --check main.js / launch.mjs` | 通过 |
| `npm test`（站点回归 + 冒烟 + 契约） | 冒烟 **15/15**，契约**无死接口** |
| `npm run bridge` 起桥（无窗口） | `GET /health` → `{"ok":true,"sites":["doubao"],...}` |
| 伴生模式真实一问一答 | **第 2 问成功**：`{"ok":true,"text":"挂载成功","chars":4}` |

**已知缺口（必须记录，别当已解决）**：伴生模式**首问冷启动**返回 `selector-stale`——页面 hydrate 没完成就开始探测。第二问即恢复正常。待修项：首问失败自动重试一次 + 把 `waitHydrated` 前置到探测之前。

---

## 8. 一句话

宿主选 `dataelement/dsh-desktop`；我们把自研壳降级成"免费 AI 桥伴生进程"，把 10 技能 + 6 工具 + 六层记忆挂成**一块工作台面板**。GUI 上跟原作者的差距，从"一整层界面"变成"4 个可视件"，其中多面板网格是宿主形态决定的、做不了；其余三件可自研。换来的是对话、市场、手机、恢复、分发——这些他也没有。

---

## 附录：与 `Ebony-Vinyl/EAC-Desktop` 的对比（2026-11-04 实测查询）

| 维度 | dataelement/dsh-desktop | Ebony-Vinyl/EAC-Desktop |
|---|---:|---:|
| Stars / Forks | 17,210 / 594 | 2,353 / 80 |
| 最近推送 | 2026-11-04（当天） | 2026-10-30（5 天前） |
| Open issues | — | 19 |
| 壳技术 | Electron | **Tauri（Rust）+ Node sidecar** |
| 分层 | Main / Harness / Renderer | L1 Rust 壳 / L2 sidecar / L3 Harness / DPX 环境 |
| **业务面板挂载位** | ✅ `desktopWorkbenches.register()`，有规范、市场、本地安装工具、验收流程 | ❌ **无**。只有"皮肤契约"（control/style/slot），属呈现层 |
| 容器单位 | **工作台** = 会话归属 + 面板 + scoped 工具 + state.json + 市场分发 | 只有「插件」和「皮肤」，**没有工作台这一层** |
| 界面可定制面 | 一块业务面板（left/right，0.25–0.7 宽）或 `customFrame` 整页 | **6 个区域**：top/bottom/left/right-sidebar、session、overlay + 17 个预定义状态 |
| 适配的 Harness | 0.2.2-alpha.2 | 0.1.5-rc.2 ~ **0.2.1-rc.2**（更贴我们的 0.2.1） |
| 插件市场 | dsh-market（10,564★） | dsh-unified-market（聚合） |
| 保护/回滚 | Safe Mode + 崩溃恢复 | `dsh-plugin-shield` 快照/体检/回滚 |
| 启动动画 | 无 | `dsh-boot-animation` 全窗口片头 |
| 远程 | 手机配对 + 隧道 | 微信渠道 + P2P 加密远程 |
| 仓库治理 | 单一仓库，README 与 clone 地址一致 | **三个名字**：README 徽章指 `DSH-EAC/EAC-Desktop`（API 查无此仓）、clone 地址写 `says693/Deepseek-Harness-EAC`、实际仓库 `Ebony-Vinyl/EAC-Desktop` |

### 判断

**挂"作品"（有 GUI 的工作台）仍选 dataelement。** 原因不是它更强，而是 EAC **没有业务面板的挂载位**：

- EAC 的 6 个 region 是**壳层 chrome 的位置**（侧栏、状态条、浮层），`session` 区归 Harness 原生对话、不可覆盖；
- 皮肤契约由 `control.json`（区域/控件/状态声明）+ `layout.css`（结构）+ `tokens.css`（视觉）组成，能改布局与外观，但**挂的必须是契约里声明过的 control**，没有"注册任意外部 React 面板"的公开入口；
- 它没有"工作台"这个编排单位——没有会话归属、没有 scoped 工具装配、没有面板专属 state.json。我们的 6 工具 + 面板 + 记忆需要这个容器。

### EAC 真正更强的地方（不埋没）

1. **6 区域 + 17 状态**：做「状态灯」（loading/running/error/success）、底栏状态条、overlay 画布，比 dataelement 的单面板更接近作者的观感。
2. **开机动画**：作者有星云启动，dataelement 没有。
3. **版本更贴**：适配表到 0.2.1-rc.2，我们是 0.2.1。
4. **插件保护中心**：快照/体检/回滚，直接对上我们"稳定 > 记忆"的红线。
5. **DPX 环境隔离**：多环境分通道，对应我们"完全独立、不带旧数据"。

### 什么情况下改选 EAC

- 目标从"挂一块业务面板"变成"做一层深度定制的外观 / 状态可视化 / 多环境隔离"；
- 愿意吃 Tauri 栈（Rust + WebKitGTK），并且能接受去逆向 `mountContract: host-region-v1` 才能把第三方 UI 塞进 region；
- 能接受仓库治理不稳定（三个仓名、5 天未推送、19 个 open issue）。

在此之前，dataelement 仍是唯一「装了就能出现我们面板」的宿主。

---

## 附：安装程序入口（2026-11-04 实测）

最新稳定版 **v0.13.2**（2026-11-03 发布，非 prerelease），Windows x64 NSIS，代码签名：

| 通道 | URL | 备注 |
|---|---|---|
| **官网（国内优先）** | `https://dshdesktop.com/download/dsh-desktop-windows-x64-setup.exe` | 302 跳 ModelScope 国内镜像 |
| ModelScope 直链 | `https://modelscope.cn/models/alexyaojin/dsh-desktop/resolve/master/releases/latest/dsh-desktop-windows-x64-setup.exe` | 国内可直连 |
| GitHub 原链 | `https://github.com/dataelement/dsh-desktop/releases/download/v0.13.2/dsh-desktop-windows-x64-setup.exe` | 境外通道 |

- 大小 **280,634,760 字节（267.6 MB）**；三通道一致（GitHub HEAD 实测 `Content-Length: 280634760`）。
- 镜像 `latest.yml` 校验：`version: 0.13.2` / `releaseDate: 2026-11-03` / sha512 `bb/bh5wVpusxCG2q0N3JWzWVdU2/qIUtR79zoMwf8ShKLvufiX5BeoKJ20axHjzLPpdcoT29HAcruS+YugFnrA==`
- 同版另有 macOS arm64/x64 `.dmg`/`.zip`（345–357 MB）；**无 Linux、无 Windows ARM64**。
- v0.13.2 发布说明：Safe Mode 默认模型回退、凭据/会话损坏容错、陈旧锁恢复、Windows AppContainer 读权限与 GPU 沙箱兼容性修复 —— 对 Windows 装机有利。

### 本机现状（2026-11-04 查注册表）

- 已装 **DeepSeek Harness 0.2.1-rc.3** → `C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness`
- **未装 DSH Desktop**；当前无相关进程运行。
- DSH Desktop 使用独立 Electron userData 目录（`.../harness`）作为 DSH_HOME，与系统那套 CLI 版**并存不冲突**；但 `E:/SYMBIO` 的技能与记忆**不会自动继承**，装完后要手动把 `E:/SYMBIO` 加为工作区（正好符合「完全独立、不带旧数据」红线）。
