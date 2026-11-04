# SYMBIO 工作台 · DSH Desktop 业务面板（v0.3.2）

把 `E:/SYMBIO` 的六层记忆、10 个技能、6 个工具与免费 AI 桥，挂进 `dataelement/dsh-desktop` 的一块业务面板。单主场景：**知识消化**（资料 → 可检索知识卡片）。

- 业务面板在左 60%，**右侧对话完全复用宿主原生 UI**
- 本地开发包，省略 `repository`、不填 `id` → 身份由宿主派生为 `local:symbio-workbench`
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
- 多面板网格 / 2D 拓扑画布 / 多场景同屏（第一项受宿主形态限制，做不到）
- 桥的登录态长期稳定性未验收（需手动登录一次后复验）

## 上架市场前置（v0.3.3 已补齐字段）

工作台市场（mydsh.xyz）按 **GitHub 仓库** 拉取源码分发（dsh 的 `checkGithubConnection` 只读 GitHub spec），本地包因缺 `repository` 会被宿主派生成 `local:symbio-workbench` 身份、不能上架。本版已补齐：

| 字段 | 位置 | 值 | 作用 |
|---|---|---|---|
| `repository` | `package.json` | `https://github.com/mashanglinyu/luanyujia-workbench` | 市场拉取源码的锚点；也是本包的派生来源 |
| `id` | `cordis.patch.yml` | `symbio-workbench` | 插件稳定标识（本地装才被加 `local:` 前缀） |
| `icon` | `package.json` + `icon.svg` | 突触节点图标（≤256KiB） | 市场卡片展示 |
| `author` | `package.json` | SYMBIO Workbench contributors | 市场展示 |

> ⚠️ **上架前必做**：把 `repository` 改成**你自己在 GitHub 托管此包的仓库 URL**。当前填的是「派生来源仓库」，仅供通过格式校验与溯源；市场会按 `repository` 拉源码，指向他人的仓库会导致拉到错误代码。改完后 `pnpm pack` 重新出包即可提市场。

提交流程：`pnpm pack` → 在 mydsh.xyz 工作台市场上传 `symbio-workbench-0.3.3.tgz` → 填仓库 URL 与展示信息 → 发布。本地升级仍走 `install_local_workbench({ path, replace })`。

MIT
