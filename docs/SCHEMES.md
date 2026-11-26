# 标准化开发方案（scheme）

「模板 + 命令 + 配置」是这个项目里最值得复用的一招：**把确定的结构写成模板，把差异写成配置，把入口做成命令和工具，把约束写成规则。**

这一层是「开发规范化」的落点：规范化不只是事后检查，而是**生成的时候就按规范长出来，生成完立刻验一遍**。

## 一个方案是什么

一个 scheme 就是一个目录：

```
templates/bundle/
  recipe.json          变量、文件映射、规则、告警（数据）
  *.tpl / *.svg / ...  模板文件，一个变体一个文件
lib/scaffold.js        该方案的「计算部分」：derive 函数 + 深检查
```

三样东西分工明确：

| 层 | 是什么 | 谁维护 |
|---|---|---|
| **recipe.json** | 变量声明、文件映射、`when` 条件、规则、告警 | 改结构就改这里，不写代码 |
| **templates/** | 每个变体一个文件（`index.js.tpl` / `index.min.js.tpl`） | 改内容就改这里 |
| **derive 钩子** | 需要计算的值（从包名推 rowId、拼 README 的句子、预格式化 `files` 数组） | 只有在「必须算」的时候才写 JS |

**引擎不认识插件。** `lib/generate.js` 只认变量、文件、占位符、规则；`lib/rules.js` 只认检查类型。所以加一个新方案 = 加一个目录，不加生成器。

## recipe.json 的字段

```jsonc
{
  "name": "bundle",              // 方案名
  "variables": [ /* 见下 */ ],
  "files": [
    { "from": "package.json.tpl", "to": "package.json" },
    { "from": "index.js.tpl", "to": "index.js", "when": "withTool" },
    { "from": "index.min.js.tpl", "to": "index.js", "when": "!withTool" },
    { "from": "skill.md.tpl", "to": "skills/{{skillName}}/SKILL.md", "when": "withSkill" },
    { "from": "gitignore.txt", "to": ".gitignore", "package": false }
  ],
  "rules": [ /* 见下 */ ],
  "warnings": { "derive": "warnings" }
}
```

### 变量

```jsonc
{
  "name": "packageName",
  "required": true,                 // 缺了就报错
  "transform": "trim",              // trim | single-line
  "pattern": "^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$",
  "patternMessage": "use a lowercase npm name",
  "message": "the npm package name",
  "type": "boolean",                // 布尔：false 才为假
  "default": "0.1.0",
  "minLength": 3,
  "derive": "rowId",                // 由方案的 JS 钩子算出来
  "when": "withTool"                // 条件变量：条件不成立就整条跳过（也不校验）
}
```

顺序有意义：`derive` → 校验；`when` 不成立时**既不要求也不校验**（`toolName` 只在不生成工具时才无所谓）。

### `when` 的语法

只有三种，故意不做通用表达式：

| 写法 | 含义 |
|---|---|
| `withSkill` | 值为真 |
| `!withTool` | 值为假 |
| `titleZh \|\| descriptionZh` | 任一为真 |

空数组按假处理。

### 占位符

| 写法 | 结果 |
|---|---|
| `{{name}}` | 原样替换 |
| `{{name\|json}}` | `JSON.stringify` 之后替换——**JSON 里的用户输入必须走这个**，否则一个引号就把清单弄坏了 |
| `{{name}}` 在 `to` 里 | 文件名也能带变量（`skills/{{skillName}}/SKILL.md`） |

渲染完还剩下任何 `{{...}}` → **直接报错**。模板和 recipe 对不上时，宁可失败也不产出半成品。

### 文件

| 字段 | 作用 |
|---|---|
| `from` | 模板文件（相对方案目录） |
| `to` | 目标路径（相对 `dest`，可含占位符） |
| `when` | 条件，不成立就跳过 |
| `package: false` | 本地脚手架文件（`.gitignore` 之类），**不算包内容**——`files-listed` 规则会自动忽略它们 |

同一个 `to` 出现多次是正常的：那是变体选择（`index.js.tpl` 与 `index.min.js.tpl` 都指向 `index.js`，靠 `when` 二选一）。

### 规则（生成完立刻验）

| `type` | 参数 | 查什么 |
|---|---|---|
| `placeholder-free` | — | 生成出来的文件里没有残留 `{{...}}` |
| `files-listed` | `manifest`、`exclude` | 每个生成的文件都被 `package.json` 的 `files` 覆盖（目录前缀、`*.json` 单层 glob 都算） |
| `json-field` | `path`、`field`、`equals` | JSON 里的点路径存在且等于期望值 |
| `file-exists` / `file-absent` | `path` | 存在 / 不存在 |
| `frontmatter-name` | `path`、`equals` | 文件 frontmatter 的 `name` 与期望一致 |

`level: "warn"` 可以把一条降级成告警；`when` 同样可用；`path` 里可以写占位符。

规则返回的判定和 `dsh_plugin_check` **同一套词表**（pass / warn / fail），所以一次生成会同时给出「方案自检」和「包结构深检」两份结论。

## 用另一个方案

```powershell
node scripts/new-bundle.mjs --recipe <方案目录> --dest <目录> --name ... 
```

```jsonc
// dsh_plugin_new
{ "recipe": "<方案目录>", "packageName": "...", "title": "...", "description": "..." }
```

方案目录里的 `recipe.json` 决定要哪些变量；工具的参数是通用的，多余/缺失的由引擎报错。

## 加一个新方案

1. 建目录 `templates/<方案名>/`，写 `recipe.json` 与模板。
2. 需要计算的值 → 在 `lib/<方案>.js` 里写 `derivations`，调 `generate({ recipe, derivations })`。
3. 需要深检查（超出规则能表达的范围）→ 复用或新增一个 `lib/*-check.js`，把两份 `checks` 合并。
4. 写 `scripts/try-<方案>.mjs`：用真实输入生成一次，断言文件集合与规则全过。
5. 更新 `docs/PHILOSOPHY.md` 的能力表。

**判断标准**：如果新方案只需要「换文件、换变量、换规则」，就只加数据；一旦开始往引擎里写 `if (scheme === 'x')`，说明抽象错了。

## 为什么不做模板里的条件逻辑

模板里写 `{{#if withSkill}}` 会立刻变成一门小型语言：要解析、要测、要调试，出错时还很难看出是哪一层坏了。用「一个变体一个文件 + `when` 选文件」，代价是文件多一点，换来的是：模板永远是**可以直接读的文本**，选择逻辑集中在 recipe 里、一眼能看全。

同理，`package.json` 也走模板（而不是在 JS 里拼对象），这样「生成什么」只有一处真相：recipe + 模板。JSON 里的用户输入用 `{{x|json}}` 转义，不另开一条代码路径。
