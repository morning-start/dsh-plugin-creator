# dsh-plugin-creator

一个给 DeepSeek Harness（DSH）用的插件开发增强包。装上它只扩展 **创造模式**（`cordis` 预设），别的一概不动；卸载时把它加的东西全部带走。

## 这是什么

一个面向 agent 时代的 DSH 插件脚手架工具箱。一个插件的生命周期是 **构思 → 项目启动 → 规范化开发与检查 → 功能测试 → 集成测试 → 发版**；这个包让其中机械的部分稳定、快，把判断留给 skill 和对话。

诚实地说现状：**项目启动**、**规范化检查**、**功能测试**、**客户端 UI 检查**、**发版检查** 都已经成形；**构思**（把需求变成一个插件形态）还只是对话。这份差距清单是刻意的——它就是路线图。

第一条设计原则：**创造模式自带的工具是这个插件的地基。** 加东西之前，先看这个预设已经装了什么（`dsh --profile <p> --dump-config`、`cordis_inspect_*`），而不是重新实现一遍。安装与启用是 `plugin_manager` 的事；运行时的真相来自 Inspect，不是读源码；凡是判断，都属于 skill。完整论述——六段能力表及其缺口、32 个出厂插件按「对本设计意味着什么」的分组、四条设计原则——在 [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md)。

## 它给你什么

讲能力，不讲功能清单。哪个工具实现了哪条能力——参数、动作、边界——在 [docs/TOOLS.md](docs/TOOLS.md)。

**从标准模板起一个插件。** 一次调用产出清单、bundle patch、入口模块、多语言字典、图标、README，按需附带示例工具和 skill。确定性：同样的输入永远产出同样的文件。返回之前它会先自检，所以结构报告和插件在同一轮里到齐。

**知道一个包为什么装不上、显示不出来。** 只读的结构检查把所有问题一次报完，而不是遇到第一个就抛：清单字段、声明的 bundle patch、导出的 locale 与图标资源、入口模块、声明的详情文档、打包白名单。每项给 pass / warn / fail。

**交付一个不夹带你私人信息、并且敢说自己能干什么的包。** 同一个检查会找作者自己的账号路径与凭据形态——私钥、API token、家目录——发现就 fail；而示例里的占位账号保持安静。它拒绝安装期钩子和动态代码求值，并打印插件的**能力清单**：哪些文件会跑命令、开连接、写文件、读环境。最后这条是报告不是判决，因为「不会搞坏任何东西」无法用静态检查证明——但一个插件**能做什么**可以列出来，审阅的人应该看得到。

**把项目自己的边界写成规则。** 项目根的 `checks.json` 声明什么必须一直成立——相对文档链接可解析、多语言文件 key 一致、分层源码树不向外 import、不在内层碰宿主模块、不该打日志的地方没有 console。引擎跑完逐条报告，每句都能照着改。边界属于项目，不属于工具。见 [docs/CHECKS.md](docs/CHECKS.md)。

**让开发中的插件进不了你在用的环境。** 从本地目录安装会被拒绝，只有三种有意的例外：已发布的版本、本身就是一个沙盒的宿主、或者用户明确决定。风险是不对称的——沙盒里一个坏 patch 的代价是一次重启，同样的 patch 落在工作 profile 上，代价是一个起不来的宿主。所以这是守卫，不是建议。

**在沙盒里测插件，而不是在桌面端。** 一个项目可以有多个隔离实例——日常迭代、干净复现、客户端 UI 状态、回滚演练——每个有自己的 home、profile、端口、工作区副本。它们被复用而不是重建，带一个标记，使一个项目的沙盒不会被另一个项目误接管；可以启动、按 HTTP 探活、灌入真实数据、停掉，全程不碰用户正在跑的东西。

**看见页面，并对它断言。** 用无头浏览器经 DevTools 协议打沙盒：真实截图，对选择器、文案、表达式、console 报错断言，真实点击与输入——不是合成的 `element.click()`，React 输入框和 contenteditable 会忽略那种。会话 token 从沙盒自己的日志里取，不用谁去 URL 里翻。截图证明渲染成什么样，断言证明什么必须成立，两者都不能代替人判断观感。见 [docs/UI.md](docs/UI.md)。

