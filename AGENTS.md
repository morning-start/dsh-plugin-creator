# AGENTS.md

**这是本项目的开发文档**：怎么在本地跑、改动该放哪儿、什么不能碰。

- **想用这个插件**（怎么装、几个工具、几个 skill）→ 看 [`README.md`](README.md)，那份是给用户的。
- **想改这个仓库**（写代码、加规则、加工具、写文档）→ 就是这份。

## 本地怎么跑

纯 ESM，**无依赖、无构建步骤**。不需要安装、不需要宿主，除了最后那组要用 DSH 运行时。

### 日常三件套

```powershell
node scripts/check-project.mjs .      # 项目自己声明的规则：断链、locale、契约漂移、卡片完整性…
node scripts/try-checks.mjs           # 规则引擎的回归（正例 + 反例）
node scripts/list-errors.mjs          # errors/ 里有哪些卡片，按系统原文反查
```

`check-project.mjs` 读项目根的 `checks.json`；`--only <id>` 只跑一条。**判据是全部 exit 0**，不是「我改的那个文件没报错」。

### 全部回归

```powershell
node scripts/try-checks.mjs      # 规则引擎与项目检查
node scripts/try-generate.mjs    # 模板引擎：四种组合生成并自检
node scripts/try-audit.mjs       # 规范化已有插件的审计
node scripts/try-adopt.mjs       # adopt 的检查与改写
node scripts/try-tool.mjs        # 桩上下文上挂载全部工具 + 安装守卫
node scripts/try-sandbox.mjs     # 沙盒引擎，用假启动器
node scripts/try-ui.mjs          # CDP 客户端与无头浏览器
node scripts/try-market.mjs      # 市场条目生成与校验
node scripts/try-release.mjs     # 就绪检查、打包、发布、演练
```

`try-tool.mjs` 同时是模板的回归：生成的 bundle 通不过自己的结构检查它就失败——一次破坏产物的模板改动，不用安装任何东西就能抓到。

### 要用宿主的三项

