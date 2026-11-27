---
id: custom-session-event
title: 自定义持久事件没 augment SessionEventMap，session.append 拒绝未知类型
since: 0.1.5-alpha.1
applies-to: [plugin]
severity: broken
check: custom-session-event
---

# 自定义持久事件要先声明

## 什么时候会踩

只在**往会话日志里追加自定义事件类型**的时候：

```js
session.append('my-plugin/thing-happened', { detail: 1 })   // ✗ 没声明
```

不适用：追加 `user/message`、`agent/status` 这些已有类型；也不适用 `ctx.emit(...)`（那是进程内瞬时信号，不进日志）。

## 症状

运行时报错，DSH 拒绝未知类型：

```
session.append: unknown event type "my-plugin/thing-happened"
```

插件跑起来了，但"记录这件事"这一步反复失败；恢复会话时下游也看不到这条事件。

## 为什么写的时候不报

`SessionEventMap` 是 TypeScript 的声明合并接口。**不 augment 它，类型层面 `session.append` 就编译不过**——但如果你用的是纯 JS、或者把字符串类型放宽成了 `string`，类型检查完全不拦。运行时的注册表只认真正 augment 过的键，于是到了 `append` 那一刻才发现。

## 怎么查

```powershell
node scripts/check-project.mjs --only session:custom-event
```

规则类型 `custom-session-event`：扫源码里所有 `session.append('<type>', ...)` 的调用，看 `<type>` 是否在同一个包内被 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }` 声明过。两边对不上的写进报告。

## 怎么修

先声明，再 append：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'my-plugin/thing-happened': { type: 'my-plugin/thing-happened'; detail: number }
  }
}

session.append('my-plugin/thing-happened', { type: 'my-plugin/thing-happened', detail: 1 })
```

下游监听走 `session/event`，不能直接 `ctx.on('my-plugin/thing-happened')`：

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'my-plugin/thing-happened') { /* ... */ }
})
```

## 两个容易混的平面

| | 平面 A：Cordis 进程内 | 平面 B：SessionEvent 持久日志 |
|---|---|---|
| 发布 | `ctx.emit('my/event')` | `session.append('my/thing', {...})` |
| 订阅 | `ctx.on('my/event')` | `session/event` 里筛 `event.type` |
| 用途 | 瞬时信号、插件通信 | 需要持久化/可恢复的事实 |

`tools/result`（宿主内通知）≠ `tool/result`（会话日志事件）——名字像，平面不同，别混。

这条规则只管平面 B 的"声明了没有"，不管平面 A。
