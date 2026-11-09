# SYMBIO 工作台 · DSH Desktop 业务面板（v0.5.4）

DSH Desktop 的一个工作台插件：**把「你在 DSH 里做的事」摆到四个能看见的地方**——业务面板、右下角常驻状态条、左侧栏入口、协同总览页。装一次，四处同时亮。

在主面板里，长文进 → 六层记忆消化 → 出可检索的知识卡片；另一个场景「深度调研」走同一条链路，问题进 → 有证据的答案出，跨场景派单走文件总线 + 命令路由。

能力来自工作台根目录（按 `SYMBIO_HOME` → 插件配置 `dataRoot` → 包同位目录 → 历史默认 `E:/SYMBIO` 依次探测；四步都没命中时面板直说「未配置」，不拿一个猜出来的盘去凑数字）：六层记忆、12 个技能、16 个本机工具（面板可点 6 个）、**三层库（共享技能 / 零件 / 项目台账）** 与免费 AI 桥。

- **业务面板**占左侧 60%，**右侧对话完全复用宿主原生 UI**；顶部状态栏吸顶常驻
- **常驻状态条**（`shell.overlay`）：右下角一条胶囊，跨页可见，**不可点击、不挡任何宿主按钮**
- **协同总览页**（`sidebar.panellist` + `main`）：侧栏一个准星入口，点开是全局视图——谁在干活、机器扛不扛得住、三层库长什么样
- 安装：宿主 `install_local_workbench({ path: "<本包>.tgz", replace: true })`，返回 `applied` **并重启 Harness** 才真正接管（详见 `INSTALL-PROMPT.txt`）；包可直接下载，见下文「安装」
- 身份：本地安装时由宿主派生为 `local:symbio-workbench`；`repository` 已指向本仓库，供市场索引溯源
- **读写边界（别被"只读"两个字误导）**：读接口（health / state / activity / load / tools）**只读**业务根——不创建、不迁移、不复制目录树；**写只发生在你按下的两个动作上**：落一张卡（`/intake`）、跑一个工具（`/tools/run`，其中 `intake`、`index-build` 会写盘，白名单外一个都跑不了）。

---

## v0.5.4 修了什么（面板终于说真话的三处）

三处都不是新功能，是**面板上看到的数字/颜色与实际不符**，属于「看起来对，其实没接上」：

| 问题 | 症状 | 现在 |
|---|---|---|
| 今日花费永远是 0.00 | 台账写的是 `spendCNY`（`spend-guard.mjs`），面板读的是 `totalCNY` / `spentCNY` → 真记账后仍显示空 | 以**实际写入方为准**（`spendCNY`），旧字段保留兼容；并把**免费桥调用次数**一并上屏（「免费桥 17 次（失败 5）」）——钱是 0 不等于没干活，这两件事过去在面板上长得一模一样 |
| 三盏灰灯没有解释 | `symbio-portrait` / `symbio-part` / `symbio-evolve` 是 C 层技能，会改写宿主画像或联网装外部零件，按设计默认不启用；面板只画一个灰点，用户分不清「有意关着」和「缺件」 | `/state` 新增 `assets.skillStages`（从各 `SKILL.md` 的 `metadata.stage` 读真实值），C 层画**虚线圈**并附一行说明（名单按实际扫描结果生成，本机 4 个——另有 `symbio-rollback`）；三个技能文档也各自写明默认状态。缺件仍是「直接不出现」，两种状态不再混为一谈 |
| 默认站与代码不一致 | 0.5.3 把默认站改成 `deepseek`，实测 10 次调用失败 4（40%，全是首帧 30s 超时），每次白等 30 秒才切站 | 面板 `/ask`、桥登录、收窗三处随包改为 **`qianwen`**（换站链 `deepseek → doubao → zhipu` 保留）；实测 14.3 秒 / 1 次调用 / 0 失败 |

配套：契约仍 44/44（新增 4 条断言：`spendCNY` 必须能读、`free` 计数、`skillStages` 取值、读不到时如实为 `null`）。

> **装机说明**：本版仍无新页面，差异只在「数字对不对、灰灯有没有解释」。宿主需重启 Harness 才生效。

---