`check-patch.mjs` 用 DSH 同款 YAML 库解析 patch，并与 `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml` 比对（漏行、行序变化、plan-mode 段落被改、意外新增都会失败）。桌面版里那个文件在 `app.asar` 内，所以要用 DSH 的运行时跑：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $env:DSH_NODE_EXECUTABLE scripts\check-patch.mjs .
& $env:DSH_NODE_EXECUTABLE scripts\verify-workflow.mjs   # release.yml + 模板能否被 YAML 解析
```

`verify-workflow.mjs` 用同一个 YAML 库解析发版工作流与它的模板，并断言 `on.push.tags` 有 `v*`、`permissions.id-token` 是 `write`、有 concurrency group——**手写缩进把 workflow 弄坏时，在推 tag 之前就红**，而不是等 CI 里神秘失败。

改动用**隔离实例**验证，别用桌面端（流程见 `skills/dsh-plugin-sandbox`）：

```powershell
$env:DSH_HOME = "<这个检出>\tmp\iso-home"   # 复用，不要每次重建
dsh --profile iso-creator --host 127.0.0.1 --port 3099 --no-open
```

`tmp/` 已被 git 忽略，但**不要提交**。

## 内容归属：先问「这是哪一类」

这是本仓库最容易搞错的地方。**写东西之前先确定它属于哪一类**，放错目录比写错内容更难发现。

| 你手上的东西 | 放哪儿 | 判据 |
|---|---|---|
| **流程 / 规范 / 约定**：怎么发版、怎么提交、目录该怎么排 | `docs/` | 回答「应该怎么做」。没有故障现象 |
| **错误 / 踩过的坑**：做错了什么、系统原话是什么、怎么修 | `errors/` | 回答「做错了什么」。**必须能写出 `matches`（系统报错原文，英文）** |
| **运行期事故**：端口被占、桌面端被顶掉、面板不渲染 | `skills/*/references/incidents.md` | 静态扫不出来，只能按现象反查 |
| **某个角色该怎么想**：问什么、定什么、什么算验证过 | `skills/<name>/SKILL.md` | 是判断，不是机械步骤 |
| **可判定的规则** | `lib/rules.js` + `lib/rule-types.js` + `checks.json` | 能扫源码或文件给出 pass/fail |
| **一个工具** | `lib/<domain>.js` + `tools/index.js` 注册 | 有明确输入输出，确定性 |
| **生成物的形状** | `templates/bundle/` + `recipe.json` | 由生成器渲染，不手改产物 |
| **回归用例** | `scripts/try-*.mjs` | 反例必须先红后绿 |

**判断标准一句话**：能不能写出 `matches`（系统报错原文）？能 → `errors/`；不能但它是「应该怎么做」→ `docs/`。

### 一个真实的错例

`release-pipeline`（「发版只走 tag」）曾经被写进 `errors/release-pipeline.md`。它有检查、有原文片段，看起来完全合规——但它的内容是**流程**：发版应该怎么做。结果 `errors/` 里混进了一条没有「谁做错了什么」的条目。

现在已经改成：流程说明在 [`docs/RELEASE.md`](docs/RELEASE.md)，规则说明在 [`docs/CHECKS.md`](docs/CHECKS.md)，`errors/` 里只留真正的错误。规则本身（`release:pipeline`）保留——**检查和归档是两件事**：一条流程也可以有检查守着，它的说明不必是错误卡片。

## 目录契约

| 路径 | 是什么 | 谁是源 |
|---|---|---|
| `index.js` | 插件入口：读配置、拼 `host`、注册工具与 skill 提供者 | 源 |
| `cordis.patch.yml` | bundle patch：把本包插进部署的组合配置 | 源 |
| `lib/` | 引擎。每个文件一个域，纯逻辑，不依赖 DSH 运行时 | 源 |
| `lib/rule-types.js` | 规则类型清单：检查器与卡片校验共用 | 源 |
| `lib/errors-card.js` | `errors/` 卡片的解析与完整性校验 | 源 |
| `tools/index.js` | 工具定义与注册（`dsh_plugin_*`） | 源 |
| `skills/` | 3 个 skill：`dsh-plugin-new`、`dsh-plugin-sandbox`、`dsh-plugin-fix-error` | 源 |
| `templates/bundle/` | 生成插件包的模板 + `recipe.json` 方案 | 源 |
| `docs/contracts/tools.json` | 工具契约的**生成物** | `scripts/gen-tools-contract.mjs` |
| `templates/bundle/github-release.yml.tpl` | CI 工作流的**生成物** | `.github/workflows/release.yml` |
| `errors/` | 已知错误：卡片（六字段）+ 正文 | 源 |
| `checks.json` | 本仓库自己声明要一直成立的边界 | 源 |
| `scripts/try-*.mjs` | 回归套件，全部要 exit 0 | 源 |
| `scripts/gen-*.mjs` | 生成器，产物与它对账 | 源 |
| `market.json` | 市场条目的那一行声明 | 源 |
| `tmp/` | 临时文件，git 忽略，不发布 | 源（但别提交） |

**生成物不许手改。** 改了也会被 `contract-drift` 类规则判红，且下次生成就覆盖。改生成器或改源。

## 硬约束

1. **不引运行时依赖。** 插件在宿主装载闭包里解析模块，裸名依赖解析不到。框架一律 `@deepseek-ai/*`；第三方真要用就写进 `package.json` 的 `dependencies`。
2. **访问 `ctx.<service>` 必须先在 `export const inject` 里声明。** 没声明的会被 Proxy 拒绝；声明了却不碰的会让插件永远等它（`templates:variants` 规则会查）。
3. **交给会话的消息必须是完整 `UserMessage`。** 用 `createUserMessage` 等构造函数，它们内部补 `randomUUID()`。手写字面量在写入时不报错，在用户下次打开会话时炸掉整个历史。
4. **自定义持久事件必须先 augment `SessionEventMap`**，否则 `session.append` 拒绝未知类型。
5. **`package.json` 的 `dsh` 字段只写宿主认的键**：`bundle` / `client` / `profile`。自造字段（如 `manifestVersion`）宿主完全不读，只会误导下一个人。
6. **发版只走 tag，且不存 npm token。** 改 `package.json` 版本 → 提交 → `git tag vX.Y.Z` → `git push origin vX.Y.Z`，其余交给 CI。publish 凭据由 OIDC 现场换（trusted publishing），仓库里没有长期密钥；要一次性在 npm 上配 Trusted Publisher，workflow 文件名绑在那里，改名要同步改。不要手打 `npm publish`（没有 provenance），不要手建 Release。
7. **`errors/` 自己不被扫。** 卡片正文里写着反例，规则和检查必须跳过这个目录，否则文档会把自己报成错误。加新规则时保留这条豁免。
8. **新检查必须先红后绿。** 在 `scripts/try-checks.mjs` 里加一个反例，**确认它报红**，再让它变绿。规则通过但反例不红，等于没有检查。
9. **一个错误一条检查。** 写不出一套正例/反例的「注意事项」，是没想清楚，不是检查难写。
10. **工具返回的话要说人话。** 每条 finding 带 `file:line` 和一句能照着改的话；不报「检查失败」然后让人自己找。

## 加一个新能力（顺序不能反）

1. **先确定归属**：按上面的表，这是流程、错误、判断、规则、工具，还是模板？放错类别后面全是返工。
2. **再写判据**：规则类型 → `lib/rule-types.js` 登记 → `lib/rules.js` 加 case。判据要能说清「什么情况报红」。
3. **再写用例**：`scripts/try-checks.mjs` 加正例 + 反例，**反例先红一次**。
4. **再写文档**：`docs/CHECKS.md`（规则）、`docs/<DOMAIN>.md`（能力）、`errors/`（如果这次踩了坑）。
5. **最后登记**：`checks.json` 引用规则；需要随包发的文件进 `package.json` 的 `files`。

先写文档再写检查，最后一定是文档在描述一个不存在的东西。

## 提交前

```powershell
node scripts/check-project.mjs .    # 必须 0 fail
# 全部 try-*.mjs，必须全 exit 0
```

- 改 `checks.json` 或规则 → 跑全量，别只跑自己那条。
- 改模板 → `try-generate.mjs`（四种组合生成并自检）。
- 改 docs → `docs:links` 会查相对链接，**这是本仓库最高频的回归**。
- 加 `errors/` 条目 → 先 `list-errors.mjs` 看有没有重复。
- 改 persona / skill → 先读 `docs/PHILOSOPHY.md`：哪些判断归引擎、哪些归 skill。

用户文档（`README.md`、`docs/`）面向使用者，写「是什么、怎么用」；**不要往里写「改代码时要怎样」**——那是这份文件的事。

## 不要做

- 不要在 `errors/` 里放流程、规范、最佳实践——那是 `docs/`。
- 不要往 `README.md` 里写开发流程、命令清单、改代码须知——那是这份文件的事。
- 不要手改生成物（契约文件、模板产物、market 条目 YAML）。
- 不要为了「更规范」引入依赖或新机制；顺着现有写法改。
- 不要把判断写进工具：工具只做确定性的事，需要判断的写进 skill。
- 不要把「工具能跑通」当成「验证过」；`docs/RELEASE.md` 里那条判据永远有效——**看产物，不看提示**。
- 不要动用户的桌面端和正在跑的环境；要测就起沙盒（`dsh-plugin-sandbox`）。