# SYMBIO 工作台 · DSH Desktop 业务面板（v0.5.0）

把 `E:/SYMBIO` 的六层记忆、12 个技能、15 个本机工具（面板可点 6 个）、**三层库（共享技能 / 零件 / 项目台账）** 与免费 AI 桥，挂进 `dataelement/dsh-desktop` 的**四处宿主座位**。两个场景：**知识消化**（资料 → 可检索知识卡片）与 **深度调研**（问题 → 有证据的答案），跨场景派单走文件总线 + 命令路由。

- **业务面板**占左侧 60%，**右侧对话完全复用宿主原生 UI**；顶部状态栏吸顶常驻
- **常驻状态条**（`shell.overlay`）：右下角一条胶囊，跨页可见，**不可点击、不挡任何宿主按钮**
- **协同总览页**（`sidebar.panellist` + `main`）：侧栏一个准星入口，点开是全局视图——谁在干活、机器扛不扛得住、三层库长什么样
- 安装：宿主 `install_local_workbench({ path: "<本包>.tgz", replace: true })`，返回 `applied` **并重启 Harness** 才真正接管（详见 `INSTALL-PROMPT.txt`）
- 身份：本地安装时由宿主派生为 `local:symbio-workbench`；`repository` 已指向本仓库，供市场索引溯源
- **只读**：面板不写入、不迁移、不复制 `E:/SYMBIO` 的任何业务数据

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

1. **`main` 是切换，不是同屏。** 点侧栏入口会把中央区换成总览页，业务面板不在了（真机实测 `panelProbe` 同时转 `false`）。真同屏要另找 dockkit 浮动面板。
2. **常驻状态条不可交互。** overlay 是全帧表面，`pointer-events` 恒为 `none` —— 一条状态条绝不该让宿主自己的按钮点不动。所以它只放三件「一眼读完」的事，不放按钮。

接入形状（`ctx.slots` 直接读会抛 `cannot get property "slots" without inject`，必须走门面）：

```js
const slots = ctx.get('slots')                       // 免声明查询
slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'symbio-status', order: 900 }, StatusBar))
slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: 'symbio-overview', order: 900 }, SceneEntry))
slots.inject('main', () => slots.register({ name: 'main', key: 'symbio-overview' }, OverviewPage))  // keyed 用 key
```

拿不到 `slots` 时**只降级这三处附加座位，业务面板照旧挂载** —— 这条路径有测试锁（`test/contract.test.mjs`）。

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
cordis.patch.yml      插件条目；root 用 dshHomePath，dataRoot 指向 E:/SYMBIO
dsh/index.mjs         服务端入口，Schemastery Config，注册 /api/symbio/*
src/api.mjs           路由、桥探测、请求体兼容读取
src/state.mjs         业务状态只读解析器（逐文件容错，issues 不编造；含三层库与活动心跳）
src/tools.mjs         6 个白名单工具的受限运行器（/load 也复用它，不另开口子）
lib/client.js         __ModuleLoader__.load + desktopWorkbenches.register，React 面板（含亮灯/负载胶囊/库区块）
test/                 契约 / 解析 / 降级 / 转发 / 标识符遮蔽回归 / 无头渲染冒烟 / 亮灯 TTL / 负载失败态，共 39 项
INSTALL-PROMPT.txt    可直接粘进 DSH Desktop 的升级安装提示词
```

业务根 `E:/SYMBIO/tools/` 另有 9 个**多参数 Worker**（`intake` / `bus` / `autopilot` / `lint-weekly` /
`shared-skill` / `parts` / `project` / `route` / `sync-publish`）。它们不在面板工具箱里——单输入框表达不了
`--skill --from --note` 这类多参数命令，硬塞进去会变成"看得见点不动"。面板改为在「共享层 · 库」区块
展示它们的只读摘要，操作走 CLI 或宿主 Agent 技能。

## 配置

`dsh/index.mjs` 的数据根优先级：`process.env.SYMBIO_HOME` → `config.dataRoot` → `E:/SYMBIO`。
换机器时设环境变量即可，不用改包。`bridgeUrl` 默认 `http://127.0.0.1:31239`。

## 校验与打包

```sh
npm run verify     # 5 文件语法检查 + 39 项自测（全绿才可发布）
pnpm pack          # → symbio-workbench-0.5.0.tgz
```

## 安装

安装被宿主唯一授权给 Plugin Manager（`install_local_workbench` → `installBundle`），外部 Agent 不能代做。
把 `INSTALL-PROMPT.txt` 全文粘进 DSH Desktop 新会话即可。同名升级用 `replace: true`；**只有 `application === 'applied'` 算生效**。

伴生桥（可选，不启动面板也能用）：

```sh
cd E:/SYMBIO/shell && npm run bridge
```

## 还没做的 / 诚实边界

- **工具箱接入宿主 Agent**：dsh-desktop 工作台契约只给「面板 + `/api/symbio/*` 路由」，`DshClientManifest.inject` 明确「不是 Cordis 服务注入」，**没有**宿主 Agent 工具注册服务。但 12 个技能中已有 10 个通过 `node tools/*.mjs` 在对话间接触发这些工具，且本版把工具箱做成 `GET /api/symbio/tools` 机器可读清单 + `POST /api/symbio/tools/run` 可调用面（详见 `docs/工具箱-宿主Agent接入.md`）。要更严格的「Agent 原生工具」集成，需等 dsh-desktop 开放对应契约。
- **多面板：从「未验证」到「已实测」（v0.5.0 更新）**：`sidebar.panellist`（list）+ `main`（keyed）确为官方多面板机制，已由座位探针 0.1.3 在真机逐条验证四行全 `ok:true`，本版据此接上常驻状态条与协同总览页。**但仍有一条限制**：`main` 是按 key **切换**中央面板，不是同屏并列——点开总览页时业务面板会被替换。真同屏要另找 `dockkit` 浮动面板（其 `.d.ts` 不在开源 npm 包内，仍需真机试）。证据见 `reports/座位探针-验收定稿.json` 与 `docs/外壳路线评估.md`。
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
