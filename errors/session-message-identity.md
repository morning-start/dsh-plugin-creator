---
id: session-message-identity
title: 交给会话的消息必须有 id，否则整段历史打不开
since: 2026-11
applies-to: [plugin, project]
severity: fatal
check: session-message-identity
---

# 会话消息的身份

## 什么时候会踩

只在**代码自己造一条消息塞进会话**的时候。走 `Agent.followup / steer / inject / send`，或者直接往事件日志里 `append` 一条 `user/message`、`assistant/message`、`developer/message`、`system/message`、`tool/result`。

不适用：只读会话、只渲染历史、只发工具结果给宿主（由宿主构造）、只拼 prompt 字符串。

## 症状

用户升级重启后**整段会话打不开**，报：

```
session event at seq N lacks an identified message
```

不是那一条消息丢了，是**整个会话**加载失败。用户视角是「插件把历史搞坏了」。

## 为什么写的时候不报

DSH 的写入路径和加载路径校验不对称：

- 写入：`Agent.followup / steer / inject / send` 不检查 `message.id`，事件照写；
- 加载：`Session.fromRestore()` 逐条过 `assertSessionEventEnvelope`，`adoptSessionEvent` 遇到消息事件就要求非空 `id`，否则抛错，**整个会话拒绝加载**。

所以这个错误在开发期完全静默，只在用户下次打开会话时爆炸。

## 怎么查

```powershell
node scripts/check-project.mjs --only session:messages
```

规则类型 `session-message-identity`，扫 `root` 下的源码，找四种写法：

| 发现 | 原文 |
|---|---|
| 消息字面量没有 `id` | `a user message literal has no id` |
| 事件 `append` 的载荷不是构造器 | `appends a user/message event from a payload that is not an identifying constructor` |
| 交给 `followup / steer / inject / send / append / push` 的是字面量 | `followup() receives a message literal` |
| 声明成 `Message` 类型却没有 `id` 的变量 | `"x" is declared as a user message without an id` |

`id: ''` 和 `id: undefined` 同样算没有 id。注释和字符串里出现的形状**不算**（扫描器会先遮掉注释与字符串再判断）。

## 怎么修

用 DSH 提供的构造器，它们内部用 `randomUUID()` 补 id：

```js
import { createUserMessage, createDeveloperMessage, createSystemMessage } from '@deepseek-ai/dsh-session'

agent.followup(createUserMessage({
  content: [{ type: 'text', text: '继续' }],
  source: { kind: 'goal' },
}))
```

反例：

```js
agent.followup({ role: 'user', content: [{ type: 'text', text: '继续' }] })   // 没有 id
log.append('user/message', { role: 'user', content: [] })                      // 没有 id
```

## 为什么这条规则值得存在

它是**唯一一个「写的时候全对、读的时候全错」**的结构错误。lint 看不出来，测试跑得通，代码 review 也挑不出毛病——只有用户重启之后才发现。这类错误必须由规则守，不能靠人记得。

## 为什么 `errors/` 本身不被扫

这个文件里就写着反例。`session-message-identity` 规则和 `session:message-identity` 检查都会跳过 `errors/` 目录——**否则这条文档会把自己报成错误**，而唯一的「修法」是删掉反例，等于把教训删掉。
