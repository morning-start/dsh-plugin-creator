---
name: dsh-plugin-sandbox
description: "插件沙盒测试：用 dsh web（不是桌面端）在沙盒里创建、测试、debug、发布一个 DSH 插件，全程不干扰用户正在用的桌面端和其它实例。一个插件项目可以有多个沙盒（干净复现、带模型、验客户端 UI…），每个沙盒有独立 DSH_HOME、profile、端口、工作区副本，并且长期复用；需要模型能力时，把打开沙盒的命令交给用户，让他自己在页面里加一次模型。当你要「测插件」「验证插件装没装上/生效没」「在 web 实例里点一遍」「面板/客户端渲染怎么验」「debug dsh web 起不来/入口不见/401/403」「用 dsh profile 装、换、覆盖、回滚」「发版前跑一遍验收」时就用它；只要任务涉及\"在真实宿主里验证一个 DSH 插件\"或\"dsh web 出问题\"，即使没提\"沙盒\"也应该用它。"
---

# 插件沙盒测试

**默认测试对象是 `dsh web`**——桌面端是用户的东西，不归你测、也不许你去碰。

**沙盒**是这个技能的基本单位：一组隔离的运行环境，包含 `DSH_HOME`、profile、端口、工作区副本。
每个沙盒四件事都独立：既不抢会话，也不抢写者租约，更不会把桌面端顶掉。

**一个项目可以有多个沙盒，而且全部长期复用。** 常见分法：

| 沙盒 | 用途 |
|---|---|
| `default` | 日常迭代：插件装好、模型配好，改完源码直接开 |
| `clean` | 干净复现：怀疑 default 被搞脏了，或要演示「全新安装」 |
| `client` | 验客户端 UI：不同的窗口尺寸/主题/已登录态 |
| `rollback` | 回滚演练：装新版→回滚→装回，先在这儿跑 |

**复用是默认，重建是例外。** 最贵的几样东西都在沙盒 home 里：`dsh plugin add` 的 pnpm 安装
（几百毫秒到几十秒，还要跨盘 store）、**用户手动加过的模型凭据**、profile 里的插件版本、已登录态。
每次 `rm -rf` 会把它们一起清掉——表现为「上次还能跑 agent，这次发不出消息」，而这看起来像插件坏了。
详见 `references/incidents.md` 第 15 条。

**模型能力由用户提供，不由脚本搬运。** 沙盒的 `.credentials.yaml` 默认是空的；需要模型时，
你**不要**去复制用户的凭据，而是把打开沙盒的命令交给用户，让他自己在页面里加一次模型。
加一次就写进这个沙盒的 home，之后一直复用（见 §3.3）。

配套资料（按需读，不要一次全读）。注意：references 里的「隔离实例」「`iso-home`」就是本文的「沙盒」「沙盒 home」，那是改名前的写法，事实仍然成立：

| 文件 | 什么时候读 |
|---|---|
| `references/dsh-profile-cli.md` | 要查 `dsh` / `dsh plugin` / profile 的具体用法与输出含义 |
| `references/debug-dsh-web.md` | 实例起不来、页面 401/403、路由没反应、数据不对、写不进去 |
| `references/incidents.md` | 想快速知道"这种症状以前是什么原因"（本项目真实复盘） |

## 0. 环境地图（不清楚这四个边界，后面所有现象都不可解释）

| 边界 | 落在哪 | 共用会怎样 |
|---|---|---|
| `DSH_HOME` | 会话、`storages/`、`.credentials.yaml`、`profiles/`、`logs/`、`skills/`，以及插件自己的数据（如 `$DSH_HOME/myteam`） | 抢会话、抢写者锁、把桌面端顶掉 |
| profile | `$DSH_HOME/profiles/<name>`：`package.json` 的 `dsh.profile.bundles`（有序）+ `node_modules`（只放 profile 装的包） | 插件装在 A、你看的是 B → "装了没生效" |
| 端口 | 每个实例自己绑 | `EADDRINUSE`；也可能让页面"起了一半" |
| 工作区 | 会话 cwd；插件的项目数据在 `<cwd>/.dsh-*` | 两个实例同写一个项目 → `WRITER_LEASE_LOST` |

