# 工具与能力对照

README 讲能力，这个文件讲**具体是哪个工具、什么参数、边界在哪**。

## 能力 → 用到的工具

| 能力 | 工具 / 技能 | CLI |
|---|---|---|
| 从标准模板起一个插件包 | `dsh_plugin_new` + 技能 `dsh-plugin-new`（负责问询） | `scripts/new-bundle.mjs` |
| 检查一个包为什么装不上 / 显示不出来 | `dsh_plugin_check` | `scripts/try-tool.mjs`（只测自身） |
| 拦住开发中插件的本地安装 | 安装守卫（不是工具，见下） | — |
| 沙盒测试（建 / 起 / 探 / 停 / 清） | `dsh_sandbox` + 技能 `dsh-plugin-sandbox`（负责判断） | `scripts/sandbox.mjs` |
| 看页面 / 断言 / 真实点击 | `dsh_plugin_ui` | `scripts/ui.mjs` |
| 发版（就绪检查 / 打包 / 沙盒演练） | `dsh_plugin_release` | `scripts/release.mjs` |
| 按方案生成任意结构化内容 | `dsh_plugin_new` 的 `recipe` 参数 | `scripts/new-bundle.mjs --recipe` |
| 结构规范检查（方案自带规则） | `dsh_plugin_check` 的规则段 + `lib/rules.js` | `scripts/try-generate.mjs` |

## 工具

### `dsh_plugin_check`

只读结构检查。**不修改任何文件。**

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string，必填 | 插件包目录的绝对路径（含 `package.json` 的那一层） |

输出：`{ ok, target, summary: { pass, warn, fail }, checks: [{ id, status, message }] }`。
逐项给结论，不在第一个错误上抛异常。

查这些：清单字段、`dsh.bundle.patch` 声明、locale / 图标导出、入口模块、详情文档、`files` 白名单、patch 里的相对模块名。

**查不到**：YAML 语法错误（不按 YAML 解析 patch 文件）、运行时行为、客户端渲染。

### `dsh_plugin_new`

按方案生成目录。**确定性**：同一组参数产出同样的文件；写完立刻跑一次检查。

| 参数 | 类型 | 说明 |
|---|---|---|
| `packageName` | string，必填 | 全小写 npm 名，`dsh-plugin-x` 或 `@scope/x`；row id 由它推导 |
| `title` | string，必填 | Plugin Manager 里显示的名字 |
| `description` | string，必填 | 原样显示给用户，写清「做什么 + 从哪儿触发」 |
| `dest` | string | 目标目录；不给就落在会话工作目录下的 `<包名>` |
| `titleZh` / `descriptionZh` | string | 给了就多生成 `locale/zh.json` |
| `rowId` / `toolName` / `skillName` / `version` | string | 覆盖推导值 |
| `withTool` | boolean，默认 true | 是否生成并注册示例工具 |
| `withSkill` | boolean，默认 false | 是否生成 SKILL.md 与 skill provider 行 |
| `force` | boolean | 允许写进非空目录（只覆盖本方案生成的文件） |
| `recipe` | string | 用另一个方案（含 `recipe.json` 的目录）；默认内置 bundle 方案 |
| `configPath` | string | 从 JSON 文件读上述字段，命令行参数优先 |

输出：`{ dest, files, warnings, checks: { ok, pass, warn, fail, findings } }`。
`warnings` 是「发版前该处理」的提醒（图标是占位、描述太短、skill 的部署级影响等），**不是错误**。

方案格式见 [`SCHEMES.md`](SCHEMES.md)。

### `dsh_sandbox`

管理项目自己的测试沙盒。所有操作都先校验 `sandbox.json` 的归属，跨项目会被拒绝。

| `action` | 参数 | 作用 |
|---|---|---|
| `list` | `project?` | 列出沙盒：端口、profile、有没有模型、标记是否正常；顺带报「磁盘有但登记表没有」的文件夹 |
| `create` | `name`、`plugin?`、`project?` | 建 home + 工作区、复制 profile、`link:` 装插件、分配项目内唯一端口 |
| `start` | `name`、`waitMs?` | 起实例并**返回 URL**（agent 可直接打契约）；已在跑则返回已有 URL |
| `open` | `name` | 只打印给用户的两行命令（他要自己开、自己加模型时用） |
| `status` | `name` | 探活 + HTTP 状态；端口上坐着陌生进程时会点出来 |
| `fix-workspace` | `name` | 把宿主登记的默认工作区指到沙盒副本（要页面先加载过一次） |
| `http` | `name`、`path`、`method?`、`body?` | 带会话 token 请求路径；返回状态码 / content-type / 正文前 4000 字符，**正文里的 token 替换成 `{{token}}`** |
| `seed` | `name`、`entries[]`、`from?`、`force?` | 从真实 `DSH_HOME`（默认 `~/.dsh`）只读复制指定条目进来；源不动 |
| `stop` | `name`、`force?` | 只杀 `start` 记录的那个 pid；pid 对不上**拒绝**并报出占用者 |
| `remove` | `name`、`confirm: true` | 删沙盒目录（含模型凭据与已装版本），先停实例 |

