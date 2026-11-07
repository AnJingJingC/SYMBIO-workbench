# INSTALL — 导入与运行

> 目标：把 `symbio/` 整个目录拷到另一台已装 DSH 的 Windows 机器上，**两条命令内跑起来**。
> 全程不需要编译、不需要联网装依赖、不需要管理员权限。

---

## 零、最低环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11（x64） | macOS / Linux 同样可用，只是路径写法不同 |
| DSH | 0.2.x（已 `npm i -g @deepseek-ai/dsh`） | 0.1.x 亦兼容，只是技能根目录优先级略有差异 |
| Node.js | ≥ 22.19（DSH 自身依赖，必装） | 只用于两个校验脚本；没有也能跑，但体检退化为手工 |
| 模型 | 任一可用模型（DSH 配置项里已配好） | 技能本身**与模型无关**，不绑定厂商 |
| 磁盘 | ≈ 1 MB | 全部是纯文本 |
| 网络 | 运行工作台**不需要联网** | 只有你主动让它查资料时才用到 |
| Git | 可选 | 建议 `git init`，这样每次记忆变更都可回滚 |

**不需要**：Python、Docker、数据库、向量库、任何第三方插件。

---

## 一、拿到工作台（先分清你是哪一种）

| 情况 | 你手上有什么 | 该怎么走 |
|---|---|---|
| **A. 迁移** | 另一台机器上已经**用了一段时间**的 `symbio/` 整个目录 | 第一节，整目录拷过来即可 |
| **B. 全新安装** | 从仓库 clone / 解压出来的**只有代码**，`memory/` 是空的或没有 | 第一节之后走 **`node tools/setup.mjs --fix`** |

两种情况的分界线只有一个：`memory/` 里有没有你的东西。
**`memory/` 永远不同步**（里面有个人画像、私有记忆），所以从仓库拿到的版本一定是空的。

### A. 迁移（源机器 → 目标机器）

把整个 `symbio/` 目录复制过去，建议放在盘符根目录下、路径不含空格：

```
E:\SYMBIO\
```

> 为什么不用 `C:\Users\<你>\Documents\...`：路径太深、含中文/空格时，部分工具链会出问题。根目录最省事。

复制后确认结构完整：

```bash
cd E:\SYMBIO
dir
```

