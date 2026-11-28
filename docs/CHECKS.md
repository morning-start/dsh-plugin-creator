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
    { "id": "contract:tools", "type": "contract-drift",
      "file": "docs/contracts/tools.json", "generator": "node scripts/gen-tools-contract.mjs" },
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

### `session-message-identity`

交给会话的消息必须带 id。扫 `root` 下的源码，找四种写法：消息字面量没有 `id`、事件 `append` 的载荷不是构造器、构造器实参里没有 `id`、`id` 是空串。

这是**唯一一个「写的时候全对、读的时候全错」**的结构错误：写入路径（`Agent.followup / steer / inject / send`）不检查 `message.id`，加载路径（`Session.fromRestore()` → `assertMessageEventShape`）强制要求，所以一条没有 id 的消息会让人在下次打开时**整段会话打不开**，报 `... lacks an identified message`。详见 [`errors/session-message-identity.md`](../errors/session-message-identity.md)。

| 参数 | 说明 |
|---|---|
| `root` | 扫描起点，默认 `.` |
| `extensions` | 默认 `.ts` `.tsx` `.js` `.mjs` `.cjs` |
| `exclude` | 正则数组，匹配相对路径就跳过 |

注释和字符串里出现的形状**不算**（扫描器先遮掉注释与字符串再判断），所以文档和测试可以放心写反例。同样地，`errors/` 目录整个跳过——它是记录这条规则的地方，不该被自己报错。

### `undeclared-inject`

访问 `ctx.<service>` 却没在 `inject` 里声明。DSH 的上下文是 Proxy，未声明的服务**在加载那一刻**就被拒绝——不是运行时才炸。

判断只在**插件上下文**上做：文件里要有 `apply(ctx)` / `constructor(ctx)` 参数，否则一个名字叫 `ctx` 的普通对象不算。`ctx.on` / `ctx.effect` / `ctx.get` / `ctx.inject` 这些 ctx 自己的动词不是服务，不报。声明从**原文**读（`export const inject = ['tools']`、`static inject`、对象形式），访问从遮罩文本读。

详见 [`errors/undeclared-inject.md`](../errors/undeclared-inject.md)。

### `bare-name-dependency`

`import ... from 'cordis'` 这种裸名在 DSH 的装载闭包里解析不到——闭包只含 `@deepseek-ai/*`。规则列出裸名、且不在本包 `dependencies`/`devDependencies`/`peerDependencies` 里的说明符。相对路径、绝对路径、`node:` 与 Node 内置模块都不算。

详见 [`errors/bare-name-dependency.md`](../errors/bare-name-dependency.md)。

### `manifest-shape`

`package.json` 的 `dsh` 字段形状。四条判断：`bundle.patch` 必须是**单个字符串**（写成数组会静默失效）、它指向的文件必须存在、声明了 `dsh.client` 就必须有 `exports["./client"]`、`dsh` 下不能出现 `bundle`/`client`/`profile` 之外的键。

只管清单形状；patch 内容的语义（`insert` / 按 id 覆盖 / `config` 整行替换）不在这一条。

详见 [`errors/manifest-shape.md`](../errors/manifest-shape.md)。

### `custom-session-event`

`session.append('<type>', ...)` 的类型必须先 `declare module '@deepseek-ai/dsh-session/types'` 把 `<type>` augment 进 `SessionEventMap`，否则 DSH 拒绝未知类型。规则对账两边的类型集合。

只管平面 B（持久日志）；`ctx.emit` 那套进程内事件不用声明。

详见 [`errors/custom-session-event.md`](../errors/custom-session-event.md)。

### `errors-card`

`errors/` 里每个条目必须带一张完整的卡片。六样东西少一个就报：

| 字段 | 要求 |
|---|---|
| `name` | 错误名称，列表里能一眼认出来 |
| `cause` | 报错产生的原因（说机制，不说「写错了」） |
| `matches` | 至少一条**系统原文**，反查的唯一抓手 |
| `location` | 大致产生的位置 |
| `consequence` | 产生的后果（用户看到什么） |
| `fix` | 修法简述，一句话够定位 |

另外三条：`id` 必须等于文件名、`severity` 只能是 `fatal` / `broken` / `noisy`、`check` 必须指向一个**真实存在**的规则类型（写 `none` 要另作说明）。

`matches` 还有一条硬要求：**必须是系统真的会打印的原文**。写成中文描述（`"插件起不来"`）会报红——描述搜不到，原文才搜得到。这也是防止把**流程**塞进 `errors/` 的最便宜的一道闸：流程没有系统原文，只能写成描述。

`README.md` 被当作目录文档跳过；正文不参与检查——**卡片是索引，正文是解释**，规则只管索引完整。

什么该进 `errors/`、什么该进 `docs/`，见 [`AGENTS.md`](../AGENTS.md) 的归属表和 [`errors/README.md`](../errors/README.md)。