> **`DSH_HOME` 不隔离工作区。** 这是最容易漏的一条：沙盒 home 新建时宿主会自动登记一个默认工作区，
> 路径是 `C:\Users\<user>\Documents\deepseek-harness\default-workspace` —— **用户的真实目录**。
> 不改它，你的"沙盒"就在用户的项目上跑（本项目实测：读到用户那份 `schemaVersion: 1` 的旧数据，
> 每栏都显示「未初始化」）。起实例前改 `<沙盒 home>\storages\workspace.json` 里的 `workspaces[*].path`
> 指向沙盒副本，见 §3.2 与 `incidents.md` 第 19 条。

三个环境变量决定你手上这个 shell 属于谁：`DSH_HOME`（根）、`DSH_PROFILE` / `DSH_PROFILE_DIR`（**只在由 profile 启动的 shell 里存在**）。
`DSH_INSTALL_DIR` 是 CLI 包目录（文档在 `$DSH_INSTALL_DIR/docs/user`），`DSH_NODE_EXECUTABLE` 是运行时 Electron（读 asar 才需要它）。

## 1. 六条铁律

1. **绝不启动桌面端二进制**：`DeepSeek Harness.exe … dsh-desktop-host/lib/cli.js`。那是桌面端自己的宿主，
   单实例语义——第二个会把第一个顶掉（真实事故：`exited with 4294967295` 连崩三次）。要起实例只用 `dsh --profile <p>`。
2. **不手改 profile 文件**（`package.json` / `cordis.patch.yml`）：装、卸、覆盖都用 `dsh plugin` 与 `--patch`。
3. **不为截图去换 HOME / 找 token / 翻浏览器 profile**。浏览器控制不可用时，视觉部分如实写"未验证"。
4. **只停自己的东西**：按端口/PID 停；不按进程名批量杀，不碰不认识的进程。
5. **测试数据落在沙盒 home 或工作区副本**：写真实项目/真实全局库之前先问自己"能不能拷一份"。
6. **沙盒复用，别每次重建**：沙盒名写进命令或脚本常量，跑第二遍时**保留**它。
   只有症状要求"从零开始"（怀疑沙盒被上次污染）才重建，并且重建前想清楚会丢掉什么（见 §3.4）。

### 1.1 开发中的插件**不许**装进当前环境

这是硬规则，不是建议。**开发中的插件 = 从本地目录装的包**（`plugin_manager install_bundle` 的 target 是目录、
`link:` 或 `file:`；或 `dsh plugin add link:...`）。它只许进沙盒：

- 当前环境崩在插件上是**你自己修的坑**：一个坏 patch 会让宿主带伤启动，用户下次开会话就撞上；
- 沙盒里同样的失败只花掉一次重启。

`dsh-plugin-powerful` 自带的 guard 会**直接拒绝**这两种调用（`plugin_manager` 的 `install_bundle` 本地 target、
`pwsh`/`bash`/`terminal` 里的 `dsh plugin … add link:` 或本地路径），除非：

- 这个宿主**本身就是沙盒**（`DSH_HOME` 指向带 `sandbox.json` 标记的沙盒，或路径在 `tmp/sandboxes/` 下）——沙盒里随便装；
- 或者用户**明确要求**装进当前环境，并且自己设了 `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`。

被拒之后**不要**去找绕过办法（换工具、拆命令、改路径写法）：去问用户，或者改用沙盒。
装到当前环境的正当路径只有两条：**发布后按版本号装**，或者**用户自己拍板并开了开关**。

## 2. dsh / profile 速查

```powershell
dsh --help                     # 启动器：--profile/--patch/--from-default-profile/--dump-config…
dsh web --help                 # web app：--host/--port/--no-open/--public-url/--trusted-host/--tls-*
dsh --profile web --dump-config          # 组合后的插件树（"装没装上"的第一手证据）
dsh --profile web --dump-default-config  # 去掉 user layer 与 patch，用来对比
dsh plugin --profile web list            # 这个 profile 装了哪些包
dsh plugin --profile web add link:E:/abs/path/plugin
dsh plugin --profile web remove dsh-plugin-myteam
dsh headless "跑一次任务"       # 不需要 UI 时验 host 侧
dsh rescue --from-default-profile web    # 把玩坏的 profile 从出货模板重建
```