## v0.5.3 修了什么（默认站点与换站兜底）

界面零改动，只换「派谁去干脏活」的默认值：

| 问题 | 原来 | 现在 |
|---|---|---|
| 默认站点打 doubao | 体检报告里 6 次失败全是 doubao 首帧 `empty-answer` | 消化 / 派单路由 / 面板 `/ask` 与桥登录**三处统一**默认 `deepseek` |
| 换默认等于赌单点 | 一个站点挂了就把整篇丢进 `_failed` | 主站失败自动按 `qianwen → deepseek → doubao → zhipu` 换站重试，日志留痕；四个全挂才报错。实测用无效站点投料能自动切 qianwen 落卡 |

为什么还要兜底：deepseek 在长材料上也出现过首帧超时，qianwen 实测最稳；换默认是宿主的决定，稳定性不该由单点承担。
> 后续：0.5.4 按台账实测（deepseek 40% 首帧超时）把默认站改回 `qianwen`，见上一节。
配套：工具层自测 34 → **39** 项（站点默认值与换站链回归断言）。契约仍 44/44。

> **装机说明**：本版界面与 0.5.2 完全一致，仅接口默认值变化。**不升级不影响现有工作流**（宿主仍显示 v0.5.2 属正常）；下次安装时自然生效。

### v0.5.2：初始化与索引误报

两件事，都属于「把包给别人用」时才会撞到的：

| 问题 | 症状 | 现在 |
|---|---|---|
| 全新机器装完是个空壳 | `memory/` 永远不同步（里面有个人画像），从仓库拿到手的只有代码；面板数字全是「—」，用户分不清是少目录还是装坏了 | 新增 `node tools/setup.mjs`（只读体检）与 `--fix`（**只补不覆盖**）：一条命令补出六层记忆、宪法红线、场景五件套、看板台账；幂等，已有文件一个字节都不碰 |
| 空工作台一开局就挂红点 | 卡片目录还没有 `索引.md`（派生件，由 `index-build` 生成），却被当成「缺件」记进 `issues` | 索引缺失分两种看待：**没有卡片** = 正常（不报）；**有卡片没索引** = 真断链（报）。加回归断言同时锁住两头 |

配套：契约 43 → **44** 项（新增"空卡片目录不算索引缺失"）。

### v0.5.1：对外可用性

上一版能跑，但把包发给别人会踩四个坑。v0.5.1 全部堵上：

| 问题 | 原来 | 现在 |
|---|---|---|
| 数据根写死 | `cordis.patch.yml` 里 `dataRoot: 'E:/SYMBIO'`，装到别人机器直接指向不存在的目录 | patch 不写盘符；`resolveDataRoot` 按 5 步探测，探不到就明说「未配置」并给填法 |
| 不知道数字从哪来 | 页脚只显示路径 | 页脚同时显示**来源**（环境变量 / 插件配置 / 包同位 / 历史默认），并进 `/health` 的 `dataSource.source` |
| 说「只读」但会写盘 | README 写「不写入任何业务数据」，可 `/intake` 落卡、`/tools/run` 跑 `index-build` 都在写 | 改成分层表述：读接口只读，写只发生在两个显式动作上 |
| 包的身份没说清 | 文档没讲"包里只有插件、没有 tools/shell/memory" | 写进「诚实边界」首条，并说明装完没配根时长什么样 |

---

## 四处座位是怎么来的

前三个不是猜的，是 `seat-probe/` 探针包在真机上逐条验过的（2026-11-05，四行全 `ok:true`）：

| 座位 | 用途 | 本版怎么用 |
|---|---|---|
| `desktopWorkbenches` | 业务面板（宿主封装，单槽） | 知识消化工作台，能力不变 |
| `shell.overlay`（list） | 全帧浮层，跨页常驻 | 常驻状态条：亮灯 / 负载 / 待办 |
| `sidebar.panellist`（list） | 侧栏图标 | 「协同总览」入口 |
| `main`（keyed） | 中央面板，按侧栏 id 选择 | 协同总览页，key 与上者同名 |

**两条形态限制，别误解：**

