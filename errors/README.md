# errors/：踩过的坑，变成会自己跑的规则

这个目录放**已知会把人坑死的错误**，一条一个文件。每个文件是**卡片 + 正文**两部分。

## 卡片和正文的分工

| | 卡片（frontmatter） | 正文 |
|---|---|---|
| 目的 | 快速判断「这是不是我的错」 | 真正把它改对 |
| 内容 | 名称、原因、系统原文、位置、后果、修法简述 | 机制、为什么当时不报、完整修法、边界 |
| 读法 | 扫一眼 | 确定是它之后逐节读 |

两者**不重复**：卡片是索引，正文是解释。卡片里的一句话「修法」够定位，不够改对——**只读卡片就动手是错的做法**。

反查用脚本，不靠记：

```powershell
node scripts/list-errors.mjs                          # 全部卡片
node scripts/list-errors.mjs "lacks an identified message"   # 按系统原文找
node scripts/list-errors.mjs inject                   # 按 id / 名称过滤
node scripts/list-errors.mjs --json                   # 机器可读
```

过滤同时匹配 `id`、`name`、`title` 和 `matches`，所以**把报错里最稳定的一段丢进去**就行——别用行号、路径、seq 这种每台机器都不同的部分。

## 为什么要有这个目录

文档里的「注意不要……」没有人会读第二遍；code review 会漏；测试跑得通的东西不代表用户打开时不会炸。**只有变成一条会自己跑的检查，才算真的防住了。**

所以这里的每一条都必须能被 `checks.json` 引用、被 `check-project` 执行。写不出一条检查的条目，说明还没想清楚触发条件，先别写进来。

## 文件格式

```markdown
---
id: session-message-identity          # 必须等于文件名（去掉 .md）
name: 会话消息缺少 id                  # 错误名称：列表里一眼认出来
title: 交给会话的消息必须有 id          # 完整标题
cause: 自己拼消息交给会话时没带 id      # 报错产生的原因：说机制
matches:                              # 系统原文：反查的唯一抓手，至少一条
  - "lacks an identified message"
  - "is corrupt: stored session"
location: followup / steer / inject / append 的调用点   # 大致产生的位置
consequence: 整段会话加载失败          # 产生的后果：用户看到什么
fix: 用 createUserMessage 等构造函数   # 修法简述：一句话，够定位
severity: fatal                       # fatal 数据损坏 / broken 功能不可用 / noisy 只是难看
check: session-message-identity       # 能抓到它的规则类型；写不出就写 none 并说明
---

# 标题

## 什么时候会踩
只写**触发条件**，越窄越好。

## 原理
这一节是正文的核心：**说明为什么 lint / 测试 / review 都没拦住**。
写不出这一节，说明还没理解这个坑。

## 查到之后确认什么
报错给了什么线索（seq、行号、路径），去哪个文件/日志确认是这一条。

## 怎么修
正例 + 反例，代码要能直接抄。

## 已经坏掉的数据怎么办
修不修历史是**用户的决定**，默认只保证后续不再产生。
```

六个卡片字段（`name` / `cause` / `matches` / `location` / `consequence` / `fix`）少一个就会被 `errors:cards` 规则报错——写不出来就是还没想清楚，先别归档。

## 怎么用

```powershell
node scripts/check-project.mjs --only errors:cards        # 卡片本身是否完整
node scripts/check-project.mjs --only session:messages   # 只跑某一条
node scripts/check-project.mjs                           # 全跑
```

`checks.json` 里引用：

```json
{ "id": "session:messages", "type": "session-message-identity", "root": "src" }
```

## 加一条新条目的流程

1. 先写卡片和正文，把「为什么当时不报」写清楚；
2. 再写规则类型（`lib/rules.js` 里加 case，`lib/rule-types.js` 登记）；
3. 在 `scripts/try-checks.mjs` 里加正例和反例——**反例必须先红一次**，证明这条检查真的会报；
4. 最后才写进 `docs/CHECKS.md`。

顺序不能反。先写文档再写检查，最后一定是文档在描述一个不存在的东西。

完整模板见 [`skills/dsh-plugin-fix-error/references/writing-a-card.md`](../skills/dsh-plugin-fix-error/references/writing-a-card.md)。

## 谁来读这些卡片

[`skills/dsh-plugin-fix-error`](../skills/dsh-plugin-fix-error/SKILL.md) 是消费方：给定报错或现象，先用 `list-errors.mjs` 锁卡片，再按卡片上的 `check` 跑规则拿精确位置，改完跑全量门禁，最后在真实宿主里验一次。这张卡片写不好，那个技能就没法用——**卡片的质量决定修错的速度**。

## 现有条目

| 条目 | 严重度 | 检查 | 出处 |
|---|---|---|---|
| [session-message-identity](session-message-identity.md) | fatal | `session-message-identity` | 真实事故 |
| [manifest-shape](manifest-shape.md) | broken | `manifest-shape` | 插件解剖 · 清单字段 |
| [undeclared-inject](undeclared-inject.md) | broken | `undeclared-inject` | 第一个插件 · 常见坑 |
| [bare-name-dependency](bare-name-dependency.md) | broken | `bare-name-dependency` | 插件解剖 · 依赖解析 |
| [custom-session-event](custom-session-event.md) | broken | `custom-session-event` | 监听事件 · 双事件平面 |

后四条来自官方文档 <https://deepseekdocs.com/docs/learn> 的「插件解剖 / 第一个插件 / 监听事件」等篇目里点名的硬性约束——文档写了「会踩」，这里把它变成会自己跑的检查。

## 和 `skills/*/references/incidents.md` 的分工

两个地方都在记「踩过的坑」，但读的人不同：

| | `errors/` | `skills/*/references/incidents.md` |
|---|---|---|
| 给谁看 | **机器**：`check-project` 按条目执行 | **人/模型**：调试时按现象反查 |
| 什么内容 | **静态、可判定**：能扫源码或文件的规则 | 动态、环境相关：起实例、端口、崩溃 |
| 格式 | 卡片（六字段）+ 正文，`check:` 指向规则类型 | 现象→证据→根因→处置→判据 |
| 举例 | 「消息字面量没有 id」（能扫出来） | 「桌面端被顶掉」（只能靠判据识别） |

一条坑如果能写成**静态检查**，就写进 `errors/` 并加规则；写不成检查的（运行时、环境），写进 `incidents.md`。两边互相链接，别重复。