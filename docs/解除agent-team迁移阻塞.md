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

- 它是实验性「自定义插件市场的 Discover 标签页」（0.2.1-alpha.4）。本机另有独立市场插件 `dshmarket@1.73.22`，在 `cordis.yml` 里以 `id: dsh-market` 注册并承担市场能力；卸载这个实验 bundle 不会让插件市场消失，损失仅那个 Discover 标签页。（第七节已按新证据修正：实际损失为零。）
- 方式同上：在宿主内用插件管理入口卸载 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，不要手改 `desired.json`、不要 `pnpm remove`。
- 卸载后重启，`harness.log` 应**不再**出现 `migration failed` / `profile maintenance frozen`；`desired.json` 应剩 30 项，且 `symbio-workbench+0.5.5+a5efb2b0c62e` 仍在列。

**对现状无影响的证据**：迁移回滚只回滚「迁代际」这一步，profile 仍按回滚前布局启动；`profiles/web/node_modules/symbio-workbench` 仍指向 `generations/live/symbio-workbench+0.5.5+a5efb2b0c62e`，0.5.5 照常运行。两次回滚都实测如此。

**剩余边界**：上述「唯一一个」是本轮全量扫描的结论。若卸载后迁移仍失败，说明还存在别的形态（例如某个包的 peer 版本区间与宿主不符），按同样方法逐个定位即可——排查路径已固定：看 `migration failed` 点名的包，查它的 `dependencies` 是否含 `@deepseek-ai/*` 内部包，或 peer 区间是否覆盖本机内核版本。

## 七、卸载为何未执行，以及要卸的究竟是哪一份（2026-11-20 00:43 核实）

宿主那个会话回报：未暴露 `plugin_manager` 工具、浏览器桥未连，因此**本次没有执行卸载，也没有改任何文件**。这是真实状态，本文不代签。

顺着这条线索核实，查出一个此前没分清的事实：**同名包在这台机器上存在两份**。

- **随安装提供的一份（实际在跑）**：`…\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh-experimental-plugin-market-bundle`，版本 **0.2.2-alpha.2**。`cordis.yml` 的 `- id: plugin-market` 明确指向它——`__dshPluginOwner.packageDir` 就是上面这条 asar 路径，`version: 0.2.2-alpha.2`。app.asar 的依赖索引里也记着同一条版本号。
- **profile 里另装的一份（迁移失败的源头）**：`profiles/web/node_modules/@deepseek-ai/dsh-experimental-plugin-market-bundle`，软链到 `.generations/live/deepseek-ai+dsh-experimental-plugin-market-bundle+0.2.1-alpha.4+3d29186864a1`，版本 **0.2.1-alpha.4**，其 `dependencies` 精确要求 `dsh-plugin-market@0.2.1-alpha.4` 与 `dsh-client-ui-plugin-market@0.2.1-alpha.4`。

`desired.json` 记的是 **0.2.1-alpha.4 那一份**，所以每轮迁移都试图为它建代际，而它的两个内部依赖在 staging 闭包里解析不出来 → `migration failed` → 整批 31 项回滚。

**结论（比第六节更准）**：要卸的是 profile 里这条**冗余旧副本**，不是宿主在跑的那份。因为实际加载的是 app 自带的 0.2.2-alpha.2，卸掉 profile 副本后 **Discover 标签页也还在——功能损失为零**，第六节"损失仅 Discover 标签页"偏保守，以本节为准。

**GUI 路径**：Desktop → 插件（插件管理）页 →「已安装」分组 → 找到 `dsh-experimental-plugin-market-bundle` → 卸载 → 确认移除。

**若 GUI 里这一行是锁定的**：宿主文档口径是「随安装提供的组合包保持锁定」，而这个名字确实随安装提供（asar 内有 0.2.2-alpha.2）。此时 GUI 只认安装自带那一份、可能不给卸 profile 副本，属**产品行为而非操作错误**。这种情况下不要再试 CLI、不要手改 `desired.json`；正确路径是宿主侧处理——发与内核配套的新版本，或在迁移时跳过「与安装自带重复的组合包」。

**关于「agent-team 还会不会卡住」**：不会。`desired.json` 里 `agent-team` 命中为 0；`cordis.yml` 无 agent-team 注册；只在 `node_modules` 残留一个 `dsh-experimental-agent-team-profile`（0.1.5-alpha.2）目录，它不在 desired 列表里，迁移不做校验。当前迁移清单已是 31 项、首项即 market bundle。故"仅卸 market bundle 后仍可能被 agent-team 卡住"与文件事实不符。

## 八、卸载已生效，等一次重启出结论（2026-11-20 00:56 核实）

**卸载确已发生**（第二次回报为真）：

- `desired.json` 由 31 项降为 **30 项**，`plugin-market-bundle` 命中 **0**，文件时间 00:55。
- `profiles/web/node_modules/@deepseek-ai/dsh-experimental-plugin-market-bundle` 软链**已移除**。

**但 Harness 还没重启**：`harness.log` 最后一条仍是心跳（`uptime 1810304ms`，自 16:26 起连续），没有新的 `launch requested`，也就没有新的迁移记录。**所以迁移是否解除还不能下结论**，只能给出"重启前可判定的部分"。

**把这次手工扫描固化成工具**：新增只读预检 `tools/dev/migration-precheck.mjs`，逐个 desired 代际检查两类必挂形态——①把 `@deepseek-ai/*` 宿主内部包写成普通 `dependencies`（11-19、11-20 两次整批回滚的共同成因）；②代际目录缺失或 `package.json` 不可解析。当前实跑结论：

```
[迁移预检] desired 30 项 · 宿主 cordis 4.0.5
[风险] 0 项——没有「把宿主内部包当普通依赖」这类必挂形态
[结论] 无同形态必挂项；真实结果仍以重启后 harness.log 为准
```

**为免它只是个橡皮章，验过反向路径**：造一个带 `@deepseek-ai/dsh-plugin-market@0.2.1-alpha.4` 普通依赖的假条目，工具 exit 1 并点名该条目、说明为何必挂；peer 区间只展示不自动判定（区间语义多样，自动判定容易误报，反而误导人去改没必要改的包）。

**已接入健康快照**：新增「宿主迁移预检」检查项，以后装机前后各跑一次即可提前发现同类风险，不必再等一轮回滚。

**唯一待办**：Harness → 重启 Harness，然后看 `harness.log` 是否还有 `migration failed` / `profile maintenance frozen`。若仍有，按点名的包走同一排查路径（查它的 `dependencies` 是否含 `@deepseek-ai/*`，或 peer 区间是否覆盖本机内核）。
