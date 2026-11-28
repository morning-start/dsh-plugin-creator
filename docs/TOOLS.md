# 工具与能力对照

README 讲能力，这个文件讲**具体是哪个工具、什么参数、边界在哪**。

## 能力 → 用到的工具

| 能力 | 工具 / 技能 | CLI |
|---|---|---|
| 从标准模板起一个插件包 | `dsh_plugin_new` + 技能 `dsh-plugin-new`（负责问询） | `scripts/new-bundle.mjs` |
| 把已有插件补成标准项目 | `dsh_plugin_adopt`（默认只出计划，`mode: apply` 才写） | `scripts/adopt.mjs` |
| 把模糊需求变成插件形态 | 技能 `dsh-plugin-new` 的构思流程 + `references/conception.md`（内化的场景驱动方法，不依赖外部技能） | — |
| 检查一个包为什么装不上 / 显示不出来 | `dsh_plugin_check` | `scripts/try-tool.mjs`（只测自身） |
| 项目自己的规范检查（断链 / locale / 分层 / console） | `dsh_project_check` | `scripts/check-project.mjs` |
| 拦住开发中插件的本地安装 | 安装守卫（不是工具，见下） | — |
| 沙盒测试（建 / 起 / 探 / 停 / 清） | `dsh_sandbox` + 技能 `dsh-plugin-sandbox`（负责判断） | `scripts/sandbox.mjs` |
| 看页面 / 断言 / 真实点击 | `dsh_plugin_ui` | `scripts/ui.mjs` |
| 发版（改版本 / 就绪检查 / 打包 / 沙盒演练） | `dsh_plugin_release` | `scripts/release.mjs` |
| 建仓库 / 对齐仓库（公开 + dsh-plugin topic） | `dsh_repo` | `scripts/repo.mjs` |
| 发布之后：一条命令跑完 check → pack → publish → release → verify | — | `scripts/release.mjs ship` |
| 发布之后：单步 npm 发布 / 传播核对 / GitHub Release / 市场条目 | —（只走 CLI，因为都在推送之后） | `scripts/release.mjs publish\|verify\|gh-release\|market` |
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

查这些：清单字段、`dsh.bundle.patch` 声明、locale / 图标导出、入口模块、详情文档、`files` 白名单、patch 里的相对模块名，以及**隐私**与**安全**两组（见下）。

#### 隐私（默认开启，不需要项目声明）

| 检查 | 级别 | 查什么 |
|---|---|---|
| `privacy:home-paths` | fail | `C:\Users\<name>`、`/Users/<name>`、`/home/<name>`——泄露作者账号 |
| `privacy:credentials` | fail | 私钥头、`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xox*`、`AIza` 形态的密钥 |
| `privacy:machine-paths` | warn | 作者特有的绝对路径（暴露机器布局） |
| `privacy:emails` | warn | 示例域之外的邮箱地址 |

占位账号（`<user>`、`/Users/someone`、`/home/you` 这类）不算泄露——误报会教人忽略这条检查。

#### 安全（默认开启）

| 检查 | 级别 | 查什么 |
|---|---|---|
| `security:install-hooks` | fail | `preinstall` / `install` / `postinstall` / `prepare` / `prepack`——**安装时就在用户机器上执行** |
| `security:dynamic-code` | fail | `eval`、`Function` 构造器、`vm` 沙箱（只查打包进去的代码文件） |
| `security:shell-interpolation` | warn | `shell: true` 且命令串里有插值——值里带引号就能改命令 |
| `security:capabilities` | warn | **能力清单**：能跑命令 / 开网络 / 写文件 / 读环境，逐个列出文件和位置 |

最后一条是设计选择：**「会不会破坏」无法证明，但可以枚举**。一个会跑命令的插件不一定不安全，但审阅的人必须能看见它会跑命令、在哪跑。所以这一条只报告，不判死。

#### 会话消息

| 检查 | 级别 | 查什么 |
|---|---|---|
| `session:message-identity` | warn | 交给会话的消息有没有 `id`：字面量、事件 `append` 的载荷、构造器实参 |

**写的时候全对、读的时候全错**：写入路径不检查 `message.id`，加载路径（`Session.fromRestore()`）强制要求，所以一条没 id 的消息会让人下次打开时整段会话打不开（`... lacks an identified message`）。文档里写反例、测试里写坏形状都不算——注释和字符串先被遮掉。

同样地，`errors/` 目录整个跳过：那是记录这条规则的地方，不该被自己报错。

#### 清单形状

| 检查 | 级别 | 查什么 |
|---|---|---|
| `dsh-shape` | fail | `package.json` 的 `dsh` 字段：`bundle.patch` 是否为单个字符串路径、`dsh.client` 是否有 `exports["./client"]`、有没有未知字段 |

`bundle.patch` 写成数组是**静默失效**的典型：JSON 合法、`npm pack` 成功，宿主读不懂就当普通包。不存在 `dsh.plugin.json`——真实清单只有 `package.json` 的 `dsh` 字段。

**查不到**：YAML 语法错误（不按 YAML 解析 patch 文件）、运行时行为、客户端渲染、依赖供应链（不查第三方包漏洞）。

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

### `dsh_project_check`

跑项目自己在 `checks.json`（或 `dsh-checks.json`）里声明的规则。**只读**，逐条给 pass/warn/fail。