### `template-variants`

同一个目标文件可以有多个模板变体（`index.js.tpl` 带工具、`index.min.js.tpl` 是 hello），由 `recipe.json` 的 `when` 二选一。变体多了会漂移，所以查四件事：

1. **没有孤儿模板**：目录里每个 `.tpl` / `.txt` 都被 recipe 引用；
2. **占位符都声明过**：`{{x}}` 必须在 `recipe.json` 的 `variables` 里，否则生成出残留占位符；
3. **变体契约一致**：写同一个目标的变体，`export const name` 的值必须相同、都必须 `export apply(ctx)`——**只有注册什么可以不同**；
4. **inject 与使用对得上**：声明了却没碰的服务会让插件永远等它；碰了却没声明的会被 Proxy 拒绝。

```jsonc
{ "id": "templates:variants", "type": "template-variants", "directory": "templates/bundle" }
```

| 参数 | 说明 |
|---|---|
| `directory` | 模板目录，默认 `templates/bundle` |
| `recipe` | 方案文件名，默认 `recipe.json` |

这条是把「hello 和原文件之间更规范」变成可执行的：**最小变体和完整变体是同一个插件的两种形态，不是两个插件**。

### `release-pipeline`

发版只能是**推 `v*` 标签 → CI 全包**。这条规则查 workflow 有没有把那条链路接好，七件事：

1. **tag 触发**：`on.push.tags: ['v*']`——不是靠人记得跑命令；
2. **版本对账**：有步骤把 `GITHUB_REF_NAME` 和 `package.json` 的版本比一遍；
3. **registry 发布**：有 `npm publish` / `pnpm publish`；
4. **GitHub Release**：有 `gh release create`；
5. **concurrency group**：所有发版共用一个 group，两个 tag 一起推时串行化；
6. **不读存起来的 token**：出现 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 就报红——凭据应当由 OIDC 现场换；
7. **有 `id-token: write`**：trusted publishing 与 provenance 都要这个身份。

```jsonc
{ "id": "release:pipeline", "type": "release-pipeline", "workflow": ".github/workflows/release.yml" }
```

第 5 条有个坑：`group: release-${{ github.ref }}` 看起来「按 ref 分组更精细」，实际每个 tag 各成一组，等于没串行——同事就是这样把 `latest` 弄反的。必须是一个固定 group。

只管**链路在不在**，不管这次发版对不对——版本↔标签的对账在 CI 里跑（`release:tag` 只能在 HEAD 已有 tag 时比）。

流程本身与补救办法见 [`docs/RELEASE.md`](RELEASE.md)；这条规则不是「错误归档」，它是**流程的守门人**。

### 通用规则（与方案引擎共用）

`file-exists`、`file-absent`、`files-listed`、`placeholder-free`、`json-field`、`frontmatter-name`——语义见 [`SCHEMES.md`](SCHEMES.md)，同一套实现、同一套 pass/warn/fail。

### `contract-drift`

生成物与源码对账。**手写的契约文档一定会漂移**；让它由代码生成、由检查守住，改动就会出现在 diff 里，而不是悄悄过期。

```jsonc
{
  "id": "contract:tools",
  "type": "contract-drift",
  "file": "docs/contracts/tools.json",              // 提交进仓库的生成物
  "generator": "node scripts/gen-tools-contract.mjs",
  "mode": "stdout"                                   // 默认 stdout；另有 file
}
```

| `mode` | 生成器怎么工作 | 检查怎么做 |
|---|---|---|
| `stdout`（默认） | 把内容打到标准输出 | 比对 stdout 与文件；不一致就报第一条差异行 |
| `file` | 自己写目标文件（`--check` 那种风格的生成器） | 跑之前记指纹、跑完再记一次，变了就是漂移 |

两种模式都支持 `--update` / `{ update: true }`：**不是只报告，而是重新生成**。所以「生成」和「验证」是同一份规则的两个动作，不用维护两套逻辑。

判据与细节：

- 比较前统一换行符与行尾空白，所以 CRLF/LF 差异不算漂移；
- 漂移报告给出**第一条差异的行号与两侧内容**，不用自己 diff；
- 生成器退出码非 0 → 规则 fail 并带上退出码与 stderr；
- 生成器是**项目自己的脚本**，`checks.json` 因此能执行命令——把它当 `package.json` 的 scripts 一样对待：只放你自己的生成器。

> 为什么值得做：myteam 项目的工具面契约是 `gen-tool-contract.mjs` 生成的，`--check` 守着它。手写那版曾经落后于代码，导致文档上写着不存在的工具。生成 + 对账之后，改工具必然改契约，否则 CI 红。