`project` 默认取会话工作目录。`start` 与 `open` 的区别只是「谁按下去」；两种方式加模型都由用户做一次。

### `dsh_plugin_ui`

用无头浏览器（CDP）看真页面。**截图证明渲染，断言证明对错**，两者都不能代替人看观感。

| `action` | 参数 | 作用 |
|---|---|---|
| `shot` | `sandbox`+`path` 或 `url`、`out?`、`size?` | 截图存 PNG，返回路径 |
| `assert` | 同上 + `assertions[]` | 逐条断言：`selector` / `text` / `expression`(+`equals`) / `noConsoleErrors` / `noNetworkFailures` |
| `eval` | 同上 + `expression` | 在页面里求值并返回 |
| `close` | `port?` | 停掉浏览器 |

共同参数：`click`（先真实点击某选择器）、`type`（`{selector, text}`，走 `Input.insertText`）、`settleMs`、`port`（默认 9222）。

**token**：给 `sandbox` 时从沙盒日志取 URL 与 `?token=`，正文里的 token 替换成 `{{token}}`。

**边界**：需要本机 Chrome/Edge（`CHROME_PATH` 可指定）；不覆盖多窗口、拖拽、输入法；视觉判断仍是人；`element.click()` 那类合成事件不算点击。步骤与判据见 [`UI.md`](UI.md)。

### `dsh_plugin_release`

发版就绪检查、打包、沙盒演练。**不发布**（不跑 `npm publish`）。

| `action` | 参数 | 作用 |
|---|---|---|
| `check` | `path`、`dshVersion?` | 问打包器真实会装进 tarball 的文件（`pnpm pack --dry-run --json`，退 `npm`，再退按 `files` 近似并标注），并拿 `dsh --version` 与 `engines.dsh`（没有就看 `@deepseek-ai/dsh` 依赖）比对 |
| `pack` | `path`、`outDir?` | 写 tarball，默认 `tmp/release/` |
| `rehearse` | `path`、`sandbox?`（默认 `rollback`）、`project?` | 建/复用沙盒 → 打包 → 把 **tarball** 装进沙盒 profile → `--dump-config` 读回，返回回滚命令 |

检查项：`release:manifest` / `name` / `description` / `version` / `entry` / `patch` / `private`（warn）/ `compatibility` / `surface` / `size`（warn）/ `contents`。

**边界**：不发布、不验 registry 权限、semver 只支持 `^` `~` `>=` `<=` `>` `<` `=` `||`（不处理 `*` / `x` / 范围）、不验客户端渲染。步骤与判据见 [`RELEASE.md`](RELEASE.md)。

## 守卫（不是工具）
`ctx.tools.guard()`，在调用**执行前**拒绝，不占用任何工具位。拒绝这两种：

| 触发 | 条件 |
|---|---|
| `plugin_manager` | `action: install_bundle` 且 target 是目录 / `link:` / `file:` |
| `pwsh` / `bash` / `terminal` | 命令里是 `dsh plugin … add` 且带本地路径或 `link:` |

放行三种：registry spec（`name@version`）、宿主本身是沙盒（`DSH_HOME` 在带 `sandbox.json` 的文件夹下，或在 `tmp/sandboxes/` 下）、用户设了 `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`。

**边界**：管不到用户在终端里手敲 `dsh plugin add`；不是安全边界，是防手滑的刹车。

## 技能

| 技能 | 管什么 | 不管什么 |
|---|---|---|
| `dsh-plugin-new` | 生成前问哪些字段、哪些决策归用户、报告里每条 warn 怎么处理 | 不写文件，不生成 |
| `dsh-plugin-sandbox` | 用哪个沙盒、何时重建、测试阶梯、什么算「验过」、哪些验不到 | 不起实例（那是工具的事） |

## 回归脚本

| 脚本 | 覆盖 |
|---|---|
| `scripts/try-tool.mjs` | 五个工具挂载 + 生成一个包并自检 + 13 个守卫用例 |
| `scripts/try-generate.mjs` | 通用引擎与规则引擎（40 项）+ 两种 bundle 变体 |
| `scripts/try-sandbox.mjs` | 沙盒引擎（45 项，假启动器，不开真宿主） |
| `scripts/try-release.mjs` | 发版检查（30 项：semver 子集、就绪检查、真实包面） |
| `scripts/try-ui.mjs` | 真浏览器：断言、真实点击/输入、截图 PNG、console error 捕获 |
| `scripts/check-patch.mjs` | `cordis.patch.yml` 与出货预设的漂移 |
| `scripts/check-skills.mjs` | 技能 frontmatter（需 DSH 运行时的 YAML 库） |