| 参数 | 说明 |
|---|---|
| `path` | 项目目录（绝对路径） |
| `config` | 指定另一个检查文件，默认在项目根找 |
| `only` | 只跑这些规则 id（或类型），修某一组时用 |
| `update` | 重新生成契约文件（`contract-drift` 规则）而不是只报漂移。会写文件，确认 diff 符合预期时才传 |

规则类型：`doc-links`（相对 markdown 链接可解析）、`locale-parity`（多语言 key 一致）、`import-boundary`（分层依赖方向 / 宿主模块 / 外部包）、`no-console`、`contract-drift`（生成物与生成器对账），以及通用的 `file-exists` / `file-absent` / `files-listed` / `placeholder-free` / `json-field` / `frontmatter-name`。

**边界**：不做 lint、不跑测试、不替你写生成器；分层必须显式写，不替你推断。规则语义与「别乱加豁免」的教训见 [`CHECKS.md`](CHECKS.md)。

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

发版就绪检查、改版本、打包、沙盒演练。**不发布**（发版只由推 tag 触发，由 CI 跑）。

| `action` | 参数 | 作用 |
|---|---|---|
| `version` | `path`、`part?`（`patch`/`minor`/`major`，默认 `patch`）、`version?` | 固定流程的第 1 步：改 `package.json` 的版本，并打印后面的 commit / tag / push 命令。**唯一会写项目的动作**。拒绝降级、拒绝重复、拒绝当前版本不是 semver，也拒绝一个已有 `v*` tag 的版本（移动 tag 会让它指向什么变得不可信） |
| `check` | `path`、`dshVersion?` | 问打包器真实会装进 tarball 的文件（`pnpm pack --dry-run --json`，退 `npm`，再退按 `files` 近似并标注），并拿 `dsh --version` 与 `engines.dsh`（没有就看 `@deepseek-ai/dsh` 依赖）比对 |
| `pack` | `path`、`outDir?` | 写 tarball，默认 `tmp/release/` |
| `rehearse` | `path`、`sandbox?`（默认 `rollback`）、`project?` | 建/复用沙盒 → 打包 → 把 **tarball** 装进沙盒 profile → `--dump-config` 读回，返回回滚命令 |

检查项：`release:manifest` / `name` / `description` / `version` / `entry` / `patch` / `private`（warn）/ `compatibility` / `surface` / `size`（warn）/ `contents`。

**边界**：不发布、不验 registry 权限、semver 只支持 `^` `~` `>=` `<=` `>` `<` `=` `||`（不处理 `*` / `x` / 范围）、不验客户端渲染。步骤与判据见 [`RELEASE.md`](RELEASE.md)。

`version` 只改 `package.json`，**不做 git 操作**：提交、打 tag、推送各自可见且可回退，而 publish 不可回退，所以它们不该被合成一条命令。

### `dsh_repo`

把项目放到 GitHub 上，并把仓库对齐到插件市场的约定：**公开** + `dsh-plugin` topic（市场的发现靠这个 topic，默认 private 等于让它找不到）。

| `action` | 参数 | 作用 |
|---|---|---|
| `plan` | `path`、`owner?`、`repo?`、`visibility?`、`topic?` | **只读**：打印它将会跑的那几条 `gh` 命令，什么都不改 |
| `create` | `path`、`owner`、`repo?`、`visibility?`、`topic?`、`description?`、`dryRun?` | 目录还没有 `origin`：`git init` → 对齐 `package.json` 的 `repository` → `gh repo create <owner>/<repo> --public --source . --remote origin --push` → `gh repo edit --add-topic dsh-plugin` |
| `update` | `path`、`visibility?`、`topic?`、`description?`、`commit?`、`dryRun?` | 目录已经指向 GitHub：可见性与目标不一致时才 `gh repo edit --visibility`；补 topic / 描述（已存在时是幂等的）；把 `package.json` 的 `repository` 对齐成**单独一个提交**，**不推送** |

两个动作的分界是「有没有 `origin`」：有 `origin` 时调 `create` 会**直接拒绝**并让你用 `update`，否则就会多出一个仓库。反过来 `update` 遇到没有 `origin` 的目录也会拒绝。

**`update` 从不推送。** 准备一个提交和把它公开是两件事，后者是用户的决定。

`repository` 字段对齐先于 `create` 的推送，所以落到 GitHub 上的第一个提交就已经指回自己。

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
| `scripts/try-tool.mjs` | 八个工具挂载 + 生成一个包并自检 + 守卫用例 11 条 + 沙盒宿主 2 条 |
| `scripts/try-generate.mjs` | 通用引擎与规则引擎（40 项）+ 两种 bundle 变体 |
| `scripts/try-sandbox.mjs` | 沙盒引擎（45 项，假启动器，不开真宿主） |
| `scripts/try-release.mjs` | 发版检查（30 项：semver 子集、就绪检查、真实包面） |
| `scripts/try-ui.mjs` | 真浏览器：断言、真实点击/输入、截图 PNG、console error 捕获 |
| `scripts/try-checks.mjs` | 项目规则引擎（37 项：断链、locale 对齐、分层越界、console、契约漂移、checks 文件） |
| `scripts/try-audit.mjs` | 隐私与安全两组（29 项：账号路径、凭据、邮箱、机器路径、安装钩子、动态代码、能力清单） |
| `scripts/check-patch.mjs` | `cordis.patch.yml` 与出货预设的漂移 |
| `scripts/check-skills.mjs` | 技能 frontmatter（需 DSH 运行时的 YAML 库） |