判据与坑（完整版见 `references/dsh-profile-cli.md`）：

- `dependencies` 里有你的包 **但 `bundles` 里没有** → 等于没装（不会挂载）。
- 上游 bundle 写了 `disabled: true` → 你的 patch 必须显式 `disabled: false`。
- `--patch` 只贡献配置，**不改 loader 解析模块路径的基准**（profile 目录）→ 插件路径写绝对路径。
- `link:` 安装**不跑 `prepack`**：有 `src → lib` 构建的包，装完还要 `node scripts/build-lib.mjs`，否则宿主跑旧代码。
- `dsh plugin add` 输出 `+ 包 版本 <- 路径` 即成功；`Already up to date` 不是失败；跨盘 pnpm store 警告可忽略。

## 3. 沙盒：建一次 → 一直复用 → 停止

### 3.0 沙盒长什么样

沙盒**永远在项目自己的 `tmp/` 里**，不放到 `~/.dsh`、也不放到系统临时目录。这样它跟着项目走，
不会被别的项目拿去用，删项目就一起没了：

```
<项目>/tmp/sandboxes/
  registry.json          登记表：名字 → home / 工作区 / profile / 端口
  default/
    sandbox.json         标记：属于哪个项目、哪个沙盒、什么端口（可以跟着文件夹一起被拷走）
    home/                DSH_HOME（storages、profiles、sessions、.credentials.yaml 都在这）
    workspace/           会话真正跑的地方（工作区副本）
    open.log             `open --run` 的输出，URL 从这里读
  clean/  client/  …     每个沙盒一个文件夹，名字就是它的身份
```

**标记是硬约束，不是注释。** `sandbox.json` 里的 `project` 必须等于当前项目根目录：

- 标记缺失或指向别的项目 → **拒绝操作**（`open` / `status` / `stop` / `remove` 都会报错并说清原因）；
- 这就是「避免其他项目用」的落点：把沙盒文件夹拷到别处、或者从别的项目里指过来，都会被拦下；
- 页面里那个工作区的标题也会写成 `sandbox <项目名>/<沙盒名>`，多开时一眼看出你在哪个沙盒。

**端口不是身份。** 桌面端自己占着端口（实测 `3081`、`52332`），沙盒只用 `3100-3199` 且按项目内唯一分配。
`start` 会把真正监听的那个 pid 记进登记表，`stop` 只杀**记过的那一个**：
端口上坐着别的进程时它会**拒绝**并报出 pid，让你先查清楚——「按端口杀」曾经把用户的桌面端一起打掉过。
确实要强杀才用 `force`。

`tmp/` 是产物目录，不进 git。每个沙盒的名字、端口、profile 都由登记表管，不要靠记忆。
**端口按项目内唯一分配**（登记表里占用的端口会跳过），否则两个停着的沙盒会撞在同一个端口上。

有 `dsh_sandbox` 工具时（创造模式默认有，**任何项目都能用**，项目根取会话工作目录）优先用它：

| 调用 | 作用 |
|---|---|
| `dsh_sandbox { action: 'list' }` | 列出沙盒：端口、profile、有没有模型、标记有没有问题 |
| `dsh_sandbox { action: 'create', name: 'default', plugin: '<插件目录>' }` | 建沙盒、复制 profile、`link:` 装插件 |
| `dsh_sandbox { action: 'start', name: 'default' }` | **起实例并返回 URL**，你可以立刻去打 HTTP 探针 |
| `dsh_sandbox { action: 'open', name: 'default' }` | 只打印命令，给用户自己开（他要加模型时用这个） |
| `dsh_sandbox { action: 'status' / 'stop' / 'remove' }` | 探活 / 停 / 删（`remove` 要 `confirm: true`） |

`start` 与 `open` 的区别就是「谁按下去」：**`start` 你起、你探、然后把 URL 交给用户去加模型**；
`open` 是把命令交给用户，他自己在终端起。加模型这一步两种方式都一样要用户做，做一次就记住。

同一个引擎也有 CLI（`node scripts/sandbox.mjs …`），但那只在本仓库里有；别的项目用工具。
没有工具也没有脚本时，手工步骤在 §3.1 / §3.3，判据一样。

### 3.1 建沙盒（只在第一次）

