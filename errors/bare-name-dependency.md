---
id: bare-name-dependency
title: 用裸名 import cordis / schemastery，装载闭包里解析不到
since: 0.1.5-alpha.1
applies-to: [plugin]
severity: broken
check: bare-name-dependency
---

# 裸名依赖解析不到

## 什么时候会踩

只在**插件源码里 import 框架包**的时候，而且 import 的是裸名：

```js
import { Context } from 'cordis'                 // ✗
import z from 'schemastery'                      // ✗
```

不适用：`import ... from '@deepseek-ai/cordis'`、`'@deepseek-ai/schemastery'`，以及任何你自己在 `dependencies` 里列了的包。

## 症状

插件加载失败，宿主日志里是模块解析错误：

```
Cannot find package 'cordis' imported from .../my-plugin/lib/index.js
```

`dsh web --dump-config` 里那一行 `did not activate`；页面上对应的入口整块消失。

## 为什么写的时候不报

DSH 的加载器把框架 **vendor 化**成一个只含 `@deepseek-ai/*` 的闭包。你的插件能解析到 `@deepseek-ai/cordis`，**解析不到裸名 `cordis`**——除非它自己目录下装了同名依赖。

开发期如果恰好有 `node_modules/cordis`（比如从别的项目拷来的），本地跑得通；换到干净的 profile 就炸。这类"我这儿是好的"最耗时。

## 怎么查

```powershell
node scripts/check-project.mjs --only depends:bare-name
```

规则类型 `bare-name-dependency`：扫源码的 `import ... from 'x'` / `require('x')` / `export ... from 'x'`，把裸名且**不在本包 `dependencies`/`devDependencies`/`peerDependencies` 里**的说明符列出来。相对路径（`./`、`../`）、绝对路径、`node:` 内置都不算。

## 怎么修

框架一律走 scoped 包：

```js
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
```

如果你确实要用一个裸名第三方包，把它写进本包 `package.json` 的 `dependencies`——规则就不再报它，而且它会真的被装进插件目录。

## 判据

**裸名能不能解析，取决于"这个闭包里有没有它"**。框架闭包只有 `@deepseek-ai/*`，所以除了自己声明过的依赖，任何裸名都视为解析不到。