**从模板生成任何结构化内容。** 插件脚手架只是一条通用能力的一个实例：一个**方案**是数据（变量、文件映射、条件、规则）加模板，所以新方案是一个目录，而不是一个新生成器。见 [docs/SCHEMES.md](docs/SCHEMES.md)。

**发一个你已经装过一次的版。** 就绪检查去问打包器**真实**会装进 tarball 的东西——不是 `files` 声称的——并拿包的 `engines.dsh` 和运行中的 DSH 比对，于是版本不匹配在安装前就被发现，而不是安装时。演练随后打包、装进沙盒、把组合后的配置读回来，顺手给你回滚命令。发布仍然是人的决定：工具只报「能不能发、该跑什么」。见 [docs/RELEASE.md](docs/RELEASE.md)。

**判断放在该放的地方。** 两个 skill 承载工具不该编码的东西：生成插件前该问什么，以及怎么测一个插件而不产出假证据。

一切都挂在创造模式预设里，所以标准、PTC、极简、数据分析会话看不到任何新增。

## 方案：模板 + 配置 + 命令

生成插件是一条通用能力的实例，所以就这么建。一个**方案**是一个目录：`recipe.json`（变量、文件映射、条件、规则）、它的模板（每个变体一个文件），以及——只在需要计算时才有的——一小段 `derive` 钩子：

```
templates/bundle/
  recipe.json          变量、文件、when 条件、规则、警告
  *.tpl                每个变体一个文件；永远不当作代码求值
lib/generate.js        通用引擎：变量 → 文件 → 规则
lib/rules.js           声明式结构检查
lib/scaffold.js        bundle 方案：derive 钩子 + 深度 bundle 检查
```

引擎对「插件」一无所知。这正是「新方案是一个目录而不是一个新生成器」的由来：描述变量、映射文件、声明不变量，已有的入口原样驱动它。

三条性质是**强制**而不是写在文档里，因为正是它们决定生成器可不可信：

- **选择，不是条件分支** —— 一个变体就是一个不同的模板文件，由 `when` 子句挑；模板保持可读的文本，选择逻辑集中在一处可见。
- **未解析的占位符是致命错误** —— 剩下一个 `{{token}}` 意味着 recipe 和模板不一致；失败好过发出去半个文件。
- **规则跑在产物上** —— `placeholder-free`、`files-listed`（每个生成的文件都必须在 `package.json` 的 `files` 里）、`json-field`、`frontmatter-name`。bundle 自己的规则已经抓到过一个真 bug：`.gitignore` 和 `.gitattributes` 被生成出来，却没标成本地文件，于是显示为「未被打包覆盖」。

JSON 也由模板渲染，用 `{{name|json}}` 转义，于是「生成什么」只有一个真相来源。

完整格式——每个变量字段、`when` 语法、规则类型、怎么加一个方案——见 [docs/SCHEMES.md](docs/SCHEMES.md)。

## 为什么分层，而不是一个入口

填模板是确定性的字符串工作；访谈用户是判断。把两者混在一起，正是模板生成器不可靠的原因，所以这里每条能力都按同一个形状建：

- **引擎**（`lib/`）—— 纯粹、无依赖、可测，不知道插件是什么；
- **方案**（`templates/`）—— 把结构当数据：变量、文件映射、条件、规则；
- **两个前台** —— 面向 agent 的工具和面向人的 CLI，共用同一个引擎，谁都不用重写一遍；
- **一个 skill** —— 引擎不该编码的判断：问什么、定什么、什么算验证过。

工具前台不是装饰：它让自动化在这个仓库之外也成立（项目根来自会话，不来自本包），也让它不依赖 PATH（启动器从宿主可执行文件推导）。沙盒是同一个形状少一层——它不渲染文件，加模板层只是仪式。

选择而不是模板逻辑：模板目录每个变体一个文件（`index.js.tpl` 与 `index.min.js.tpl`，`cordis.patch.yml.tpl` 与 `cordis.patch.skill.yml.tpl`），引擎挑文件。渲染后仍有未解析的 `{{占位符}}` 就是错误，模板里的笔误因此大声失败，而不是发出去。

