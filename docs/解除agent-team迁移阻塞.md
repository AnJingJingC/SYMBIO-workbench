# 解除 agent-team 阻塞 generation 迁移（给宿主的可粘贴指令）

> 用途：宿主每次启动都把 32 个插件"迁到 generations"，但 `dsh-experimental-agent-team-profile` 的 peer 校验一直失败，导致**整批迁移回滚**、profile 进入 `frozen`。本文给出证据与一条可执行的解除路径。
> 生成于 2026-11-20 00:05，依据 `harness.log` 与 `desired.json` 实物核对，非推测。

## 一、现象与证据（来自宿主日志，原文摘录）

`%APPDATA%\dsh-desktop\logs\harness.log` 最近一次启动（2026-11-19T15:20Z，北京时间 23:20）：

- `migration: moving 32 plugin(s) to generations: … symbio-workbench, … dsh-node-flow, dsh-multipane`
- `generation-install: installed in 2321ms`
- `generation … agent-team-profile+0.1.5-alpha.2+f2bfb00bc58f already exists, reusing`
- **`migration failed, restoring the pre-upgrade profile: @deepseek-ai/dsh-experimental-agent-team-profile failed peer validation: @deepseek-ai/cordis does not resolve from the installation closure; @deepseek-ai/dsh-experimental-agent-team does not resolve from the installation closure; @deepseek-ai/dsh-experimental-tool-agent-team does not resolve from the installation closure`**
- `profile maintenance frozen: migration deferred (…)`

即：**一个插件的 peer 校验失败，拖垮了其它 31 个插件的迁移**，宿主回滚并冻结 profile 维护。

## 二、为什么它永远装不上（外部无法解决）

- 它要求 `@deepseek-ai/dsh-experimental-agent-team`、`@deepseek-ai/dsh-experimental-tool-agent-team` 为 `^0.1.5-alpha.2`、`@deepseek-ai/cordis` 为 `^4.0.2`。
- 本机全局 dsh 内核里确实带这两个包，但版本是 **0.2.0-rc.2**——落在 `^0.1.5-alpha.2`（等价 `>=0.1.5-alpha.2 <0.2.0`）之外，semver 直接不匹配；cordis 是 4.0.5 满足，但没被解析进该 profile 的安装闭包。
- 这是宿主上游的**版本错配**，不是缺文件。外部 CLI / 手动 pnpm 补包既违反宿主"只能由 install_bundle 安装"的纪律，也解决不了 semver 冲突。

## 三、建议的解除路径（由宿主执行，不要外部手改）

目标：让这一项不再阻塞整批迁移。可选两条，按宿主偏好二选一：

**方案 A（推荐）：卸载这个实验性 profile。** 它从未成功生效（一直 deferred），留着只会每轮拖垮迁移。
- 在 DSH 会话内让 Agent 通过宿主插件管理能力卸载包 `@deepseek-ai/dsh-experimental-agent-team-profile`（用它自带的卸载入口，不要手动改 `desired.json`、不要 `pnpm remove`）。
- 卸载后重启 Harness，观察 `harness.log` 是否还出现 `migration failed`。
- 预期：整批迁移不再因它回滚，`profile maintenance frozen` 消失；`symbio-workbench+0.5.5` 等仍在 generations，功能不受影响。

**方案 B：等宿主发与 0.2.0 内核对齐的 agent-team-profile 新版本**，或由宿主显式放宽这两个依赖的版本约束后重装。
- 适合确实想用 agent-team 的情况；代价是继续等版本对齐期间，迁移会持续回滚。

## 四、执行后怎么验（宿主侧）

1. 重启 Harness 后看 `harness.log`：**不再**出现 `migration failed` / `profile maintenance frozen` 即为解除。
2. 确认 `desired.json` 仍在（可能少 agent-team 一项），`symbio-workbench+0.5.5+a5efb2b0c62e` 仍在列。
3. 确认面板徽标 / `/api/symbio/health` 的 `version` 仍是 0.5.5——卸载 agent-team **不应**影响工作台包。

## 五、诚实边界

- 本文只给证据与路径。**我不能代宿主卸载或改 profile**，也不保证卸载后 100% 不再回滚——若还有别的插件 peer 不通过，需要同样逐个排查（但当前日志只点名了 agent-team 一项）。
- 卸载 agent-team 的实际代价是失去这个实验特性；但它自 2026-11-18 起一直 deferred（`failedAt` 反复刷新），**本来就没有生效**，所以功能性损失为零。
- 这条路径与 `symbio-workbench` 的 404 是**两件事**：404 是宿主想从 npm 拉本包（已在 `INSTALL.md` 说明），本次日志里没有 404 复现；agent-team 阻塞的是 generations 迁移本身。