```powershell
$sb  = "<repo>\tmp\sandboxes\default\home"          # 这个沙盒的固定 home，不要在脚本里 rm 它
$ws  = "<repo>\tmp\sandboxes\default\workspace"     # 工作区副本
New-Item -ItemType Directory -Force -Path $sb, $ws | Out-Null   # -Force 已存在也不清空
$env:DSH_HOME = $sb

dsh --profile sb-default --from-default-profile web --dump-config   # 从出货模板复制一份 profile
dsh plugin --profile sb-default add link:E:/abs/path/plugin         # 用 CLI 装
```

沙盒的 profile 名建议 `sb-<沙盒名>`，一眼能看出它属于哪个沙盒。

### 3.2 先把工作区指到副本（**别跳过这一步**）

沙盒 home 里宿主会自建一个默认工作区，指向用户的 `Documents\deepseek-harness\default-workspace`。
起实例前把它改到沙盒副本目录，否则后续所有会话都在**用户的真实项目**上跑：

```js
// 第一次起实例前、以及 workspace.json 存在时每次都做
const wsJsonPath = join(SB, 'storages', 'workspace.json')
if (existsSync(wsJsonPath)) {
  const parsed = JSON.parse(readFileSync(wsJsonPath, 'utf8'))
  for (const entry of Object.values(parsed.tables?.workspaces ?? {})) {
    entry.path = WS                    // <repo>/tmp/sandboxes/<名字>/workspace
    entry.title = 'sandbox-workspace'
  }
  writeFileSync(wsJsonPath, JSON.stringify(parsed, null, 2) + '\n')
}
```

- `WS` 推荐用**空目录**：插件打开时会自己 bootstrap 出新版 schema 的数据，
  这样验到的是真实空态；直接拷仓库里那份旧 `.dsh-myteam` 反而可能因为版本不匹配而整屏未初始化。
- 改的是**我们自己那份沙盒 home**，不动用户状态。
- 判据：界面上面板标题里的项目名应该是 `sandbox-workspace`，不是 `default-workspace`。
- 这条**常常改不到**：`workspace.json` 存在，但 `tables.workspaces` 是空的，条目要等**页面第一次连上**才写进去。
  所以顺序是：开沙盒 → 页面加载一次 → 再跑 
