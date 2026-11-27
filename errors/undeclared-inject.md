---
id: undeclared-inject
title: 没声明 inject 就访问服务，Proxy 直接拒绝
since: 0.1.5-alpha.1
applies-to: [plugin]
severity: broken
check: undeclared-inject
---

# 没声明 inject 就访问服务

## 什么时候会踩

只在**插件代码访问 `ctx.<service>`** 的时候。`ctx.tools`、`ctx.settings`、`ctx.web`、`ctx.fs`、`ctx.sessions`、`ctx.typert`、`ctx.invariants` 都是服务，用的那一刻 DSH 先查你有没有声明它。

不适用：`ctx.on`、`ctx.emit`、`ctx.effect`、`ctx.get`、`ctx.plugin`、`ctx.inject` 这些是 ctx 自己的动词，不属于服务。

## 症状

插件加载时报 Proxy 拒绝，一般是这类原文：

```
Cannot access "tools" on the context: plugin "my-plugin" did not declare it in `inject`
```

如果只写了 `ctx.tools.register(...)` 但忘了 `export const inject = ['tools']`，整个插件起不来，`dsh web --dump-config` 里那一行会 `did not activate`。

## 为什么写的时候不报

`inject` 是**静态声明**，DSH 靠它做 capability 门禁：加载时就把"这个插件够得着哪些服务"定下来，服务不在名单里，`ctx.<service>` 的 getter 直接抛。这是 Proxy 拦的，不是运行时才发现的 —— 但 IDE 和 `tsc` 都不会替你补上这个数组，TypeScript 也只看类型不看 ctx 上的能力清单，所以**只有真正加载那一刻才炸**。

## 怎么查

```powershell
node scripts/check-project.mjs --only inject:declared
```

规则类型 `undeclared-inject`：扫源码，收集**文件级**的 `export const inject = [...]`（函数式插件）或 `static inject = [...]`（类插件），再看函数体里访问了哪些 `ctx.<name>`，把没声明的列出来。认识的 ctx 动词不算服务、不报。

## 怎么修

```js
export const name = 'tool-greet'
export const inject = ['tools']          // 声明了才够得着 ctx.tools

export function apply(ctx) {
  ctx.tools.register(defineTool({ /* ... */ }))
}
```

类式插件用 `static inject`：

```js
export class MyService extends Service {
  static inject = ['tools', 'settings']
  constructor(ctx) { super(ctx, 'myService') }
}
```

需要异步拿服务的，用 `ctx.inject(['x'], cb)`——它同样要求服务在触发时可用，但不必写进文件级 `inject`。

## 一个如实说明

这条规则是**文件级**判断：`inject` 声明在文件顶部，访问发生在函数体里。它不会跨文件追踪"这个 ctx 来自哪个插件"，所以嵌套的 `ctx.plugin({...})` 内联插件里访问的服务，按外层文件的 `inject` 算。宁可漏报，不误报——误报会教人忽略这条检查。
