# SYMBIO 工作台 · DSH Desktop 业务面板（v0.3.7）

把 `E:/SYMBIO` 的六层记忆、11 个技能、6 个工具与免费 AI 桥，挂进 `dataelement/dsh-desktop` 的一块业务面板。两个场景：**知识消化**（资料 → 可检索知识卡片）与 **深度调研**（问题 → 有证据的答案），跨场景派单走文件总线。

- 业务面板在左 60%，**右侧对话完全复用宿主原生 UI**；顶部状态栏吸顶常驻
- 安装：宿主 `install_local_workbench({ path: "<本包>.tgz", replace: true })`，返回 `applied` 即生效（详见 `INSTALL-PROMPT.txt`）
- 身份：本地安装时由宿主派生为 `local:symbio-workbench`；`repository` 已指向本仓库，供市场索引溯源
- **只读**：面板不写入、不迁移、不复制 `E:/SYMBIO` 的任何业务数据

---

## 这一版有什么

| 区块 | 数据来源 | 空/失败时 |
|---|---|---|
| 四个指标胶囊（未闭环任务 / 知识卡片 / 记忆文件 / 今日花费） | 任务看板、cards/、memory/、花费台账 | 显示 `—` + 原因，不补假值 |
| 知识消化工作流（当前交接 / 未闭环队列 / 下一步） | `当前交接.md`、`任务看板.md` 原文 | 如实说明文件不可读 |
| 知识卡片 | `cards/*.md` 真实扫描 | 明确「还没有第一张知识卡片」的真实空状态 + 真实下一步 |
| 免费 AI 桥（状态灯 / 统计 / 试问一句） | `127.0.0.1:31239/health`、`/webai/ask` | 离线时禁止发送，回答原样返回 |
| 六层记忆分布 | `memory/` 五层递归统计 | — |
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
| GET | `/api/symbio/state` | 完整业务状态（配置/队列/卡片/记忆/交接/台账/资产/宪法/issues） |
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
src/state.mjs         业务状态只读解析器（逐文件容错，issues 不编造）
src/tools.mjs         6 个白名单工具的受限运行器
lib/client.js         __ModuleLoader__.load + desktopWorkbenches.register，React 面板
test/                 契约 / 解析 / 降级 / 转发 19 项自测
INSTALL-PROMPT.txt    可直接粘进 DSH Desktop 的升级安装提示词
```

业务根 `E:/SYMBIO/tools/` 另有摄入 Worker `intake.mjs`（确定性落卡，不在包内、不计入 6 个面板工具）。

## 配置

`dsh/index.mjs` 的数据根优先级：`process.env.SYMBIO_HOME` → `config.dataRoot` → `E:/SYMBIO`。
换机器时设环境变量即可，不用改包。`bridgeUrl` 默认 `http://127.0.0.1:31239`。

## 校验与打包

```sh
npm run verify     # 4 文件语法检查 + 19 项自测
pnpm pack          # → symbio-workbench-0.3.2.tgz
```

## 安装

安装被宿主唯一授权给 Plugin Manager（`install_local_workbench` → `installBundle`），外部 Agent 不能代做。
把 `INSTALL-PROMPT.txt` 全文粘进 DSH Desktop 新会话即可。同名升级用 `replace: true`；**只有 `application === 'applied'` 算生效**。

伴生桥（可选，不启动面板也能用）：

```sh
cd E:/SYMBIO/shell && npm run bridge
```

## 还没做的 / 诚实边界

- **工具箱接入宿主 Agent**：dsh-desktop 工作台契约只给「面板 + `/api/symbio/*` 路由」，`DshClientManifest.inject` 明确「不是 Cordis 服务注入」，**没有**宿主 Agent 工具注册服务。但 10 个技能已 `node tools/*.mjs` 在对话间接触发这些工具，且本版把工具箱做成 `GET /api/symbio/tools` 机器可读清单 + `POST /api/symbio/tools/run` 可调用面（详见 `docs/工具箱-宿主Agent接入.md`）。要更严格的「Agent 原生工具」集成，需等 dsh-desktop 开放对应契约。
- **多面板网格 / 多场景同屏**：宿主只给一块业务面板注册位（`desktopWorkbenches.register`），右侧永远是宿主原生会话，做不到。已在单面板内用响应式两列网格 + 吸顶状态栏 + 内嵌拓扑图逼近观感（见 `docs/GUI边界评估.md`）
- 桥的登录态长期稳定性未验收（需手动登录一次后复验）
- DeepSeek / 通义千问 / 智谱三个站点选择器为经验猜测（`verified: false`），需本机 `node probe-site.mjs <site>` 校准后才可依赖

## 分发与市场收录（v0.3.7 定案）

本仓库（`AnJingJingC/SYMBIO-workbench`）就是这个工作台的源码与发行仓：仓库根 = 包本体（`package.json`/`dsh`/`src`/`lib`），配套 `tools`/`shell`/`docs`/`config`/`.dsh/skills` 一并公开；`memory/` 属个人数据，**不入库**。

| 字段 | 位置 | 值 | 作用 |
|---|---|---|---|
| `repository` | `package.json` | `https://github.com/AnJingJingC/SYMBIO-workbench` | 市场按此拉源码 / 溯源 |
| `id` | `cordis.patch.yml` | `symbio-workbench` | 插件稳定标识（本地装才被加 `local:` 前缀） |
| `icon` | `package.json` + `icon.svg` | 突触节点图标（≤256KiB） | 市场卡片展示 |
| `author` | `package.json` | SYMBIO Workbench contributors | 市场展示 |

> **mydsh.xyz 的真实规则**（已核实其站点源码与 `trust` 页）：它是**纯索引站，不托管任何文件**，所有条目指向 GitHub 原仓库；「＋上传」通道当前关闭（`UPLOAD_OPEN = false`）。因此**上架 = 申请收录**，操作是在 `mashanglinyu/luanyujia-workbench` 的 Issues 里提交仓库地址与简介，核实后 48 小时内处理。安装包（`.tgz`）不入库、不上传，由本机 `pnpm pack` 产出。

提交流程：`pnpm pack` → 在 mydsh.xyz 工作台市场上传 `symbio-workbench-0.3.3.tgz` → 填仓库 URL 与展示信息 → 发布。本地升级仍走 `install_local_workbench({ path, replace })`。

MIT