1. **`main` 是切换，不是同屏。** 点侧栏入口会把中央区换成总览页，业务面板不在了（真机实测 `panelProbe` 同时转 `false`）。真同屏在现有座位里没有空位（2026-11-07 解析宿主 SlotMap 共 100 条座位后确认）：并列只能靠接管 `shell.bottom`（会 shadow inspector）或改 patch.yml；不接管的话，能做的是在 `shell.overlay` 里放可开合浮动面板。`node tools/dev/slots-map.mjs` 可自查全表。
2. **常驻状态条不可交互。** overlay 是全帧表面，`pointer-events` 恒为 `none` —— 一条状态条绝不该让宿主自己的按钮点不动。所以它只放三件「一眼读完」的事，不放按钮。

接入形状（`ctx.slots` 直接读会抛 `cannot get property "slots" without inject`，必须走门面）：

```js
const slots = ctx.get('slots')                       // 免声明查询
slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'symbio-status', order: 900 }, StatusBar))
slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: 'symbio-overview', order: 900 }, SceneEntry))
slots.inject('main', () => slots.register({ name: 'main', key: 'symbio-overview' }, OverviewPage))  // keyed 用 key
```

拿不到 `slots` 时**只降级这三处附加座位，业务面板照旧挂载** —— 这条路径有测试锁（`test/contract.test.mjs`）。

### 真机验收（2026-11-07，v0.5.0）

宿主安装返回 `applied` 不等于已接管（这是本项目踩过两次的坑），所以验收分两段：先核磁盘，再重启看界面。

**磁盘侧（重启前就能定论）**：`desired.json` = `symbio-workbench+0.5.0+…`；`web/node_modules` 软链指向该代际；代际内 `client.js` 的 md5 与构建源**逐字节一致**；`dsh.bundle.patch` / `dsh.client.inject` 形状正确；50 个 className 全部有对应 CSS 规则。

**界面侧（五项全过）**：

| # | 观察项 | 结果 |
|---|---|---|
| 1 | 业务面板顶栏徽标 | `v0.5.0` —— 该数字来自服务端 `/api/symbio/health`，说明**服务端模块也换了代际**，不只是前端 bundle 刷新 |
| 2 | 右下角常驻胶囊 | 在，且可穿透（`pointer-events:none` 生效） |
| 3 | 侧栏准星 | 在 |
| 4 | 点准星 → 协同总览页 | 可切可回 |
| 5 | **业务面板本体** | 与 0.4.0 完全一致，**零牵连** |

**灯亮闭环**：心跳即数据源，不需要起 AI 桥。写入一条 `ttlMs=45000` 的心跳后，活动接口读到 `active=1 / phaseLabel「思考中」`，胶囊显示「1 处活动 · 联调 思考中」，圆点亮起、文字呼吸，TTL 到点自动回到「全场空闲」、绿点消失。这条已写成断言（含"灯不可读 ≠ 全场空闲"的区分），不靠肉眼看一次就算。

> 回滚路径：`symbio-workbench-0.4.0.tgz`（从 0.4.0 代际原样重打，不含任何座位代码）。本次未使用。

---

## 这一版有什么

| 区块 | 数据来源 | 空/失败时 |
|---|---|---|
| 四个指标胶囊（未闭环任务 / 知识卡片 / 记忆文件 / 今日花费） | 任务看板、cards/、memory/、花费台账 | 显示 `—` + 原因，不补假值 |
| 知识消化工作流（当前交接 / 未闭环队列 / 下一步） | `当前交接.md`、`任务看板.md` 原文 | 如实说明文件不可读 |
| 知识卡片 | `cards/*.md` 真实扫描 | 明确「还没有第一张知识卡片」的真实空状态 + 真实下一步 |
| 免费 AI 桥（状态灯 / 统计 / 试问一句） | `127.0.0.1:31239/health`、`/webai/ask` | 离线时禁止发送，回答原样返回 |
| 六层记忆分布 | `memory/` 五层递归统计 | — |
| **亮灯（活动心跳）** | `memory/10-shared/心跳/*.json`，带 TTL | 灯灭（无活动是正常状态，不报故障） |
| **负载胶囊（CPU / 内存）** | `tools/load-gate.mjs --json`，15s 缓存 | 显示 `负载 —` + 原因，**绝不编一个"看起来正常"的数字** |
| **共享层 · 库**（共享技能数 / 零件数 / 项目数 / 活跃场景） | `memory/10-shared/skills/`、`parts/`、`projects/`、心跳 | 目录缺失时 `available:false` + 原因 |
| **系统拓扑 + 实时亮灯** | 静态流水线 + 心跳映射到节点 | 无活动时纯静态图 |
| 已挂载资产 / 五条红线 | `.dsh/skills`、`tools`、`AGENTS.md`/`REDLINES.md` | 资产不可读时显示 `—（数据源不可读）` |
| 数据源诊断 | `readState()` 的 `issues[]` | 列出每个读不到的路径与错误码 |

