---
name: symbio-rollback
description: 做结构性改动（改记忆层结构/改技能/改配置/搬目录）之前打快照，改动失败或改坏后定向回滚。E:/SYMBIO 本身是 git 仓，快照=git tag，回滚=按路径定向还原，不动工作台包。
whenToUse: 改记忆结构前 / 改配置前 / 改坏了要回退 / 搬目录前 / 装零件前
metadata:
  stage: "C"
  requires: "E:/SYMBIO 是 git 仓（已具备）"
  outputs: "git tag 快照 / 定向还原后的记忆层"
user-invocable: true
---

# 回滚快照（Rollback）

> **默认状态：未启用（C 层）。** 技能在位、可手动调用，但不自动跑——它会在结构性改动前打 tag / 定向还原。
> 面板上显示为虚线圈属有意为之，不是缺件；动手改结构前主动叫它。

> 作者的双回滚快照，本质是两件事：**改之前有底**（快照）+ **改坏了只回该回的**（定向还原）。
> 我们不造新机制——E:/SYMBIO 已经是 git 仓，这两个能力 git 原生就有，缺的只是纪律。

## 快照（任何结构性改动前，先打 tag）

```sh
cd /e/SYMBIO
git add -A && git commit -m "改动前快照：<一句话说明要改什么>"   # 没有未提交改动时可跳过
git tag snap/<YYYYMMDD>-<slug>          # 例：snap/20261104-before-scene-split
git tag -l "snap/*" | tail -5            # 确认打上了
```

约定：
- slug 用英文短横线，见名知义：`before-scene-split` / `before-part-install` / `before-evolve`。
- 与 `90-archive/pre-change-<日期>/` 备份约定互补：git tag 管**代码+配置+记忆文本**，目录备份管**大文件/二进制**。双快照只在对大动手术时用，日常 git tag 足够。

## 定向还原（改坏了，只回该回的）

**铁律：永远不用 `git reset --hard` 清工作区——那会把别人在此期间的正常提交一起杀掉。**

```sh
# 只还原某个路径到快照点（最常用：改坏记忆层）
git checkout snap/20261104-before-scene-split -- memory/20-scenes/knowledge-digest/

# 只还原配置
git checkout snap/<tag> -- config/symbio.config.json

# 先看改了什么再决定
git diff snap/<tag> -- memory/          # 快照点之后记忆层全部差异
git diff --stat snap/<tag>              # 全仓差异总览
```

还原后必做两步：
1. `git add -A && git commit -m "回滚：<哪个改动> → <哪个快照>"`——回滚本身也是一次提交，历史不留糊涂账。
2. 跑 `node tools/memory-lint.mjs`，确认记忆层体检回到 PASS。

## 红线（宿主确认才可越）

1. **工作台包（workbench/）坏了不用 git 回滚**——它是安装分发物，回滚 = 用上一版 tgz 重新 `install_local_workbench`。
2. **删除 tag / 改历史**（`git tag -d`、`git push --force`、`git rebase`）一律先请示宿主。
3. **`90-archive/` 是 L5 只追加层**：定向还原能还原"文件内容"，不能替你"删除错误追加的行"——追加错了要显式按台账规则处理，不许悄悄 reset。
4. 涉及 `memory/` 的还原动作，做完必须写一行进 `当前交接.md`（改了什么、回滚到哪、为什么）。

## 失败处理

| 情况 | 处理 |
|---|---|
| 改动前忘了打 tag | 找最近一次正常提交 `git log --oneline -10`，与宿主确认哪一刀是"最后一 good"，按其 hash 定向还原 |
| 还原后 lint 仍 FAIL | 停手，把 diff 贴给宿主裁决，不要连环试错 |
| 工作区有别人的未提交改动 | 先让宿主确认怎么处置，绝不顺手 `git checkout .` 全清 |

## 自查

- [ ] 改动前有 tag（或明确记录了基线 commit）
- [ ] 还原用的 `git checkout <tag> -- <path>`，不是 reset --hard
- [ ] 回滚已作为一次提交留痕
- [ ] memory-lint 回到 PASS
