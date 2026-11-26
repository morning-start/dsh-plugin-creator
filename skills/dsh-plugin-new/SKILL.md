---
name: dsh-plugin-new
description: 把「我想加点什么」变成一个 DSH 插件：需求还模糊时先做场景分析、定插件形态（工具 / 客户端半边 / 预设 / skill / 配置），再问清包名、标题、描述等字段，调用 dsh_plugin_new 生成，最后按检查报告修完再安装。用户说「新建一个插件」「给我搭个插件骨架」「按模板生成插件」「初始化一个 dsh 插件」，或说「我想让 X 好一点」「能不能加个 Y」时用。
---

# 从需求到插件：构思、生成、验收

生成器是确定性的：同一组参数永远产出同样的文件。所以**不要手写** `package.json` / `cordis.patch.yml` / `index.js`，也不要复制模板再改——调用 `dsh_plugin_new`。

同一份引擎有两个入口，产物逐字节一致：

- 对话里：`dsh_plugin_new` 工具（参数即 schema，不用拼 shell 引号）；
- 无人对话 / 已有 plan.json：`node scripts/new-bundle.mjs --config plan.json`。

## 0. 先判断：这是「一个插件」还是「一个想法」

**能一句话说出「谁在什么情况下用它、它替掉了现在的什么麻烦」** → 需求已经清楚，跳到第 1 节。

说不出，或者用户说的是「我想让团队协作好一点」「能不能加个能看进度的东西」——**先构思，别急着生成**。形态没定就生成，产出的包一定返工。

构思走两遍：

1. **需求分析**：宿主里有 `scenario-driven-product-design` 技能就先用它（角色、场景枚举、优先级那一套）；没有就用本技能的 [references/conception.md](references/conception.md) 自己走一遍。
2. **形态判定**：把需求落到 DSH 的扩展点上——工具 / 客户端半边 / 预设 / 预设级挂载 / skill / 配置。判定表和「组合时先做什么」在同一个文件里。

产出不是产品文档，是**五行决策记录**：目标用户、核心场景、边界（做什么 / 不做什么）、形态与理由、第一版只做哪个场景。复述给用户，点头再往下。

这五行直接喂给第 1 节：`description` 从核心场景提炼，`withTool` / `withSkill` 从形态来。

> 完整的场景分析（角色表、场景卡、优先级矩阵）留给 `scenario-driven-product-design`；插件通常只要五行。

## 1. 一次问完，不要来回磨

必填：

| 字段 | 问法 |
|---|---|
| `packageName` | 包名叫什么？全小写，`dsh-plugin-<东西>` 或 `@scope/<东西>`。row id 会从它推出来 |
| `title` | Plugin Manager 里显示的名字，短、句子式 |
| `description` | 一句话说清「做什么 + 从哪儿触发」。这段会**原样**显示给用户，别写成营销话术 |

按需（一次问清，别一条一条问）：

- `titleZh` / `descriptionZh`：用户用中文就一起要，会多生成 `locale/zh.json`；
- `withTool`：要不要一个示例工具（默认要）；
- `withSkill`：要不要带 Skill（默认不要）；
- `dest`：生成到哪（默认会话工作目录下的 `<包名>` 目录）。

问完**复述一遍**：包名、row id、工具名 / skill 名、目标目录。用户点头再生成。

## 2. 两个决策要用户拍，不要自己定

**工具给谁用？**

- 模板默认：Host 行注册工具 → **所有预设**的会话都能看到。
- 只给某一个预设：生成后自己改 `cordis.patch.yml`，覆写那个预设、把工具行挂进它的 `plugins`。要先告诉用户代价：patch 不做深合并，覆写意味着**整段复述**该预设的 plugins，DSH 升级后要重新同步（本仓库的 `cordis.patch.yml` 就是这种写法的现成例子）。

**要不要 Skill？**

`withSkill: true` 会插入一个 `dsh-skill-filesystem` provider。它只扫这个包的 `skills/`，但 skill 目录是**部署级**的：所有预设的会话都会列出来。用户要「只在我的模式里有这个 skill」，就把 provider 行搬进那个预设，别留在 Host 层。

## 3. 生成

```
dsh_plugin_new({
  packageName: 'dsh-plugin-my-thing',
  title: 'My thing',
  description: '……做什么、从哪儿触发……',
  titleZh: '……', descriptionZh: '……',   // 中文用户一起给
  withTool: true, withSkill: false,
})
```

`dest` 不给就落在会话工作目录下。目标目录已存在且非空会直接拒绝；确实要覆盖，加 `force: true`（只覆盖模板生成的那些文件，不动别人的）。

## 4. 读报告再动手，别跳过 warn

工具返回自带一次 `dsh_plugin_check`：

- `fail` 必须修。模板本身应该是 0 fail，出现 fail 通常说明输入有问题（包名非法、描述为空）。
- `warn` 逐条处理，最常见三条：
  - `icon.svg is a placeholder` → 换成真的图标，否则在插件列表里显示成通用占位图；
  - `description is short` → Plugin Manager 直接显示这段，补上「做什么 + 怎么触发」；
  - `withSkill` 的部署级影响 → 见上面第 2 节。
- 修完可以再跑一次 `dsh_plugin_check`（或 `node scripts/new-bundle.mjs` 里的检查）确认。

## 5. 装与验（说清楚哪些验过、哪些没验）

**刚生成的插件是「开发中」的，只能装进沙盒。** 装进当前环境的风险是把用户正在用的宿主搞成带伤启动；
`dsh-plugin-creator` 的 guard 会直接拒绝本地目录安装（`install_bundle` 的目录 target、`dsh plugin add link:`），
除非那个宿主本身就是沙盒。被拒不要绕，去开沙盒或问用户。

1. 沙盒里装：`dsh_sandbox { action: 'create', name: 'dev', plugin: '<生成的目录>' }` →
   `dsh_sandbox { action: 'start', name: 'dev' }` 拿到 URL，交给用户去加模型
   （没有这个工具时按 `dsh-plugin-sandbox` 技能手工建沙盒）。
2. `dsh --profile sb-dev --dump-config` 里能看到那一行，且没有 activation 诊断。
3. **新开**一个会话再验：调一次工具 / 看 skill 目录。已有会话不会变——预设是建会话时解析的。
4. 页面里的图标、标题、描述是渲染结果，没看到就不要说「显示正常」。
5. 只有**发布成版本**、或**用户明确要求并自己开了 `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`** 时，才装进当前环境。

## 6. 不要做的事

- 不要用大写或带空格的包名（npm 不接受，生成器会直接报错）。
- 不要为了省一步去手写 manifest——手写的那份没有经过检查。
- 不要在别人已经写过的目录里 `force`，除非用户明确要求。
- 不要把「生成了」说成「装好了」：生成只写了文件，装是第 5 步。