**事实红线**：所有数字来自真实文件解析。数据源不可读时，接口返回 `null` 与 `issues`，面板显示「—」和具体原因，**绝不用设计清单冒充实时值**。

---

## 长文 → 知识卡片（端到端）

`symbio-intake` 技能负责把长文消化成 ≤1200 字的卡片；**落卡与索引重建由确定性 Worker 统一执行**，三步打通：

1. 宿主技能 / 免费 AI 桥产出卡片正文（LLM 消化，不在工作台内做）。
2. 落卡：`node tools/intake.mjs --title … --source … --body "$(cat card.md)"`，或面板「摄入长文 · 落卡」卡片粘贴正文 → POST `/api/symbio/intake`。
3. Worker 顺序执行：隐私闸（L1 硬拦）→ 字数闸（≤ `limits.cardMaxChars`）→ 防覆盖写盘（`cards/YYYY-MM-DD-<slug>.md`）→ 自动 `index-build` 重建索引。面板刷新后即出现在「知识卡片」。

> 摄入 Worker 不负责 LLM 消化：只收 `body`（已消化好的正文）。只传 `text` 会被 422 退回，提示先消化。

---

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/symbio/health` | 版本、身份、设计清单、五红线、数据源可达性、桥状态 |
| GET | `/api/symbio/state` | 完整业务状态（配置/队列/卡片/记忆/交接/台账/资产/宪法/**三层库/活动心跳**/issues） |
| GET | `/api/symbio/activity` | 亮灯：活跃场景 + 阶段 + 剩余 TTL（5s 轮询，只读几个小 JSON） |
| GET | `/api/symbio/load` | 负载胶囊：CPU/内存/判定（复用白名单运行器，**15s 缓存**，失败不编数） |
| GET | `/api/symbio/bridge/health` | 单独探桥 |
| POST | `/api/symbio/bridge/login` | 把站点窗口显出来手动登录（绝不代填/不自动登录） |
| POST | `/api/symbio/bridge/hide` | 登录完成后收回窗口，登录态保留 |
| GET | `/api/symbio/tools` | 列出 6 个本机工具（名称/形态/flag） |
| POST | `/api/symbio/tools/run` | 白名单内运行工具（无 shell，参数净化） |
| POST | `/api/symbio/ask` | `{site?, question}` → 转发桥 `/webai/ask`，原样回结果 |
| POST | `/api/symbio/intake` | `{title?, source?, body}` → 确定性落卡 + 索引重建；`body` 为空或只传 `text` 会拒绝 |

`/ask` 只做类型与长度（≤2000 字）约束；**机密拦截由伴生桥的 `secret-gate` 负责**（唯一闸口，不在面板重复实现）。桥不可达时返回 503 并明确「未发送任何内容」，不编造答案。

> ⚠️ 「试问一句」会把文字真的发给豆包网页端。面板上常驻外发提示，请勿输入隐私内容。

---

## 文件

```
package.json          dsh.bundle.patch + dsh.client.{platform,inject} + exports
cordis.patch.yml      插件条目；root 用 dshHomePath，**不写死 dataRoot**（包不带数据，写死盘符会把别人机器指到不存在的目录）
dsh/index.mjs         服务端入口，Schemastery Config，注册 /api/symbio/*
src/api.mjs           路由、桥探测、请求体兼容读取
src/state.mjs         业务状态只读解析器（逐文件容错，issues 不编造；含三层库与活动心跳）
src/tools.mjs         6 个白名单工具的受限运行器（/load 也复用它，不另开口子）
lib/client.js         __ModuleLoader__.load + desktopWorkbenches.register，React 面板（含亮灯/负载胶囊/库区块）
test/                 契约 / 解析 / 降级 / 转发 / 标识符遮蔽回归 / 无头渲染冒烟 / 亮灯 TTL / 负载失败态 / 亮灯文案与呼吸动画，共 44 项
INSTALL-PROMPT.txt    可直接粘进 DSH Desktop 的升级安装提示词
```

业务根 `E:/SYMBIO/tools/` 另有 9 个**多参数 Worker**（`intake` / `bus` / `autopilot` / `lint-weekly` /
`shared-skill` / `parts` / `project` / `route` / `sync-publish`）。它们不在面板工具箱里——单输入框表达不了
`--skill --from --note` 这类多参数命令，硬塞进去会变成"看得见点不动"。面板改为在「共享层 · 库」区块
展示它们的只读摘要，操作走 CLI 或宿主 Agent 技能。

## 配置

数据根**不在包里写死**，按这个顺序探测（`src/api.mjs` 的 `resolveDataRoot`）：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `process.env.SYMBIO_HOME` | 换机器只需设这个，不用改包 |
| 2 | 插件配置 `dataRoot` | 宿主 patch 或用户在插件设置里填 |
| 3 | 包同位目录 | 开发/自托管布局：`<repo>/workbench/dsh/index.mjs` 上跳两级，且 `<repo>` 下同时有 `memory/` 与 `tools/` |
| 4 | 历史默认 `E:/SYMBIO` | **只在这台机器真实存在时采用** |
| 5 | 未配置 | `/health` 回 `dataSource.source = "unset"`，面板顶栏显示「数据源 未配置」并给出填法，读接口回 503 |

面板页脚会把最终根**和它的来源**一起显示（`环境变量 / 插件配置 / 包同位 / 历史默认`）——装完数字全是「—」时，先看这一行，
不用去查文件权限。`bridgeUrl` 默认 `http://127.0.0.1:31239`。

## 校验与打包

```sh
npm run verify     # 5 文件语法检查 + 44 项自测（全绿才可发布）
pnpm pack          # → symbio-workbench-0.5.0.tgz
```

## 安装

安装被宿主唯一授权给 Plugin Manager（`install_local_workbench` → `installBundle`），外部 Agent 不能代做。
把 `INSTALL-PROMPT.txt` 全文粘进 DSH Desktop 新会话即可。同名升级用 `replace: true`；**只有 `application === 'applied'` 算生效**。

包可以直接下载，不必 clone 后自己 pack：

```
https://github.com/AnJingJingC/SYMBIO-workbench/raw/main/symbio-workbench-0.5.0.tgz
```

仓库根的 `.tgz` 只放**当前版本**一个（旧版本会让人装到比源码旧的包）；`node tools/sync-publish.mjs` 同步时会核对包内
`package.json` 的版本与源码是否一致，并在根上出现旧版本包时报警。

伴生桥（可选，不启动面板也能用；路径换成你的工作台根）：

```sh
cd "$SYMBIO_HOME/shell" && npm run bridge     # 先 export SYMBIO_HOME=<你的工作台根>
```

## 还没做的 / 诚实边界

- **这个包只带"看的"那半，不带"做的"那半**：`.tgz` 里只有插件本体（`dsh/`、`src/`、`lib/`），工作台根下的 `tools/`（16 个 Worker）、`shell/`（免费 AI 桥）、`memory/`、`config/` 都**不在包内**——它们是数据与伴生进程，按设计由用户自己那份工作台提供。所以装完包、没配好根，面板会亮但数字全是「—」并显示「数据源 未配置」；这不是装坏了，是缺根。完整的"从零到能用"要走 `INSTALL.md` 的初始化步骤。

  **最快的补救是一条命令**（在工作台根下）：
  ```bash
  node tools/setup.mjs          # 先看缺什么，只读不写
  node tools/setup.mjs --fix    # 补建六层记忆 + 场景五件套 + 看板台账（只补不覆盖）
  ```
  它会逐项告诉你缺哪件、怎么补，跑完面板数字从「—」变成 0，体检 FAIL 0。
- **工具箱接入宿主 Agent**：dsh-desktop 工作台契约只给「面板 + `/api/symbio/*` 路由」，`DshClientManifest.inject` 明确「不是 Cordis 服务注入」，**没有**宿主 Agent 工具注册服务。但 12 个技能中已有 10 个通过 `node tools/*.mjs` 在对话间接触发这些工具，且本版把工具箱做成 `GET /api/symbio/tools` 机器可读清单 + `POST /api/symbio/tools/run` 可调用面（详见 `docs/工具箱-宿主Agent接入.md`）。要更严格的「Agent 原生工具」集成，需等 dsh-desktop 开放对应契约。
- **多面板：从「未验证」到「已实测」（v0.5.0 更新）**：`sidebar.panellist`（list）+ `main`（keyed）确为官方多面板机制，已由座位探针 0.1.3 在真机逐条验证四行全 `ok:true`，本版据此接上常驻状态条与协同总览页。**但仍有一条限制**：`main` 是按 key **切换**中央面板，不是同屏并列——点开总览页时业务面板会被替换。真同屏并列在现有座位里没有空位：`dockkit` 是宿主内部 UI 包、既非座位也非服务，动态插件拿不到（已查实），而 `shell.bottom` 被 inspector 占用。三条路见 `docs/外壳路线评估.md`。证据见 `reports/座位探针-验收定稿.json` 与 `docs/外壳路线评估.md`。
- **`rightbar` 不能用**：它已被宿主右栏占用（契约原文 "OCCUPIED by the right Sidebar"），注册会**替换**右栏而不是并排——而且不会报错。同理 `root` 明令禁止注册（会 shadow 整个 frame）。
- 桥的登录态长期稳定性未验收（需手动登录一次后复验；cookie 存在站点分区里，重启桥不丢）
- 四个站点（豆包 / DeepSeek / 通义千问 / 智谱）**已全部真机校准** `verified: true`。注意网页 AI 随时改版，选择器失效时用 `node probe-site.mjs <site> --input/--answer <候选>` 现场重试，不要靠改代码猜。

## 分发与市场收录（v0.5.0 定案）

本仓库（`AnJingJingC/SYMBIO-workbench`）就是这个工作台的源码与发行仓：仓库根 = 包本体（`package.json`/`dsh`/`src`/`lib`），配套 `tools`/`shell`/`docs`/`config`/`.dsh/skills` 一并公开；`memory/` 属个人数据，**不入库**。

| 字段 | 位置 | 值 | 作用 |
|---|---|---|---|
| `repository` | `package.json` | `https://github.com/AnJingJingC/SYMBIO-workbench` | 市场按此拉源码 / 溯源 |
| `id` | `cordis.patch.yml` | `symbio-workbench` | 插件稳定标识（本地装才被加 `local:` 前缀） |
| `icon` | `package.json` + `icon.svg` | 突触节点图标（≤256KiB） | 市场卡片展示 |
| `author` | `package.json` | SYMBIO Workbench contributors | 市场展示 |

> **mydsh.xyz 的真实规则**（已核实其站点源码与 `trust` 页）：它是**纯索引站，不托管任何文件**，所有条目指向 GitHub 原仓库；「＋上传」通道当前关闭（`UPLOAD_OPEN = false`）。因此**上架 = 申请收录**，操作是在 `mashanglinyu/luanyujia-workbench` 的 Issues 里提交仓库地址与简介，核实后 48 小时内处理。安装包（`.tgz`）不入库、不上传，由本机 `pnpm pack` 产出。

**收录状态**：本仓库已通过 [Issue #2](https://github.com/mashanglinyu/luanyujia-workbench/issues/2) 申请收录（2026-11-04 提交，承诺 48 小时内处理）。收录后索引条目指向本仓库本身；仓库说明有变更时再开 Issue 提出更正即可。

本机安装 / 升级流程：`pnpm pack` 产出 `.tgz` → 宿主 `install_local_workbench({ path, replace: true })`，返回 `application === 'applied'` 才算生效。**安装包不随仓库分发**，请从本仓库源码自行 `pnpm pack` 产出——这样你装的就是当前源码，不会拿到被改动或已过期的包。

MIT
