# errors/：踩过的坑，变成会自己跑的规则

这个目录放**已知会把人坑死的错误**，一条一个文件，格式像 skill：前面是 frontmatter，后面是「什么时候会踩 / 症状 / 为什么当时不报 / 怎么查 / 怎么修」。

## 为什么要有这个目录

文档里的「注意不要……」没有人会读第二遍；code review 会漏；测试跑得通的东西不代表用户打开时不会炸。**只有变成一条会自己跑的检查，才算真的防住了。**

所以这里的每一条都必须能被 `checks.json` 引用、被 `check-project` 执行。写不出一条检查的条目，说明还没想清楚触发条件，先别写进来。

## 文件格式

```markdown
---
id: session-message-identity          # 与 checks.json 的 rule.type 同名
title: 交给会话的消息必须有 id
since: 2026-11                        # 什么时候开始成立（DSH 版本或日期）
applies-to: [plugin, project]         # 对什么生效：插件包 / 普通项目
severity: fatal                       # fatal 数据损坏 / broken 功能不可用 / noisy 只是难看
check: session-message-identity       # 对应的规则类型；没有就写 none，并说明为什么
---

# 标题

## 什么时候会踩
只写**触发条件**，越窄越好。「只在代码自己造一条消息塞进会话的时候」比「写代码要注意」有用一百倍。

## 症状
用户实际看到什么。原文报错贴进来，方便以后搜。

## 为什么当时不报
这一节是重点：**说明为什么 lint / 测试 / review 都没拦住**。写不出这一节，说明还没理解这个坑。

## 怎么查
可执行的命令，不是「请检查一下」。

## 怎么修
正例 + 反例，代码要能直接抄。
```

## 怎么用

```powershell
node scripts/check-project.mjs --only session:messages   # 只跑这一条
node scripts/check-project.mjs                           # 全跑
```

`checks.json` 里引用：

```json
{ "id": "session:messages", "type": "session-message-identity", "root": "src" }
```

## 加一条新条目的流程

1. 先写这个文件，把「为什么当时不报」写清楚；
2. 再写规则类型（`lib/rules.js` 里加一个 case，`lib/checks.js` 的 `RULE_TYPES` 里登记）；
3. 在 `scripts/try-checks.mjs` 里加正例和反例两个用例——**反例必须先红一次**，证明这条检查真的会报；
4. 最后才写进 `docs/CHECKS.md`。

顺序不能反。先写文档再写检查，最后一定是文档在描述一个不存在的东西。

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
| 格式 | frontmatter + `check:` 指向规则类型 | 现象→证据→根因→处置→判据 |
| 举例 | 「消息字面量没有 id」（能扫出来） | 「桌面端被顶掉」（只能靠判据识别） |

一条坑如果能写成**静态检查**，就写进 `errors/` 并加规则；写不成检查的（运行时、环境），写进 `incidents.md`。两边互相链接，别重复。