ode scripts/sandbox.mjs fix-workspace <名字>`，然后刷新页面。
- `scripts/sandbox.mjs` 每次 `open` 都会尝试这一步，改不到时会直接告诉你下一步跑什么。

### 3.3 打开沙盒：模型由用户自己加

这是**唯一需要用户动手的一步**，也是必须由你交给他的一步——模型凭据是用户的私密信息，不该由脚本搬运。

把下面两行原样交给用户，让他在**自己的终端**里跑：

```powershell
$env:DSH_HOME = "<沙盒 home>"
dsh --profile sb-default --host 127.0.0.1 --port 3100 --no-open
```

然后让他打开打印出来的 `?token=` 地址，在 **Settings → Models** 里加一次模型。
加完凭据就落在这个沙盒的 home 里，**以后每次 `open` 都复用，不用再加**。

- 用工具时：`dsh_sandbox { action: 'start' }` 由你起实例、拿到 URL，**加模型仍然让用户做**——
  把 URL 给他，说一句「在这里加一次模型，之后这个沙盒一直复用」；
  `dsh_sandbox { action: 'open' }` 则把两行命令打印出来交给用户，让他自己开。
- 沙盒的 `.credentials.yaml` 里**只有 `client-connection/browser-session`** 时，页面会显示「请选择模型」，
  消息发不出去、会话建不出来。**看记录名，不要看文件大小**（见 §3.7）。

### 3.4 复用：**之后每次都跳过建沙盒**

同一沙盒的迭代、改了源码，都**不要**再 `create`、不要 `rm -rf`、不要重新装：

```powershell
$env:DSH_HOME = "<沙盒 home>"
dsh --profile sb-default --host 127.0.0.1 --port 3100 --no-open     # 前台跑，能 Ctrl+C
# 打印：dsh web: http://127.0.0.1:3100/?token=…
```

改了源码要不要重装？取决于包形态：`link:` 是指向源码目录的链接，宿主读的是 `lib/`
→ **只需重建 `lib/`**，不重装；如果 `package.json` 的 `files`/入口变了，才需要 `remove` + `add`。
（`dsh plugin add` 输出 `Already up to date` 时它什么也没做，别误以为换上了。）

**什么时候才重建**：怀疑上一次把沙盒搞脏了（改坏的 profile、坏凭据、损坏的 storages），
或者要给用户演示「全新安装」。重建前先想清楚会丢掉什么，重建后要重新装插件 + **重新让用户加模型**。
要多开一个干净环境时，**新建一个沙盒**（`create clean`），别去毁掉正在用的那个。

### 3.5 脚本里怎么写（别写成每次 `rm -rf`）

```js
const REUSE = process.argv.includes('--reuse-sandbox')   // 默认复用
if (REUSE) {
  // 保留沙盒 home：里面的模型凭据、profile、插件版本都还在
} else {
  rmSync(SB, { recursive: true, force: true })       // 只在「要干净复现」时走
}
mkdirSync(SB, { recursive: true })
```

把 `--reuse-sandbox` 做进去，并且**在输出里打印当前是「复用」还是「重建」**——
否则「上次能跑、这次不能跑」永远查不出是沙盒换掉了。

### 3.6 验证沙盒真的成立（四条，缺一条就停下）

1. `$sb\profiles\sb-default\package.json` 的 `bundles` 里有你的插件（**`dependencies` 有、`bundles` 没有 = 没装**）。
2. `$sb` 下出现了 `storages/`、`.credentials.yaml`（有文件≠有模型，判据见 §3.7）。
3. 用户 `~/.dsh` 里**没有** `sb-default` 这个 profile；**界面上的项目名是 `sandbox-workspace`**（见 3.0.1）。
4. `git status` 干净（测试产物都在 `tmp/`、`.debug/` 里）。

### 3.7 凭据与模型：**看 records，不看字节数**

**别用文件大小判断有没有模型。** 这个版本里新建的沙盒 `home/.credentials.yaml` 已经有 ~160 字节，
里面只有一条 `client-connection/browser-session`（浏览器会话密钥）——它不是模型凭据。
判据是**记录名**：

```powershell
# 只看键名，不看值
Get-Content "<沙盒 home>\.credentials.yaml" | Select-String '^\s{2}\S+:$'
```

- 只有 `client-connection/browser-session` → **没配模型**，页面会显示「请选择模型」；
- 出现别的记录（账号、llm 路由）或 `refs:` 下的条目（如 `MAGPIE_GATEWAY_KEY`）→ 配好了。

没配模型的后果不是报错，而是静默降级：页面能读能写面板，但输入框右下角显示「请选择模型」，
**消息发不出去、会话建不出来**——于是依赖会话的验收（会话 tab、agent 回合）全都走不通。

`node scripts/sandbox.mjs list` 会直接给每个沙盒标 `model: yes / no`，不用自己判。

| 场景 | 做法 |
|---|---|
| 要人肉点、要长期迭代（默认） | **把 `open` 命令交给用户**，让他在这个沙盒里加一次模型，然后复用这个沙盒（§3.3） |
| 临时跑一次 agent、不想麻烦用户 | 把真实 home 的 `.credentials.yaml` **只读复制**到沙盒（别动真实那份），用完删掉 |

第二种是应急，不是默认：模型凭据是用户的私密信息，不该由脚本长期搬运；而只要沙盒复用，让用户加一次就够了。

### 3.8 打契约：别去找 token，用 `http`

路由契约（401 / 400 / 404 / 405、缺参、无活会话要明确拒绝）是「插件坏了」报错里最常见的误判来源。
沙盒已经把 `?token=` 从自己的日志里解析出来了，直接用它打路径，**不要**去翻浏览器 profile、翻页面源码找 token：

```
dsh_sandbox { action: 'http', name: 'default', path: '/__myteam/globalLibrary' }
dsh_sandbox { action: 'http', name: 'default', path: '/api/session/create', method: 'POST', body: '{"type":"client-request",…}' }
```

返回状态码 + `content-type` + 正文前 4000 字符，**正文里出现的 token 会被替换成 `{{token}}`**，不会漏进对话。

判据：401/403 说明认证闸在（这是**活着**的证据，不是失败）；405 说明方法不对；只有 200 才需要继续看数据。

### 3.9 造数据：空态验不出 UI

隔离 home 是空的，所以每块面板都显示空态——而空态几乎验不出问题。要么验的就是空态，要么把真实数据**只读复制**进来：

```
dsh_sandbox { action: 'seed', name: 'default', entries: ['myteam'] }     # 从 ~/.dsh 复制
dsh_sandbox { action: 'seed', name: 'default', entries: ['myteam'], from: 'E:/other/home' }
```

- 源目录**只读**，不动用户的 `~/.dsh`；目标已有的条目不覆盖，除非 `force: true`；
- 复制的目标是沙盒 home，所以「有数据」的样子在沙盒里是**真数据渲染出来的**，不是 mock；
- `.credentials.yaml` 也能复制，但那等于借用用户的模型：结果里会带 warning，别把它当成「模型验证过了」；
- 判据：面板上的数字要能和**磁盘**对上（看板数 == 概览 totals、审计条数 == 账本行数）。

### 3.10 沙盒验不到的部分（别硬说验过）

沙盒能给你实例、URL、token、HTTP 契约、真实数据渲染——但**给不了眼睛**：

- 视觉（深色、窄宽、截断、对比度）需要人看；浏览器控制不可用时就如实写「未验证」，不要自建 mock 页充数；
- **活会话只能由人在页面里开**：`session.create` 造出的会话不进 `storages/workspace.json` 的 `sessionIds`，
  左侧栏看不到、点不到，所以会话级 tab / 面板必须让用户点一次「新会话」并发一条消息（见 §5）；
- 想验「装完第一次打开」的样子，就**新建一个沙盒**（`create fresh`），别去毁正在用的那个。

### 3.11 停止与清除

```
dsh_sandbox { action: 'stop', name: 'default' }     # 只杀登记表里记过的那个 pid
dsh_sandbox { action: 'remove', name: 'default', confirm: true }
```

手工停的时候**先确认那个 pid 是谁**，再杀：

```powershell
$port = 3100
Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {
  $pid = $_.OwningProcess
  Get-Process -Id $pid | Select-Object Id, ProcessName, Path      # 先看，再决定
}
```

- **不要按进程名批量杀**（`Get-Process node | Stop-Process` 会把桌面端一起带走）；
- 端口上坐的不是你起的那个进程 → **别杀**，先查清楚。桌面端占的是它自己的端口（`3081`、`52332`），
  沙盒只在 `3100-3199` 里；
- 交付/收尾时才删沙盒（`remove … --yes`，或手工删 `tmp/sandboxes/<名字>`）；日常迭代**留着**；
- 删之前对照一次用户 `~/.dsh` 没有被改动；临时改过的用户状态要还原；
- `tmp/` 是产物目录，别提交。

## 4. 可重复的工作流（A → F）

| 步 | 做什么 | 完成判据 |
|---|---|---|
| **A 定性** | 先分清"该有"和"在看"：插件在哪个 profile、要看的是哪个实例、那次启动成没成 | 能一句话说清，如"插件在 `web`，我看到的是 `desktop`" |
| **B 静态** | 语法/单测/`--dump-config`/manifest | 组合树有那一行且未 `disabled`；单测绿 |
| **C 开沙盒** | 复用已有沙盒（首次才建、才装）；多开一个就新建沙盒，别毁掉在用的 | 打印 URL；`GET /` 有响应（401 也算"活着"） |
| **D 打契约** | 用 `dsh_sandbox` 的 `http` 动作按路由逐条打：401/400/404/405 + 需要活会话时的明确拒绝 | 错误码与信封都对得上表 |
| **E 对数据** | 先 `seed` 真实数据，再用活会话读一遍，和磁盘对账（计数、条数、名字） | 至少一处能对上；对不上就是真 bug |
| **F 写与回滚** | 先负路径（缺 confirm/篡改令牌），再正路径；发布类先在 `rollback` 沙盒演练回滚 | 负路径被明确拒绝；正路径落盘可核对；回滚后回到原状 |

测试阶梯里"由廉到贵"的顺序不要跳：**静态 → 启动/注册 → HTTP 契约 → 活会话数据 → 客户端注册 → 人眼 → 写面**。
便宜的步骤能挡掉 80% 的假问题（比如"入口不见"往往停在"启动/注册"这一层）。

## 5. 活会话：`agents.get` 的边界

会话类能力只认**本进程活会话**；脚本编一个 id 一定失败，而且**不许**回落到进程 cwd（那是静默接错项目）。
两条合法路径：

1. **让人在页面里开一个会话**（最真实，验收就用这个）；
2. **用 gateway 的 `session.create` 造**（自动化用）：

```text
POST /api/session/create
{"type":"client-request","rpcId":"<uuid>","method":"session/create",
 "payload":{"args":{"request":{"cwd":"<绝对路径>"}}}}
