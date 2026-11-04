# DSH 0.2.1 实测边界说明（本工作台的校正依据）

> 本文件记录"哪些机制在 DSH 0.2.1 上真生效、哪些只能靠工具兜底"。
> 写作依据：本机真实环境排查（非推测）。读完能避免"写了死配置还以为生效"。

---

## 一、真生效的

| 机制 | 怎么生效 | 备注 |
|---|---|---|
| 技能发现 | 项目根 `.dsh/skills/<name>/SKILL.md`；或 `customSkillDirs` 指向 | `name` 必须 kebab-case 且与目录同名 |
| 技能触发 | `description` 决定主动想起；`/symbio-xxx` 手动点名 | `whenToUse` / `metadata` 可选 |
| `AGENTS.md` | DSH 每轮加载项目根该文件 | 最高层指令 |
| 纯本地 Node 脚本 | `node tools/*.mjs` 直接跑 | 零依赖，不需要联网 |
| 手工/技能驱动的流程 | 按 SKILL.md 步骤执行 | 与模型无关 |

## 二、不生效或半生效的（必须知道）

| 机制 | 真相 | 本工作台的处理 |
|---|---|---|
| `cost.dailyBudgetCNY` / `stopOnBalanceError` / `noDispatchAboveCpuPercent` / `cacheRepeatedReads` | **DSH 0.2.1 不读取**，写进配置 = 死配置 | 保留字段作"判定依据/未来兼容"，真正执行靠 `tools/spend-guard.mjs` + AGENTS 红线 2 |
| 节点级模型指派（给某个技能/某类任务固定模型） | 0.2.1 无原生硬指派；只能靠 persona 软声明偏好 | 用 AGENTS/技能里的"路由纪律"软声明 + `model-probe` 取兜底链 |
| 运行时硬拦（到额自动 kill 调用） | 无预算 hook | 靠"开工前必跑 spend-guard，STOP 即中止"的纪律 |
| 负载胶囊（CPU/GPU/内存实时读数） | 需 DSH UI/运行时暴露，文本工作台拿不到 | 不实现；`noDispatchAboveCpuPercent` 仅作文档约定 |
| 2D 拓扑画布 / 亮灯 | 需 DSH 程序渲染 | 不实现 |
| 多场景并行（多个独立 DSH 场景互派单） | 需多个 DSH 实例/profile；本版定位单主场景 | `dispatch` 文件在、默认关；要开需先建第二场景 |

## 三、因此本工作台的"诚实边界"

1. **预算硬闸是"工具 + 纪律"，不是运行时强杀**。不跑 `spend-guard` 就调付费模型 = 违规，但技术上没法在 0.2.1 里强制拦截。
2. **模型路由是"软声明"**，不是硬绑定；换模型不会崩，但也无法保证"这个节点一定用那个模型"。
3. **免费优先靠 `model-probe` 给出的有序兜底链**，死模自动跳过；但探针数据可能 stale，最终以实际调用结果为准。
4. **多场景协作暂不启用**（单主场景定位）；`dispatch` 需先建第二场景再开。

## 四、未来 DSH 若支持

若后续 DSH 版本原生支持 `cost.*` 预算闸或节点级模型指派，把 `spend-guard` 的判定接到原生 hook 即可升级为"硬拦"；本文件同步更新。