故意**没有**做 DSH 斜杠命令（`/new-plugin`）：`commands.register` 是存在的，做起来也便宜，但命令只收到一行 `rawInput`，而这里的字段需要对话——命令要么强迫你写 `name=... title=...`，要么只是注入一段提示，而后者跟直接跟 agent 说话没区别。

### 生成一个

在创造模式里跟 agent 说要一个插件，它会先访谈你；或者从计划文件直接驱动引擎。调用方式、字段、参数在 [docs/TOOLS.md](docs/TOOLS.md)。

生成出来的 bundle 的 patch 只插入一行 Host 行，不覆写任何预设，所以装上它不改变任何已有预设的组合。它的 README 记录了把工具或 skill 限定到单个预设的两种写法。

## 沙盒

测插件意味着跑一个**不是用户桌面端**的 `dsh web` 实例。这个包提供让这件事可重复的登记表：

```
<项目>/tmp/sandboxes/
  registry.json            name → home / workspace / profile / port
  default/
    sandbox.json           标记：这个文件夹属于哪个项目、哪个沙盒
    home/                  沙盒的 DSH_HOME
    workspace/             会话实际运行的工作区副本
    open.log               `open --run` 的输出；URL 从这里读
```

一个项目想放多少沙盒就放多少——`default` 日常迭代、`clean` 从零复现、`client` 看 UI 状态、`rollback` 演练回滚。它们全部**复用**，从不隐式重建：pnpm 安装、profile 里的插件版本、模型凭据都在沙盒 home 里。

沙盒放在项目自己的 `tmp/` 下，绝不在 `~/.dsh` 或系统临时目录，所以它跟着项目走、跟着项目消失。`sandbox.json` 是身份检查：它的 `project` 必须是这个项目的根，任何操作都拒绝标记不符的文件夹——被复制的沙盒不会被另一个项目误接管。端口在项目登记表内唯一，所以两个停掉的沙盒不会抢同一个端口。页面上的工作区标题读作 `sandbox <项目>/<沙盒>`，这是区分多个运行中沙盒的办法。

三条行为来自一个插件 UI 项目上的真实事故：

- **端口不是身份。** 启动时记下真正监听的 pid，停止时只杀那个 pid——占着端口的陌生进程会被报告并放过。曾经「谁占端口就杀谁」，把用户的桌面端一起杀了。
- **契约检查带着会话 token。** 请求路由时用沙盒从自己日志里解析出的 token，于是 401 / 400 / 404 / 405 不用去页面 URL 里翻 token 就能查；返回的任何内容里 token 都被脱敏。
- **灌数据胜过空 home。** 隔离的 home 是空的，于是每个面板都显示空状态，最有意思的渲染永远没被跑过；可以从真实的 `~/.dsh` 里只读地复制具名条目进来。模型凭据也可以复制，并且结果会说明——借来的凭据不算验证过的凭据。

**模型凭据留在用户手里。** 沙盒启动时 `.credentials.yaml` 里只有一条浏览器会话记录，于是页面显示「请选择模型」，发不出消息。用户在 Settings → Models 里加一次，它落在这个沙盒的 home 里，之后每次运行都复用——没有任何脚本去搬用户的凭据。登记表按记录名报告 `model: yes / no`，因为在这个 DSH 版本里这个文件从不为空（没有模型时也有约 160 字节的骨架）。

命令、动作、参数见 [docs/TOOLS.md](docs/TOOLS.md)。

## 开发中的插件永远不会落进当前环境

本地 bundle 的安装会被拒绝——不管是通过 Plugin Manager 还是 shell 里的 `dsh plugin … add` 带路径或 `link:`——只有三种有意的例外：registry 形式（`name@version`），因为发布才是正规的交付方式；**本身是沙盒**的宿主（`DSH_HOME` 位于带 `sandbox.json` 的文件夹下，或在 `tmp/sandboxes/` 下），那里安装正是目的；以及用户的明确决定，表现为重启前在宿主上设 `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`。

理由是不对称风险：沙盒里一个坏 patch 的代价是一次重启，而在用户真正工作的 profile 里，同样的 patch 意味着一个带着坏组合启动的宿主。做成守卫而不是 skill 里的一条规则，因为规则是建议，模型在压力下可以跳过。