本仓库也用自己的规则检查自己的工具面：`scripts/gen-tools-contract.mjs` 把六个工具的名字、说明、参数 schema、输出 schema 生成为 `docs/contracts/tools.json`，`checks.json` 里的 `contract:tools` 守着它。

## 生成的插件包自带起手 checks.json

`dsh_plugin_new` 生成的包里直接带一份 `checks.json`，新项目不用重新发现这些规则：

| 规则 | 默认开 |
|---|---|
| `docs:links` | ✅ |
| `locale:parity` | 只在生成时给了中文（有 `locale/zh.json`）才加 |
| `bundle:entry` / `bundle:patch` | ✅ |
| `bundle:files-listed` | ✅（`exclude` 里显式列出 `.gitignore`、`.gitattributes`、`checks.json` 这些本地文件） |
| `manifest:dsh-shape` | ✅ |
| `inject:declared` / `depends:bare-name` / `session:custom-event` | ✅（`root: "."`，新包还没有 `lib/` 时扫到 0 个文件也算通过） |
| `session:messages` | ✅ |
| `release:pipeline` | ✅（生成的包带同一份 workflow） |
| `errors:cards` / `templates:variants` | 不预置（前者要求 `errors/` 目录，后者要求 `templates/bundle/`） |

模板两套（`checks.json.tpl` 无中文 / `checks.json.zh.tpl` 有中文）因此分别有 **10 / 11 条**规则。

两条设计取舍：

- **不预置 `import-boundary`**：新项目通常还没有分层，写了也是空转；等真有 `src/` 再加；
- **`files-listed` 的 exclude 写进文件本身**，而不是靠生成器注入——单独跑 `check-project` 时没有生成器的上下文，规则必须自洽。

方案里对应 `templates/bundle/checks.json.tpl` 与 `checks.json.zh.tpl` 两个变体（`when: hasZh` 二选一），并有一条 `recipe:checks` 规则验证生成出来的 `checks.json` 自身有 `rules`。

## 本仓库自己的 checks.json

这个仓库也用自己的规则检查自己（dogfood）：

```json
{ "rules": [
  { "id": "docs:links", "type": "doc-links", "exclude": ["\\.dsh-memory/", "^tmp/"] },
  { "id": "locale:parity", "type": "locale-parity", "files": ["locale/en.json", "locale/zh.json"] },
  { "id": "contract:tools", "type": "contract-drift",
    "file": "docs/contracts/tools.json", "generator": "node scripts/gen-tools-contract.mjs" },
  { "id": "bundle:entry", "type": "file-exists", "path": "index.js" },
  { "id": "bundle:patch", "type": "json-field", "path": "package.json", "field": "dsh.bundle.patch", "equals": "./cordis.patch.yml" },
  { "id": "session:messages", "type": "session-message-identity", "root": "." },
  { "id": "inject:declared", "type": "undeclared-inject", "root": ".", "exclude": ["^tmp/", "^scripts/"] },
  { "id": "depends:bare-name", "type": "bare-name-dependency", "root": ".", "exclude": ["^tmp/", "^scripts/"] },
  { "id": "manifest:dsh-shape", "type": "manifest-shape", "manifest": "package.json" },
  { "id": "session:custom-event", "type": "custom-session-event", "root": "." },
  { "id": "errors:cards", "type": "errors-card" },
  { "id": "templates:variants", "type": "template-variants", "directory": "templates/bundle" },
  { "id": "release:pipeline", "type": "release-pipeline", "workflow": ".github/workflows/release.yml" }
] }
```

## `errors/`：踩过的坑也要能被检查

规则分布在 `lib/rules.js`，但**为什么要这条规则**写在 [`errors/`](../errors/README.md)。一条已知会把人坑死的错误一个文件，格式像 skill：frontmatter 写 `id` / `severity` / `check`，正文写「什么时候会踩 / 症状 / 为什么当时不报 / 怎么查 / 怎么修」。

这个目录是给下一个人（和下一个模型）看的：`lib/rules.js` 里的检查只说明**怎么查**，`errors/*.md` 说明**为什么值得查**。写不出「为什么当时不报」的条目，说明还没理解这个坑，先别加规则。

`errors/` 里的 markdown 会引用坏形状的代码，所以 `session-message-identity` 规则和 `session:message-identity` 检查都跳过这个目录——**否则文档会把自己报成错误**，唯一的「修法」是删掉反例。

## 不做什么

- **不做 lint**：语法与风格交给真正的 linter，这里只查「结构关系」；
- **不跑测试**：`check-project` 是静态的，跑测试是另一件事；
- **不替你写生成器**：`contract-drift` 只负责跑你的生成器并比对结果；把 schema 导出成文档这一步属于项目自己（本仓库的例子是 `scripts/gen-tools-contract.mjs`）。
- **不猜你的分层**：`layers` 必须显式写出来，写错就是规则写错，不会替你推断。
