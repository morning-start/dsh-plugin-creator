# 没有命中卡片时：写一张

`errors/` 里没有你这次的坑，说明**这个坑还没被防住**。改完代码就走，等于把它留给下一个。

写一张卡片是十分钟的事，但顺序不能乱。

## 顺序

1. **先写卡片**（`errors/<id>.md` 的 frontmatter）——它逼你说清触发条件和后果；
2. **再写正文**——重点是「为什么当时不报」这一节；
3. **再写检查**（`lib/rules.js` 加 case，`lib/rule-types.js` 登记）；
4. **再加用例**（`scripts/try-checks.mjs`，反例必须先红一次）；
5. **最后写进文档**（`docs/CHECKS.md`）。

先写文档再写检查，最后一定是文档在描述一个不存在的东西。

## 卡片：六个字段，一个都不能少

```yaml
---
id: session-message-identity       # 必须等于文件名（去掉 .md）
name: 会话消息缺少 id               # 错误名称：一句话，能在列表里认出来
title: 交给会话的消息必须有 id      # 完整标题
cause: 自己拼消息交给会话时没带 id   # 报错产生的原因：说机制，不说「写错了」
matches:                            # 系统原文：反查的唯一抓手，至少要一条
  - "lacks an identified message"
  - "is corrupt: stored session"
location: followup / steer / inject / append 的调用点   # 大致产生的位置
consequence: 整段会话加载失败        # 产生的后果：说用户看到什么
fix: 用 createUserMessage 等构造函数 # 修法简述：一句话，够定位
severity: fatal                     # fatal 数据损坏 / broken 功能不可用 / noisy 只是难看
check: session-message-identity     # 能抓到它的规则类型；写不出就写 none 并说明为什么
---
```

写不出来的字段，就是还没想清楚的字段：

- **`matches` 写不出来** → 你还没见过真实的报错，别急着归档；
- **`cause` 只能写成「写错了」** → 还没理解机制，先读源码；
- **`consequence` 只能写成「出问题」** → 不知道用户看到什么，这条卡片帮不了任何人。

## 正文：五节，其中一节是重点

```markdown
# 标题

## 什么时候会踩      触发条件，越窄越好
## 原理             为什么写的时候不报（重点）
## 查到之后确认什么   怎么从日志/输出确认是这一条
## 怎么修           正例 + 反例，能直接抄
## 已经坏掉的数据怎么办  只写「要不要动历史是用户的决定」
```

**「为什么当时不报」是这一节存在的理由**：说明为什么 lint / 测试 / review 都没拦住。写不出这一节，说明还没理解这个坑——它多半不该进 `errors/`，而该进 `skills/*/references/incidents.md`（那是给人和模型按现象反查的运行期事故记录）。

## 两条边界

- **能写成静态检查才进 `errors/`**。写不成检查的（起实例、端口、崩溃、渲染）写进 `incidents.md`，两边的分工在 [`errors/README.md`](../../../errors/README.md) 里。
- **`errors/` 自己不被扫**。卡片正文里会写反例，规则和检查都跳过这个目录，否则文档会把自己报成错误。加新规则时记得保留这条豁免。