---
id: session-message-identity
name: 会话消息缺少 id
title: 交给会话的消息必须有 id，否则整段历史打不开
cause: 自己拼一条消息交给会话——字面量，或 followup / steer / inject / append 的裸载荷——没带 id
matches:
  - "lacks an identified message"
  - "is corrupt: stored session"
  - "failed validation"
location: 插件向会话投递消息的代码：followup / steer / inject / send / append
consequence: 用户下次打开会话时整段历史加载失败；丢的不是一条消息，是整个会话
fix: 用 createUserMessage / createDeveloperMessage 等构造函数（内部 randomUUID），不要手写字面量
since: 2026-11
applies-to: [plugin, project]
severity: fatal
check: session-message-identity
---

# 会话消息的身份

## 什么时候会踩

只在**代码自己造一条消息塞进会话**的时候。走 `Agent.followup / steer / inject / send`，或者直接往事件日志里 `append` 一条 `user/message`、`assistant/message`、`developer/message`、`system/message`、`tool/result`。

不适用：只读会话、只渲染历史、只发工具结果给宿主（由宿主构造）、只拼 prompt 字符串。

## 原理：为什么写的时候不报

DSH 的写入路径和加载路径校验**不对称**：

- 写入：`Agent.followup / steer / inject / send` 不检查 `message.id`，事件照写；
- 加载：`Session.fromRestore()` 逐条过 `assertSessionEventEnvelope`，`adoptSessionEvent` 遇到消息事件就要求非空 `id`，否则抛错，**整个会话拒绝加载**。

所以这个错误在开发期完全静默，只在用户下次打开会话时爆炸。

最典型的一处：`inject()` 把 `{ content, source }` 交给 `agent.steer()`。宿主 `Agent` 的签名是 `steer(message: UserMessage)`——它要的是**完整的 `UserMessage`**，不是两个字段。缺的 `id` 和 `role` 会被原样写进事件，然后在下次加载时炸。

## 查到之后确认什么

报错给出 `seq`，去会话日志里看那一条事件的形状：

```powershell
# 会话日志是 zstd 压缩的两级目录
zstdcat ~/.dsh/sessions/*/*/session*.jsonl.zstd | Select-String '"seq":2182'
```

坏消息的样子是 `keys: ["content", "source"]`——没有 `id`、没有 `role`。好消息是 `keys: ["id", "role", "content", "source"]`。

一个文件里通常**只有一两条坏**，但一条就够让整段会话打不开。

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
agent.steer({ content: [{ type: 'text', text: '继续' }], source: { kind: 'x' } })  // 没有 id，也没有 role
log.append('user/message', { role: 'user', content: [] })                      // 没有 id
```

## 已经坏掉的会话怎么办

规则只能拦新的，拦不住已经写进日志的历史。要不要修历史是**用户的决定**：

- 修：把缺失的 `id` 补成随机 UUID、`role` 补成 `user`，然后跑一遍宿主自己的 `adoptSessionEvent` 确认 `failed=0`；
- 不修：只要后续不再产生新的坏消息，旧会话仍然打不开，但不会扩散。

默认按「不修」处理——除非用户明确要求动历史。

## 为什么这条规则值得存在

它是**唯一一个「写的时候全对、读的时候全错」**的结构错误。lint 看不出来，测试跑得通，代码 review 也挑不出毛病——只有用户重启之后才发现。这类错误必须由规则守，不能靠人记得。

## 为什么 `errors/` 本身不被扫

这个文件里就写着反例。`session-message-identity` 规则和 `session:message-identity` 检查都会跳过 `errors/` 目录——**否则这条文档会把自己报成错误**，而唯一的「修法」是删掉反例，等于把教训删掉。