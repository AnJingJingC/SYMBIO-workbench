# PRIVACY — 硬性红线的落地位置（逐条对应到文件）

> 你的要求原文：**"任何涉及个人信息的内容严禁出网或传递给外部服务。工作台与 skills 中需内置个人信息识别与拦截机制，默认在本地处理。"**
> 本文档把这个要求**逐条钉到具体文件、具体行、具体执行时机**，方便你验收时逐个核对。

---

## 一、结论先行

| 要求 | 落地文件 | 执行时机 |
|---|---|---|
| 识别个人信息 | `config/pii-rules.json` + `tools/pii-scan.mjs` | 每次摄入 / 写记忆 / 出网前 |
| 拦截 | `symbio-pii-guard/SKILL.md`（L1 → 终止） | 同上 |
| 默认本地处理 | `AGENTS.md` §3.1 + `symbio.config.json` → `privacy.defaultMode = "local-only"` | 全局、常驻 |
| 严禁出网 | `symbio.config.json` → `privacy.egressAllowlist = []`（空 = 全禁） | 出网前判定 |
| 不许传给外部服务做识别 | `symbio-pii-guard/SKILL.md` 红线段（明令禁止调用模型 API 做判定） | 每次判定 |

---

## 二、三道卡口（执行点）

### 卡口 ① 摄入前 —— 资料进工作台之前

- **文件**：`.dsh/skills/symbio-intake/SKILL.md` → 「前置检查」第 3 步
- **动作**：`node tools/pii-scan.mjs --file <资料>`
- **L1 命中**：立即终止，回复只允许一句"已阻断"，且**不许复述内容**
- **L2 命中**：卡片内一律用 `«NAME_1»` 之类占位符，真值不进卡片
- **L3 命中**：照常处理，观察项进 `画像参考.md`

### 卡口 ② 写记忆前 —— 落盘之前

- **文件 1**：`.dsh/skills/symbio-memory-write/SKILL.md` → 「前置检查」第 2 步
- **文件 2**：`.dsh/skills/symbio-handoff/SKILL.md` → 「红线」段
- **动作**：内容先过 `/symbio-pii-guard`；L2 写占位符；真值只允许进 `memory/30-personal/`（且需你同意）
- **特别约束**：交接文档（会被新会话读取、也可能被同步）**永不含**真实手机号/住址/私聊原文

### 卡口 ③ 出网前 —— 任何内容离开本机之前

- **文件 1**：`AGENTS.md` → 「四、四条不可协商的硬规则」第 1 条
- **文件 2**：`.dsh/skills/symbio-pii-guard/SKILL.md` → 「L2 → REDACT」段
- **文件 3**：`config/symbio.config.json` → `privacy.egressAllowlist`
- **机制**：
  - `egressAllowlist` 为空 → **默认禁止任何含 L2 的内容外发**
  - 确需外发 → 先脱敏 → 列替换清单 → **你逐条确认** → 才允许发出
  - 脱敏映射表 `memory/90-archive/redact-map-<日期>.json` **只留本地，不外发**
- **额外**：`symbio-part` 与 `symbio-evolve` 在装任何联网零件/机制前，必须先过本卡口评估（见两个 SKILL.md 的硬约束段）

---

## 三、识别机制本身的技术约束

| 约束 | 为什么 | 在哪体现 |
|---|---|---|
| 只做本地正则 + 本地规则 | 把待检文本发给"智能识别服务"等于先泄露再防护 | `pii-scan.mjs` 零网络调用；`symbio-pii-guard` 红线第 1 条 |
| 不建敏感词日志库 | 日志本身就是泄露面 | `pii-scan.mjs` 不写任何文件；只输出到 stdout |
| 命中记录只存规则 id | 存原文 = 二次泄露 | `symbio-pii-guard` 红线第 2 条 |
| 规则缺失时保守兜底 | 宁可误拦，不可漏放 | `pii-scan.mjs` 在规则缺失/损坏时一律返回 `REDACT` |
| 姓名靠词典而非猜测 | 正则猜中文姓名误报率极高 | `config/pii-rules.json` → `nameDictionary`（**需要你填**） |

---

## 四、你验收这套机制的最快方式（4 条命令）

```bash
# 1) 身份证 → 应 BLOCK，退出码 2
#    示例里不写真号码：闸门分不清「示例」和「真号」，这是设计而非缺陷。
#    用你自己的号码测（测完这条命令留在 shell 历史里也无妨，没落盘）。
node tools/pii-scan.mjs --text "<你的18位身份证号>"
echo $?        # 期望 2

# 2) 手机号 → 应 REDACT，并给出占位符
node tools/pii-scan.mjs --text "我电话13800138000" --redact

# 3) 干净文本 → 应 PASS
node tools/pii-scan.mjs --text "今天读了一篇关于注意力机制的文章"

# 4) 隐私内容不该出现在可同步文件里（抽查）
node tools/pii-scan.mjs --file "memory/10-shared/宿主画像.md"
```

第 4 条若返回 BLOCK，说明画像里混进了硬红线内容，**必须立刻清理**。

---

## 五、这套机制的已知边界（诚实说明）

1. **不是 DLP 级别**。它抓不住"用代号指代的人"、"图片里的文字"、"语音"。
2. **姓名识别依赖词典**。不填 `nameDictionary`，只能靠"姓名：xxx""xxx先生"这类字段线索。
3. **语义级隐私靠模型判断**（本地进行）。所以：**判不准时它按高一级处理**——这会造成误拦，是刻意选择。
4. **出口管控是"协议级"而非"系统级"**。它约束的是 AI 的行为（技能里写死），不是操作系统的防火墙。若你需要系统级强制，另需在 OS 层做网络隔离——那超出本工作台范围。
5. **`30-personal/` 不受索引、不进 Git、AI 默认不读**，但它是明文。真要放最敏感的东西，请自己加密后再放。