应看到：`AGENTS.md`、`README.md`、`INSTALL.md`、`ACCEPTANCE.md`、`config\`、`memory\`、`tools\`、`.dsh\`

搬完跑一次 `node tools/setup.mjs` 确认没缺件（迁移最常见的坑是 `.dsh/skills` 被系统隐藏、没拷全）。

### B. 全新安装（没有现成记忆）

拿到的是只有代码的目录时，`memory/` 是空的。这时候**不要**手搓目录，一条命令：

```bash
cd E:\SYMBIO
node tools/setup.mjs          # 先看缺什么（只读，一个字节都不写）
node tools/setup.mjs --fix    # 补建六层目录 + 宪法红线 + 场景五件套 + 看板台账
```

不想开命令行也行：**双击 `0-初始化工作台.cmd`**，它做的是同一件事（体检 → 告诉你
有 FAIL 就再跑一次带 `--fix` 的）。这个批处理用 `%~dp0` 定位自己，目录挪到别处、
换到别的盘都不用改。

`--fix` 的行为边界（写死，不靠自觉）：
- **只补不存在的**，已存在的文件一个字节都不碰（记忆被覆盖是找不回来的）
- 补出来的是**出厂模板**，里面全是"待宿主填写"——它不替你编内容，也不猜你是谁
- 幂等：再跑一次不会多建任何东西
- 要加第二个场景：`node tools/setup.mjs --fix --scene contract-review`

跑完你会得到一套**能立刻用**的空工作台：面板数字是 0 而不是「—」，体检 FAIL 0。
之后再按第三节把三件该填的填掉。

---

## 二、安装（三选一）

### 方案 A：项目级（**推荐**，零配置）

DSH 会自动发现**项目根目录**下的 `.dsh/skills/`。所以只要在 `symbio` 目录里启动即可：

```bash
cd E:\SYMBIO
dsh
```

或图形界面：

```bash
cd E:\SYMBIO
dsh web
```

进入会话后输入 `/symbio-`，应看到 10 个技能：

```
/symbio-intake      /symbio-pii-guard    /symbio-memory-write
/symbio-handoff     /symbio-recall       /symbio-dispatch
/symbio-health      /symbio-portrait     /symbio-part
/symbio-evolve
```

**优点**：工作台 = 一个文件夹，拷走即迁移，`.dsh/skills` 与 `memory` 永远在同一处，不会错位。

### 方案 B：全局复制（任意目录可用，最稳）

把技能目录复制到 DSH 的用户级技能根：

```powershell
# PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse -Force "E:\SYMBIO\.dsh\skills\*" "$env:USERPROFILE\.dsh\skills\"
```

```bash
# Git Bash / CMD
mkdir -p "$USERPROFILE/.dsh/skills"
cp -r /e/SYMBIO/.dsh/skills/* "$USERPROFILE/.dsh/skills/"
```

之后在**任意目录**启动 `dsh`，技能都可调用。
记忆目录仍是 `E:\SYMBIO\memory`（技能里用的是相对项目根的路径，所以在别的目录启动时，**仍需先 cd 回 E:\SYMBIO**，或者按方案 C 配全局）。

### 方案 C：自定义技能目录（全局 + 任意目录都能用）

把 `config/dsh-settings.snippet.yaml` 里的 `customSkillDirs` 合并进 `C:\Users\<你>\.dsh\settings.yaml`，
指向 `E:/SYMBIO/.dsh/skills`。字段名若被拒（版本差异），退回方案 B。

### 方案 D：接入本机已有的 DSH 0.2.1 desktop profile（只说明，不自动改）

本机已有 `desktop` profile 时，**推荐方案 A**（`cd E:/SYMBIO && dsh` 起独立会话），彼此不干扰。
若想让现有 profile 也识别这套技能，可把 `E:/SYMBIO/.dsh/skills` 追加进该 profile 的技能目录配置
（如 `cordis.patch.yml` 里的技能目录/`customSkillDirs` 段）——**这属于改 DSH 全局配置，请宿主自己确认后再改**，
本工作台不会擅自动手（见 AGENTS.md 红线 5）。

---

## 三、首次初始化（3 分钟）

目录补好了 ≠ 工作台知道你是谁。下面四件事按顺序做，其中**第 1 件最值钱**：

1. **填隐私词典**（强烈建议，1 分钟）
   打开 `config/pii-rules.json`，把 `nameDictionary` 填成你的真名、家人姓名、常用账号前缀：
   ```json
   "nameDictionary": ["张三", "李四"]
   ```
   这会让 L2 姓名识别从"靠字段名"升级为"靠词典"，命中率显著提高。
   **不填的症状**：文档里出现你的真名，隐私闸一句都不拦——它认不出来。

2. **填定位卡**（否则 AI 不知道自己该干什么）
   打开 `memory/20-scenes/knowledge-digest/定位卡.md`，把"我是谁 / 我负责什么 / 我不负责什么"填掉。
   `身份卡.md` 是出厂设置不用改；`定位卡.md` 是**你的边界声明**，模板里全是空白。

3. **填场景画像**（改 UI 前必做）
   打开 `memory/20-scenes/knowledge-digest/场景画像.md`，把"当前布局"改成你实际想要的界面。
   不填也能跑，但 AI 就没法帮你改 UI（它不知道长什么样）。

4. **跑一次总检 + 体检**
   ```bash
   node tools/setup.mjs          # 目录 / 场景 / 技能 / 配置 / 桥 / 词典，一把过
   node tools/memory-lint.mjs    # 体量与索引
   ```
   预期：`setup` 无 FAIL（WARN 可以有，它只提示"还能更好"）；`memory-lint` 为 `FAIL 0 / WARN 0~2 / PASS 8+`。

5. **（可选）Git 初始化**
   ```bash
   cd E:\SYMBIO
   git init
   git add .
   git commit -m "init: SYMBIO workbench v1.0.0 (stage A)"
   ```

---

## 四、第一天的用法（照做即可）

| 步骤 | 你输入 | 它做什么 |
|---|---|---|
| 1 | 丢一篇资料 + `/symbio-intake` | 隐私扫描 → 出卡片 → 更新索引 → 写回场景记忆 |
| 2 | 问一句"我之前记过什么关于 X" | `/symbio-recall` 逐层下钻，给命中 + 出处 + 置信度 |
| 3 | 聊到 30 轮以上时输入 `/symbio-handoff` | 写 4KB 交接 → 归档 → 给你续接指令 |
| 4 | 新会话第一句 `/symbio-recall 读交接继续` | 认领身份 → 读交接 → 接着干 |
| 5 | 一周后 `/symbio-health` | 八类体检 + 报告落盘 |

---

## 五、迁移到第三台机器

`symbio/` 目录就是全部。拷走即可。
**唯一要注意**：`memory/` 里可能已经有 L2 内容（脱敏后的占位符是安全的，但 `30-personal/` 是真值）。
迁移时建议：先跑 `node tools/pii-scan.mjs --file memory/...` 抽查，或直接**不带 `30-personal/` 复制**。

---

## 六、卸载

删除 `symbio/` 目录即可。
若做过方案 B，再删 `%USERPROFILE%\.dsh\skills\symbio-*`；
若做过方案 C，把 `settings.yaml` 里的 `customSkillDirs` 那一段删掉。

---

## 七、故障速查

| 现象 | 原因 | 修法 |
|---|---|---|
| 输入 `/symbio-` 无补全 | 启动目录不对，或 `.dsh/skills` 被移动 | `cd E:\SYMBIO` 再启动；确认 `.dsh\skills\symbio-intake\SKILL.md` 存在 |
| 技能能调但读不到 `memory/` | 在别的目录启动了 dsh（相对路径失效） | 回 `E:\SYMBIO` 启动；或按方案 C 配全局 |
| `node tools/*.mjs` 报错 | Node 版本 < 22.19 | `node -v` 确认；升级 Node |
| 体检报"缺少 定位卡.md" | 场景目录不完整 | 从模板补建；或重新拷一份 `memory/20-scenes/` |
| 技能名冲突 | 你之前装过同名技能 | 改名（`symbio-xxx` → `symbio2-xxx`），或删旧的 |
| DSH 提示 frontmatter 字段不认 | 版本差异（`whenToUse` / `customer-invocable`） | 见 `docs/VERIFY.md`，删掉不认的字段即可，不影响功能 |