→ {"result":{"ok":true,"value":{"sessionId":"session-…"}}}
```

形状写错只会得到 `gateway/arguments-invalid` 或 `…exactly one plain-object args field`——改形状，别怀疑插件。

**但它不等于"界面上有一个可点的会话"**（实测）：

- `session.create` 造出的会话确实存在于磁盘（`$DSH_HOME\sessions\<工作区分组>\session-xxx`），
  也确实是本进程活会话，HTTP 面板接口能用它；
- 但它**不会被写进 `$DSH_HOME\storages\workspace.json` 的 `sessionIds`**，而左侧栏只列那里登记过的会话
  → 界面上看不到这一行，点不到；
- 也没有可直接导航的路由：`/?session=<id>`、`/#/session/<id>` 都停在欢迎屏，`/session/<id>` 直接 404
  （宿主是纯前端状态机，只有点击才进会话）。

所以要验**依赖会话的客户端 UI**（会话级 tab、会话面板），`session.create` 不够，只有让**界面上真的产生一个会话**：

1. 在页面里点「新会话」并在输入框发一条消息（前提：能选模型，见 §3.7）；
2. 或者让用户手动开一个会话（最省事）。

判据：**"接口能用这个会话" ≠ "界面上点得到它"**。前者靠 `session.create`，后者只能靠真实点击。

