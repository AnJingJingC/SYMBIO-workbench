# 工具箱 · 宿主 Agent 接入（诚实边界说明）

> 本文件回答一个问题：**「面板里手动点运行的 6 个工具，能不能让宿主 Agent 在对话里直接调用？」**
> 结论先说：宿主 Agent 的调度单位是 `.dsh/skills`；工作台契约**没有**「把 HTTP 工具注册进宿主 Agent」的服务位。但 6 个工具已经通过 10 个技能在对话间接触发，并额外暴露为 HTTP 可调用面。下面给事实与集成建议。

---

## 一、契约边界（查自 dsh-desktop 源码，非推测）

工作台插件（`dsh/index.mjs`）只拿到两个注入点：

| 注入点 | 来源 | 能做什么 |
|---|---|---|
| 服务端 `inject: ['connection']` | `@deepseek-ai/dsh` | `ctx.connection.fetch.register(route)` 注册自己的 `/api/symbio/*` HTTP 路由 |
| 客户端 `dsh.client.inject: ['dsh-desktop-workbenches']` | `package.json.dsh.client` | 注册一块 React 业务面板 |

关键证据：`DshClientManifest.inject` 的官方注释是 **"Informational package-name dependencies, not Cordis service injection"**——面板的注入只是信息性声明，**不是** Cordis 服务注入。

结论：**dsh-desktop 的工作台契约里不存在「向宿主 Agent 注册工具 / 让 Agent 自动编排工作台 HTTP 路由」的接口。** 宿主 Agent 的调度单位是原生技能 `.dsh/skills`（DSH 的技能发现与派发），不是 workbench 的 `/api/*` 路由。

---

## 二、那 6 个工具现在到底「能不能在对话里用」

能，但走的是**原生技能通道**，不是工作台 HTTP 路由：

- 10 个 `.dsh/skills` 里有 9 个在 `SKILL.md` 里直接写 `node tools/<name>.mjs ...`（已 grep 证实：`symbio-health`→`memory-lint`、`symbio-pii-guard`→`pii-scan`、`symbio-intake`→走 `intake.mjs` Worker 等）。
- 宿主 Agent 本来就发现并派发这些技能 → **工具经技能已在对话内可调用**。
- 工作台面板上的「工具箱 · 运行」只是给人类用的手动触发入口（同一套 `tools/run` 白名单）。

所以「对话内不能直接调用」的真相是：**原始 HTTP 工具没暴露成宿主 Agent 的 first-class 工具**；但功能上，Agent 通过技能已经能用它们。这是契约限制，不是缺实现。

---

## 三、额外给到的 HTTP 可调用面（本版新增）

为了让「任意能发 HTTP 的 Agent / 自动化」也能用这些工具，本版把工具箱做成机器可读清单：

```
GET  /api/symbio/tools
→ {
    runEndpoint: "/api/symbio/tools/run",
    invocation: "POST runEndpoint，body 取某个工具的 example（name 必填）…",
    tools: [
      { name, title, desc, input, flags, jsonCapable, hint,
        endpoint: "POST /api/symbio/tools/run",
        example: { name:"pii-scan", text:"…", json:true },
        sideEffects: "read-only" | "writes <dir>/索引.md" | … }
    ]
  }

POST /api/symbio/tools/run
→ { ok, exitCode, stdout, stderr }
```

- 白名单写死（`TOOL_REGISTRY`），绝不允许任意命令 / 路径穿越；`execFile` 无 shell、参数数组化。
- `intake.mjs` 是内部摄入 Worker，**不入册**（由 `src/state.mjs` 工具计数排除，保持「6 本机工具」不变量）。

---

## 四、集成建议（给你的下一步，按可行性排序）

1. **已在生效**：让宿主 Agent 用工具 → 直接依赖现有 10 个技能（它们已 `node tools/*.mjs`）。无需工作台改动。
2. **HTTP 调用方接入**：若宿主 Agent / 外部自动化支持「调用 HTTP 端点」，把 `GET /api/symbio/tools` 当作工具目录、用 `POST /api/symbio/tools/run` 触发即可（见上面的 example）。
3. **若未来 dsh-desktop 开放「工作台贡献宿主 Agent 工具」的契约**（类似 `ctx.agent.tools.register`）：届时把 `TOOL_REGISTRY` 直接映射过去即可，无需重写工具实现。当前版本**不假设该契约存在**，所以没有写任何依赖它的代码。

---

## 五、诚实边界一句话

> 工作台契约只给「面板 + HTTP 路由」，没有宿主 Agent 工具注册服务；6 工具已通过 10 个技能在对话间接触发，并额外暴露为 HTTP 机器可读清单。要更严格的「Agent 原生工具」集成，需等 dsh-desktop 开放对应契约——届时映射 `TOOL_REGISTRY` 即可，工具实现零改动。