说清边界：它不覆盖用户在自己终端里手敲 `dsh plugin add`，它也不是安全边界——它是防误撞的刹车。确切的匹配逻辑在 [docs/TOOLS.md](docs/TOOLS.md)。

## 「只在创造模式」是怎么实现的

bundle patch（`cordis.patch.yml`）覆写出厂的 `preset-cordis` 行，并在它的插件列表末尾追加两行：

- `creator-tools` → `dsh-plugin-creator/tools`，在这个预设的上下文里注册工具；
- `creator-skills` → 第二个 `@deepseek-ai/dsh-skill-filesystem` 提供者，`includeDefaultRoots: false`，`customSkillDirs` 指向本包的 `skills/` 目录。

patch 还插入一行 Host 行 `creator-host`，它今天不注册任何东西，存在的意义是让这个 bundle 在 Plugin Manager 里有一个稳定的身份行。

卸载会移除整个 patch 层，于是 `preset-cordis` 回落到 `@deepseek-ai/dsh-web-app` 里出厂的声明，工具和 skill 一并消失。其他预设既没有被 patch，也没有被复述。

### 这个做法的代价，说清楚

patch 会**整体替换**一行的 `config`——补丁从不深合并，而预设的 `plugins` 就在 `config` 里。DSH 没有「往已有预设里追加」的机制。所以这次覆写必须把出厂的插件列表整段复述，在 patch 文件里标在 `# --- shipped preset-cordis ---` 与 `# --- end shipped ---` 之间。

后果：**升级 DSH 之后要重新复制那一段**，来自 `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`（当前这段复制自 DSH 0.2.2-rc.5）。如果新版 DSH 给创造模式加了一行，这个 bundle 会把它盖住。给这段做生成/检查脚本是路线图上的下一项。

还有一个后果值得知道：如果用户之后在 Web UI 的预设编辑器里改了创造模式，那个编辑器会往 profile patch 里写它自己的一整份覆写，优先级高于本 bundle 的层。工具和 skill 会消失，直到用户重新加回去或删掉那份 profile 覆写。

## 结构

```
package.json          bundle 清单：exports、files、dsh.bundle.patch
cordis.patch.yml      patch 层：Host 行 + 创造模式预设覆写
index.js              Host 半边（今天不注册东西；将来放共享服务）
tools/index.js        预设作用域半边：工具与安装守卫
lib/bundle-check.js   结构检查器（隐私与安全两组也在里面）
lib/generate.js       通用模板引擎（recipe → 文件 → 规则）
lib/rules.js          声明式结构检查
lib/scaffold.js       bundle 方案（derive 钩子 + 深度检查）
lib/sandbox.js        沙盒引擎（工具与 CLI 共用）
lib/ui.js             CDP 客户端与无头浏览器（工具与 CLI 共用）
lib/checks.js         项目规则加载与执行
lib/release.js        发版就绪检查、打包、演练
templates/bundle/     bundle 方案：recipe.json + 每个变体一个模板
skills/               挂进创造模式的 skill
locale/{en,zh}.json   Plugin Manager 的标题 / 说明 / 详情路径
docs/                 设计文档（哲学、方案、工具、检查、UI、发版）+ 详情页
icon.svg              插件图标
scripts/              CLI 与回归检查
```

## 安装

这个 bundle 本身就是一个开发中的检出，所以它遵守自己定的规则：先装进沙盒，等你决定了再装进你工作的 profile——见上面的守卫。

从这个检出安装，用 Plugin Manager（推荐，它同时处理 bundle 选择）：

```
plugin_manager  action: install_bundle  target: <这个检出的路径>
```

或者在 profile 的 shell 里：

```
dsh plugin --profile desktop add link:<这个检出>
```

本地目录安装是把检出链接进去，所以 `tools/` 和 `skills/` 下的改动不用重装就能生效——但改过的模块仍需重启才能加载新的模块代际，而 skill 的改动由 skill 提供者实时拾取。

## 验证

