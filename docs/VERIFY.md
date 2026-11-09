# VERIFY — 三件需要你在真机上确认的事

> 我这边**没有 DSH**，所以以下几处是依据公开文档与社区资料推断的。
> 它们都不影响"文件能用"，只影响"装上后被不被识别"。**导入后花 1 分钟核对，若不符按下方改法调整即可。**

---

## 1. 技能发现路径

**我假设的**：项目根 `.dsh/skills/<name>/SKILL.md`，用户级 `~/.dsh/skills/`，共享 `.agents/skills/`。

**怎么确认**：
```bash
cd D:\symbio
dsh
# 会话里输入
/symbio-
```
出现 10 个技能名 → 假设成立。

**若不成立**：把 `.dsh/skills/` 整个目录复制到 `%USERPROFILE%\.dsh\skills\`（方案 B）。
仍然不行 → 查 DSH 官方文档 `@deepseek-ai/dsh-skill-filesystem` 的 roots 说明。

---

## 2. Frontmatter 字段名

**我用的**（较保守的一组）：
```yaml
name: symbio-intake
description: 触发条件……
whenToUse: ……
metadata: { stage: "A", requires: …, outputs: … }
user-invocable: true
```

**风险**：不同版本可能只认 `disable-model-invocation` / `user-invocable`，或把 `whenToUse` 写成 `when_to_use`；`metadata` 可能要求扁平字符串。

**怎么确认**：启动后看 DSH 有没有报 frontmatter 校验警告 / 技能是否出现在目录里。

**若报错**：删掉报错的那个字段重试（`whenToUse`、`metadata` 都是**可选**的，删了不影响功能，只是触发判断会略微变弱）。
`name` 与 `description` 是必需字段，**不要删**。

---

## 3. `customSkillDirs` 字段名

**我假设的**：`~/.dsh/settings.yaml` 里写 `customSkillDirs: [...]`（来自社区文档，未全版本验证）。

**若被拒**：不用它。用 INSTALL.md 的方案 B（直接复制到全局技能目录），效果一样，只是多一步复制。

---

## 附：三个脚本的自检（不依赖 DSH）

```bash
node tools/pii-scan.mjs --text "<你的18位身份证号>"   # 期望 BLOCK，退出码 2
# 示例里不写真号码：闸门分不清「示例」和「真号」，这是设计而非缺陷。
node tools/pii-scan.mjs --text "你好"                 # 期望 PASS
node tools/memory-lint.mjs                            # 期望 FAIL 0
node tools/index-build.mjs                            # 期望生成 cards/索引.md
```

四个都正常 → 工作台的"仪表盘"是好的，剩下的只是 DSH 侧的识别问题。
