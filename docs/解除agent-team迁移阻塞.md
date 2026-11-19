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

## 六、卸载结果与第二轮阻塞（2026-11-20 00:26 实测）

宿主已执行方案 A，卸载**确已生效**：`desired.json` 中 agent-team 条目消失（插件数 32 → 31），`.generations-deferred.json` 也不再存在。

但同一轮启动（`2026-11-19T16:26:01Z`，北京时间 00:26）迁移**仍然回滚**，失败项换成了 `@deepseek-ai/dsh-experimental-plugin-market-bundle`：

- `migration: moving 31 plugin(s) to generations: @deepseek-ai/dsh-experimental-plugin-market-bundle, …`
- `generation-install: promoted to deepseek-ai+dsh-experimental-plugin-market-bundle+0.2.1-alpha.4+50033ab83c56`
- `migration failed, restoring the pre-upgrade profile: … failed peer validation: @deepseek-ai/cordis does not resolve from the installation closure; @deepseek-ai/dsh-client-ui-plugin-market does not resolve …; @deepseek-ai/dsh-plugin-market does not resolve …`
- `profile maintenance frozen: migration deferred (…)`

这正落在第五节写的边界里：agent-team 只是**第一个被点名**的，并非唯一。

**为什么是它（已全量扫过 31 个代际的 package.json）**：它是唯一把宿主内部包写成**普通 `dependencies`** 的插件——`dsh-client-ui-plugin-market@0.2.1-alpha.4`、`dsh-plugin-market@0.2.1-alpha.4` 精确版本，这两个包不在 registry 安装闭包里，staging 装不进来，peer 校验必然挂。其余 30 个（含 `symbio-workbench`、`dsh-ops`、`dsh-multipane` 与四插件）都只用 `peerDependencies` 声明 `@deepseek-ai/cordis`，交给宿主单例解析，因此全部通过。**结论：它是最后一个同形态的阻塞项。**

**建议同样卸载（仍由宿主执行）**：

- 它是实验性「自定义插件市场的 Discover 标签页」（0.2.1-alpha.4）。本机另有独立市场插件 `dshmarket@1.73.22`，在 `cordis.yml` 里以 `id: dsh-market` 注册并承担市场能力；卸载这个实验 bundle 不会让插件市场消失，损失仅那个 Discover 标签页。
- 方式同上：在宿主内用插件管理入口卸载 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，不要手改 `desired.json`、不要 `pnpm remove`。
- 卸载后重启，`harness.log` 应**不再**出现 `migration failed` / `profile maintenance frozen`；`desired.json` 应剩 30 项，且 `symbio-workbench+0.5.5+a5efb2b0c62e` 仍在列。

**对现状无影响的证据**：迁移回滚只回滚「迁代际」这一步，profile 仍按回滚前布局启动；`profiles/web/node_modules/symbio-workbench` 仍指向 `generations/live/symbio-workbench+0.5.5+a5efb2b0c62e`，0.5.5 照常运行。两次回滚都实测如此。

**剩余边界**：上述「唯一一个」是本轮全量扫描的结论。若卸载后迁移仍失败，说明还存在别的形态（例如某个包的 peer 版本区间与宿主不符），按同样方法逐个定位即可——排查路径已固定：看 `migration failed` 点名的包，查它的 `dependencies` 是否含 `@deepseek-ai/*` 内部包，或 peer 区间是否覆盖本机内核版本。
