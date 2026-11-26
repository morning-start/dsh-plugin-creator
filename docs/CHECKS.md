# 规范化检查：把项目边界写成规则

「规范化」如果只写在文档和 code review 里，一次「顺手 import 一下」就能让它失效，而且没有任何东西会报错。这个能力把边界变成**项目自己声明的规则**，跑一遍就知道有没有越界。

规则是数据：项目根放一个 `checks.json`，`dsh_project_check` 或 `node scripts/check-project.mjs` 执行它。

## 为什么是「项目声明」而不是「工具内置」

不同项目的分层不一样：有的按 `contracts/domain/application/infrastructure/composition` 分，有的根本没有分层；有的 `lib/` 不许 import 第三方包，有的就是靠第三方包。**边界属于项目**，工具只提供规则类型和执行器。

## 用起来

```powershell
node scripts/check-project.mjs            # 读项目根的 checks.json
node scripts/check-project.mjs --only docs:links
node scripts/check-project.mjs --config ci/checks.json
```

```jsonc
// dsh_project_check
{ "path": "<项目目录>", "only": ["docs:links"] }
```

退出码：全部通过 0，有 fail 1。每条规则给 pass / warn / fail 和一句人话说明，**不在第一个错误上停**。

## 一个起手的 checks.json

```json
{
  "version": 1,
  "rules": [
    { "id": "docs:links", "type": "doc-links", "exclude": ["\\.dsh-memory/"] },
    { "id": "locale:parity", "type": "locale-parity", "files": ["locale/en.json", "locale/zh.json"] },
    { "id": "arch:layers", "type": "import-boundary", "root": "src",
      "layers": {
        "domain": ["application", "infrastructure"],
        "application": ["infrastructure"],
        "infrastructure": []
      },
      "builtins": { "domain": ["fs", "child_process"], "application": ["fs"] },
      "allowExternal": ["infrastructure"] },
    { "id": "arch:console", "type": "no-console", "root": "src", "layers": ["domain", "application"] }
  ]
}
```

## 规则类型

### `doc-links`

markdown 里的**相对链接**必须解析得到。跳过 `http(s)://`、`mailto:`、`#锚点` 和以 `/` 开头的绝对路径（那是 URL 路径，不是仓库路径）；fragment 不查，只查文件在不在。

| 参数 | 说明 |
|---|---|
| `skip` | 不当作文档树的目录名，默认 `node_modules` `.git` `tmp` `.debug` `dist` `lib` |
| `exclude` | 正则数组，匹配目标路径就跳过（例如运行期数据目录 `.dsh-myteam/`） |

> **别乱加豁免**。真实事故：某个项目曾把 `plugin/src/**` 从断链检查里豁免掉，理由是「v1 已移出工作树」；后来 v2 源码回到那个路径，5 条指向死路径的链接全部静默通过，报告还写着「断链 0」。豁免只留给**本来就不入库**的运行期数据。

### `locale-parity`

多语言文件必须携带**同一套 key**（点路径展开后比较）。少一个 key 的表现是界面某处回落到英文或空串，很难在测试里发现。

### `import-boundary`

分层依赖方向门禁。扫 `root` 下的源码，按第一段目录名判断分层，然后查三件事：

1. **依赖方向**：`layers[layer]` 列出的层不许被它 import；
2. **宿主模块**：`builtins[layer]` 列出的内置模块不许 import（`node:` 前缀也算）；
3. **外部包**：不在 `allowExternal` 里的层不许 import 任何包。

```jsonc
{
  "id": "arch:layers", "type": "import-boundary", "root": "plugin/src",
  "extensions": [".ts"],                     // 默认 .ts .tsx .js .mjs
  "layers": { "domain": ["application", "infrastructure"] },
  "builtins": { "domain": ["fs", "path"] },
  "allowExternal": ["infrastructure", "composition"]
}
```

判断分层的规则：路径或 import 说明符里**第一个不是 `.` / `..` 的段**。所以 `../domain/user.js` 归 `domain`，`./local` 和 `lodash` 不属于任何层。

### `no-console`

指定的层里不许有 `console.log/info/debug`。比 `import-boundary` 单独拆出来，是因为它常常只对一部分层生效，而且改起来很快。

### 通用规则（与方案引擎共用）

`file-exists`、`file-absent`、`files-listed`、`placeholder-free`、`json-field`、`frontmatter-name`——语义见 [`SCHEMES.md`](SCHEMES.md)，同一套实现、同一套 pass/warn/fail。

## 本仓库自己的 checks.json

这个仓库也用自己的规则检查自己（dogfood）：

```json
{ "rules": [
  { "id": "docs:links", "type": "doc-links", "exclude": ["\\.dsh-memory/", "^tmp/"] },
  { "id": "locale:parity", "type": "locale-parity", "files": ["locale/en.json", "locale/zh.json"] },
  { "id": "bundle:entry", "type": "file-exists", "path": "index.js" },
  { "id": "bundle:patch", "type": "json-field", "path": "package.json", "field": "dsh.bundle.patch", "equals": "./cordis.patch.yml" }
] }
```

## 不做什么

- **不做 lint**：语法与风格交给真正的 linter，这里只查「结构关系」；
- **不跑测试**：`check-project` 是静态的，跑测试是另一件事；
- **不生成契约文件**：契约的**生成**（把面板/工具/配置的 schema 导出成文档）不在这个能力里；要验契约有没有漂移，先把它导出成文件，再用 `json-field` / `placeholder-free` 这类规则对账。
- **不猜你的分层**：`layers` 必须显式写出来，写错就是规则写错，不会替你推断。
