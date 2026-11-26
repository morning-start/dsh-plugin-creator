# 规范化一个已有插件

生成器管「从零起一个插件」。这个能力管另一半：**已经写好的插件，怎么补成标准项目**。

它不是重写代码。规范化的判据只有一条：**这个项目能不能自己发现自己的问题，能不能按标准发版**。缺的是标准件，不是结构。

两个入口，同一引擎：对话里用 `dsh_plugin_adopt`（默认只出计划），终端里用 CLI。

```powershell
node scripts/adopt.mjs <目录>              # 只出计划（默认）
node scripts/adopt.mjs <目录> --dry-run    # 看它要写什么，不写
node scripts/adopt.mjs <目录> --apply      # 写安全的那几条
```

## 三类发现，只有一类会动手

| 类 | 含义 | 例子 |
|---|---|---|
| **auto** | 确定性、幂等、不覆盖 | `repository` 字段、发布 workflow、起手 `checks.json`、`.gitignore` 条目、`market.json` 草稿 |
| **decide** | 需要项目主人拍 | 工具挂哪个预设、要不要客户端半边、bundle 检查里的 fail |
| **manual** | 只报告 | patch 与出厂预设漂移、缺详情页、locale key 不一致 |

## 五条 auto 动作

| 动作 | 判据 | 为什么安全 |
|---|---|---|
| `add-repository` | `package.json` 无 `repository`，且有 GitHub remote | 值来自 `git remote`，不可能写错 |
| `add-ci-workflow` | 无 `.github/workflows/release.yml` | 就是本包那份通用 workflow，逐字节复制 |
| `add-checks-json` | 无 `checks.json` | **只写入这个项目当前已经通过的规则**——规范化不能顺手把项目变红 |
| `append-gitignore` | 缺 `node_modules/` 或 `tmp/` | 只追加，不改已有行 |
| `add-market-json` | 有 GitHub remote 且无 `market.json` | 描述是从 `locale` 推的草稿，带 `_note` 提示必须人工读一遍 |

第三条是这里最要紧的设计：起手 `checks.json` 先跑一遍候选规则，**只保留已经通过的**。否则规范化会立刻制造一个红项目，而红项目没人看。

## 五条硬约束

1. **不覆盖**：文件已存在就跳过。计划做完到写入之间文件出现了，也跳过（有测试守着这个竞态）。
2. **幂等**：跑第二遍零动作。
3. **工作区脏就拒绝**：git 就是回滚手段，脏了就没法回滚。`--force` 可以硬来。
4. **不在 git 里不动手**：没有版本控制就没有后悔药。
5. **不猜**：不猜预设归属、不改用户写过的 manifest 字段、不重排代码。

## 它不会替你做的判断

- 工具该挂在哪个预设（`cordis.patch.yml` 要覆写谁）；
- 要不要客户端半边（验证成本翻几倍）；
- `cordis.patch.yml` 里的出厂预设段是否已经随 DSH 升级过期——**这一条只报告**，因为改它需要知道当前 DSH 的出厂声明。

## 验证

```powershell
node scripts/try-adopt.mjs        # 24 项：零动作、五条动作、幂等、dry-run、脏工作区、不覆盖、本仓库自检
node scripts/check-project.mjs .  # 本仓库自己的规则
```

`try-adopt.mjs` 里有一条「计划后文件才出现」的竞态用例——**把跳过逻辑去掉，它会红**，所以这条守卫不是装饰。