1. `dsh --profile desktop --dump-config` 里能看到 `creator-host` 行，以及一个插件列表以 `creator-tools`、`creator-skills` 结尾的 `preset-cordis`。
2. **新开**一个创造模式会话，工具列表里有本包的工具，skill 列表里有 `dsh-plugin-new`、`dsh-plugin-sandbox`。
3. 新开一个标准模式会话，一个都没有。
4. 对本仓库跑结构检查，报告 `ok: true`。

已有会话保留它创建时的组合；预设是在会话创建时解析的。

## 开发

纯 ESM，**无依赖、无构建步骤**，这是刻意的：预设行从 profile 解析自己的 import，所以 `@deepseek-ai/*` 那套编写辅助（`defineTool`、schemastery）在这里 import 不到。工具因此写成裸 JSON Schema 定义。

不需要宿主就能跑的检查：

```powershell
node scripts/try-tool.mjs .        # 在桩上下文上挂载全部工具 + 守卫
node scripts/try-sandbox.mjs       # 沙盒引擎，用假 dsh 启动器
node scripts/check-patch.mjs .     # 解析 cordis.patch.yml 并与出厂预设比对
```

`try-tool.mjs` 是模板的回归测试：生成的 bundle 通不过自己的结构检查它就失败，所以一次破坏产物的模板改动不用安装任何东西就能被抓到。`try-sandbox.mjs` 用假启动器驱动 create / start / status / stop——不引导任何 profile，也不占用真实端口——覆盖归属标记、端口唯一、工作区改写、凭据记录扫描。

`check-patch.mjs` 用 DSH 同款 YAML 库解析 patch，并与 `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml` 比对：漏行、行序变化、plan-mode 段落被改、意外新增，都会失败。在桌面版安装里那个文件位于 `app.asar` 内，所以要用 DSH 的运行时跑，而不是 `node`：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $env:DSH_NODE_EXECUTABLE scripts\check-patch.mjs .
```

改动用隔离实例验证，别用桌面端；本包附带的 `dsh-plugin-isolated-test` skill 就是流程，简版是：

```powershell
$env:DSH_HOME = "<这个检出>\tmp\iso-home"   # 复用这个 home；不要每次运行重建
dsh --profile iso-creator --host 127.0.0.1 --port 3099 --no-open
```

`tmp/` 已被 git 忽略。

## 路线图

按 [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) §1 的生命周期缺口排序。

**规范化开发与检查**

- 已完成：项目声明式规则（`checks.json`）覆盖文档断链、多语言对齐、分层依赖方向、console 卫生、契约漂移——生成物与它的生成器比对，`--update` 重新生成。生成的插件包自带一份起手 `checks.json`，并且在它自己生成的包上就能通过。
- 待补：结构检查再覆盖 patch 的 YAML 语法（需要解析器）、预设声明、skill frontmatter。

**集成测试**

- 已完成：CDP 驱动的截图、断言、真实点击与输入，对着沙盒页面跑；创造模式确实多出工具与 skill 已在真实会话里确认。
- 待补：通过 Inspect 断言 slot 注册与主题 token，让「那个 tab 在」在宿主侧也被检查，而不只在 DOM 里。

**发版**

- 已完成：按打包器真实包面与 `engines.dsh` 的就绪检查，加上装 tarball、读回组合配置的沙盒演练。
- 待补：让模板直接产出 `engines.dsh`（生成时就知道运行版本），这样不兼容的安装在激活前就被 DSH 拒绝，而不是激活后。

**基础设施**

- `scripts/sync-preset.mjs`：从已安装的 DSH 重新生成出厂 `preset-cordis` 段落，而不是手工再复制一遍。
- 模板变体：带客户端半边的 bundle（slot 注册），以及自带预设声明的纯预设 bundle。
- 可选的 `/new-plugin` 斜杠命令，复用同一个引擎——前提是确认 `/` 菜单在目标宿主里能渲染。

## 来源

`skills/dsh-plugin-sandbox/` 起初是用户本地 skill `~/.dsh/skills/dsh-plugin-isolated-test` 的副本，后来按沙盒模型改名并重构（一个项目多个沙盒、复用、把模型配置交给用户）。它的 `references/` 仍早于那次改名——里面写「隔离实例」或 `iso-home` 的地方，读作「沙盒」。`~/.dsh/skills/` 下的原件没有动。
