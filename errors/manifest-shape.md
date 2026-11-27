---
id: manifest-shape
title: package.json 的 dsh 字段写错，插件不会被当成插件
since: 0.1.5-alpha.1
applies-to: [plugin]
severity: broken
check: manifest-shape
---

# dsh 清单字段的形状

## 什么时候会踩

只在**写 `package.json` 的 `dsh` 字段**的时候。三种形态各有一套字段，写错形状或不写，DSH 就不把它当对应的东西：

| 形态 | 正确的 dsh 字段 |
|---|---|
| Bundle | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| Client / dual-face | `"dsh": { "client": ... }` + `exports["./client"]` |
| Profile 依赖 | `"dsh": { "profile": { "bundles": [...] } }` |

不适用：`.dsh-plugin` 目录——那是外部 plugin-registry 机制，不是 package.json。

## 症状

各不相同，但都很静默：

- `bundle.patch` 写成数组 → 打包/装载时当作没有 patch，插件装上了却什么也不做；
- `bundle.patch` 指向不存在的文件 → 装了没反应，`--dump-config` 里那行 `did not activate`；
- dual-face 有 `dsh.client` 却漏了 `exports["./client"]` → 宿主伺服 `/plugins/<id>/client.js` 时 404，浏览器半部永远是空的；
- 写成 `dsh.plugin` / `dsh.plugins` / `dsh.bundle.patches` → 字段名不对，等于没写。

## 为什么写的时候不报

**不存在 `dsh.plugin.json`**——真实清单只有 `package.json` 的 `dsh` 字段。没有任何 schema 在编辑期拦你：JSON 是合法 JSON，`npm pack` 也成功，宿主只是"按它读到的东西理解你"，读不懂就当普通 npm 包。

## 怎么查

```powershell
node scripts/check-project.mjs --only manifest:dsh-shape
```

规则类型 `manifest-shape`，四条判断：

| 发现 | 原文 |
|---|---|
| `dsh.bundle.patch` 不是字符串 | `dsh.bundle.patch must be a single string path` |
| `dsh.bundle.patch` 指向的文件不存在 | `dsh.bundle.patch names a missing file` |
| 声明了 `dsh.client` 却没有 `exports["./client"]` | `dsh.client declared but exports["./client"] is missing` |
| `dsh` 下出现了未知的键 | `unknown dsh field(s): ...`（`bundle` / `client` / `profile` 之外的）

## 怎么修

```json
{
  "name": "@dsh-external/my-plugin",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

注意 `bundle.patch` 是**单个字符串路径**，不是数组——多写一对方括号就会静默失效。

## 和 patch 内容的分工

这条只管**清单字段的形状**。patch 文件里 `- insert:` / 按 id 覆盖的语义、`name` 不符只 warn 就跳过、`config` 是整行替换不深合并——那些是 patch 内容的问题，不在这一条里。