## 6. 客户端：Inspect 看的是"我这儿"

- `cordis_inspect_list` → `cordis_inspect_query`：`client/Slots.listSubTree` 看 slot 注册与标签文案，
  `client/Theme.listTokens` 看深色 token 是否齐全。
- **但它绑定在发起调用的 agent 所在宿主**：插件装在沙盒里 → Inspect 看不到它，别据此判"没装上"。
  沙盒靠 HTTP 探针 + 人眼；只有插件就在你当前宿主里时，Inspect 才是第一手证据。
- 宿主的客户端 bundle 是**合并 URL**（`plugins/??a/client.js,b/client.js&rev=…`）：
  自己拼单插件路径会 404，正确做法是从首页 HTML 里抄那一条再请求，断言内容含你仓库的原文特征串。

## 7. 人眼与"没验到"

自动化跑不到的部分（真实点击、深色、窄宽、字体/对比度、真实用户路径）必须**说清楚是没验**：

- 给用户一份"点什么、看什么、什么算过"的清单，让他点完把截图/报错回传；
- 报告里把"未验证项"单列，不要用"应该没问题"糊过去；
- 不要为了出图去伪造页面/自建渲染器/找 token——那是假证据，比没有更糟。

## 8. 发布与回滚

1. 版本与文档（`version`、发版清单、README 的"已知限制"）。
2. 构建产物（`node scripts/build-lib.mjs` 等）+ 构建清单与源码一致。
3. 门禁：单测 + 架构/契约/文档检查（一个入口脚本，别手点一堆）。
4. 看包面：`npm pack --dry-run`，确认 `files` 白名单没有 `tmp/`、`.debug/`、`.dsh-myteam/`；管道截断会让退出码失真，以 `npm run prepack` 为准。
5. **先演练回滚，再装新版**：回滚命令与"回滚后应该看到什么"在装之前写好；在 `rollback` 沙盒里先跑一遍"装新版→回滚→装回"。
6. 装到真实 profile：`dsh plugin --profile web add <pkg>@<version>`；回滚 = `remove` + 装回上一版。
7. 发布后**对账**：看板计数 == 概览 totals；审计条数 ≈ 账本行数；文件 mtime 变了且内容就是那条。
8. 把没验到的写进"已知限制"。

## 9. 故障对照表

| 现象 | 根因 | 处置 |
|---|---|---|
| 桌面端被顶掉 / 宿主 `exited with …` | 起了桌面端二进制，或第二个实例共用了同一个 `DSH_HOME` | 改用 `dsh --profile <p>` + 独立 `DSH_HOME`（沙盒默认如此）；桌面端占 `3081`、`52332`，别碰 |
| `EADDRINUSE` | 端口被占（沙盒端口 3100-3199 按项目内唯一分配，撞上说明登记表被手改过） | 换端口（或 `--port 0`）；**不杀不认识的进程**——`stop` 会因为 pid 对不上而拒绝 |
| `N required plugins did not activate` | 某行插件加载失败，宿主带伤启动 | `--dump-config` 定位 → 装依赖/重建 `lib`/修 patch |
| 装了但入口不见 | ① 插件在哪个 profile ② 你看哪个实例 ③ 那次启动成没成 | 三问都回答完再查代码 |
| `401 MT_UNAUTHENTICATED` | 没带会话 cookie | 用**你自己实例**打印的 `?token=` 打开 |
| `403 MT_UNTRUSTED_HOST` | 反代/局域网 Host | 给实例加 `--trusted-host` |
| 面板说"没有绑定工作区" | `sessionId` 不是本进程活会话 | 用 `session.create` 造，或让人在页面里开 |
| `WRITER_LEASE_LOST` | 两个实例写同一个项目 | 用工作区副本（删副本里的 `state/writer.lock`）或停另一个写者 |
| Inspect 查不到 slot | Inspect 只认你所在宿主 | 沙盒改用 HTTP 探针 + 人眼 |
| 改了源码没反应 | `link:` 不跑 `prepack`；改的是宿主那半还是客户端那半 | 重建 `lib` / 硬刷新页面 |
| 沙盒里调不动模型 | 沙盒 home 的凭据里只有浏览器会话，没有模型记录（**看记录名，不是看文件大小**） | 默认：把 `open` 命令交给用户，让他配一次后复用沙盒；应急才只读复制 `~/.dsh/.credentials.yaml`（§3.7） |
| 「请选择模型」是空的 / 消息发不出去 / 建不出会话 | 同上一行：没有凭据就没有模型可选 | 先解决凭据；否则会话级 UI 一律验不到 |
| `session.create` 成功但左侧栏看不到那个会话 | 它不进 `storages/workspace.json` 的 `sessionIds` | 会话级 UI 只能靠页面里真发一条消息产生会话（§5） |
| 输入框"打字"没进去 / 发不出消息 | 用 JS 改 `value` 对 contenteditable / 富文本编辑器无效 | 走 CDP 真实输入：`Input.dispatchMouseEvent` + `Input.insertText` + `dispatchKeyEvent`（incidents 20） |
| 面板每栏都显示"未初始化" / 读到别人的旧数据 | **工作区没隔离**，会话跑在用户的 `Documents` 目录上 | 改 `<沙盒 home>\storages\workspace.json` 的 `path` 指向副本（§3.2、incidents 19） |
| 上次能跑 agent、这次不能 | 这次把沙盒删了重建，凭据/模型没了 | 默认**复用**沙盒，只在需要干净复现时新建另一个沙盒（§3.4） |
| 命令"失败"但输出正常 | 管道截断 / UTF-16LE 日志 | 以退出码为准；按 BOM 判编码 |

## 10. 判据速查（什么叫"测过了"）

- **能装**：组合树有那行、启动无激活失败、路由有应答。
- **能读**：无会话方法通；有会话方法在活会话下返回真实数据，并**与磁盘对账**。
- **能写**：正路径落盘可核对；负路径被明确拒绝（错误码清楚，不静默）。
- **能看**：标签/位置符合预期（活注册或合并 bundle 证据）+ 人说"看到了"。
- **能退**：停实例；用户环境零改动；回滚演练过。
  沙盒**日常迭代保留**（里面有凭据与安装），交付收尾时才删。
- **能说清**：报告里同时写"验过什么"和"没验什么"。
- **能续**：下次接手的人（或下次的自己）能用**同一个沙盒**接着跑，不用重新装、重新配模型。
