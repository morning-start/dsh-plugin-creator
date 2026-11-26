---
name: dsh-plugin-isolated-test
description: "用 **dsh web**（不是桌面端）在**隔离的 DSH_HOME** 里创建、测试、debug、发布一个 DSH 插件，全程不干扰用户正在用的桌面端/其它实例。当你要「测插件」「验证插件装没装上/生效没」「在 web 实例里点一遍」「面板/客户端渲染怎么验」「debug dsh web 起不来/入口不见/401/403」「用 dsh profile 装、换、覆盖、回滚」「发版前跑一遍验收」时就用它；只要任务涉及\"在真实宿主里验证一个 DSH 插件\"或\"dsh web 出问题\"，即使没提\"隔离\"也应该用它。"
---

# 用 dsh web + 隔离 DSH_HOME 测一个 DSH 插件

**默认测试对象是 `dsh web`**——桌面端是用户的东西，不归你测、也不许你去碰。每个测试实例都做三件事：
独立 `DSH_HOME`、独立 profile、独立端口。这样既不会抢会话，也不会抢写者租约，更不会把桌面端顶掉。

**隔离 home 按「插件」固定，不按「运行」固定。** 同一个插件的开发迭代**默认复用一个** home
（如 `<repo>/tmp/iso-home`），只有明确要「干净环境复现」时才重建。
理由是最贵的几样东西都在 home 里：`dsh plugin add` 的 pnpm 安装（几百毫秒到几十秒，还要跨盘 store）、
**手动加过的模型凭据**、profile 里的插件版本、已登录态。
每次 `rm -rf` 会把它们一起清掉——表现为「上次还能跑 agent，这次发不出消息」，
而这看起来像插件坏了。详见 `references/incidents.md` 第 15 条。

配套资料（按需读，不要一次全读）：

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

> **`DSH_HOME` 不隔离工作区。** 这是最容易漏的一条：隔离 home 新建时宿主会自动登记一个默认工作区，
> 路径是 `C:\Users\<user>\Documents\deepseek-harness\default-workspace` —— **用户的真实目录**。
> 不改它，你的"隔离实例"就在用户的项目上跑（本项目实测：读到用户那份 `schemaVersion: 1` 的旧数据，
> 每栏都显示「未初始化」）。起实例前改 `$ISO\storages\workspace.json` 里的 `workspaces[*].path`
> 指向仓库内副本，见 §3.0 与 `incidents.md` 第 19 条。

三个环境变量决定你手上这个 shell 属于谁：`DSH_HOME`（根）、`DSH_PROFILE` / `DSH_PROFILE_DIR`（**只在由 profile 启动的 shell 里存在**）。
`DSH_INSTALL_DIR` 是 CLI 包目录（文档在 `$DSH_INSTALL_DIR/docs/user`），`DSH_NODE_EXECUTABLE` 是运行时 Electron（读 asar 才需要它）。

## 1. 六条铁律

1. **绝不启动桌面端二进制**：`DeepSeek Harness.exe … dsh-desktop-host/lib/cli.js`。那是桌面端自己的宿主，
   单实例语义——第二个会把第一个顶掉（真实事故：`exited with 4294967295` 连崩三次）。要起实例只用 `dsh --profile <p>`。
2. **不手改 profile 文件**（`package.json` / `cordis.patch.yml`）：装、卸、覆盖都用 `dsh plugin` 与 `--patch`。
3. **不为截图去换 HOME / 找 token / 翻浏览器 profile**。浏览器控制不可用时，视觉部分如实写"未验证"。
4. **只停自己的东西**：按端口/PID 停；不按进程名批量杀，不碰不认识的进程。
5. **测试数据落在隔离 home 或工作区副本**：写真实项目/真实全局库之前先问自己"能不能拷一份"。
6. **隔离 home 复用，别每次重建**：把 home 路径写进脚本常量或环境变量，跑第二遍时**保留**它。
   只有症状要求"从零开始"（怀疑 home 被上次污染）才重建，并且重建前想清楚会丢掉什么（见 §3）。

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

## 3. 起一个隔离实例（**首次创建 → 之后一直复用** → 停止）

### 3.1 home 按插件固定

```powershell
$iso = "<repo>\tmp\iso-home"      # 这个插件的固定 home，写进脚本常量，不要在脚本里 rm 它
New-Item -ItemType Directory -Force -Path $iso | Out-Null   # -Force 已存在也不报错，不会清空
$env:DSH_HOME = $iso
```

### 3.0 先把工作区指到副本（**别跳过这一步**）

隔离 home 里宿主会自建一个默认工作区，指向用户的 `Documents\deepseek-harness\default-workspace`。
起实例前把它改到仓库内的副本目录，否则后续所有会话都在**用户的真实项目**上跑：

```js
// 第一次起实例前、以及 workspace.json 存在时每次都做
const wsJsonPath = join(ISO, 'storages', 'workspace.json')
if (existsSync(wsJsonPath)) {
  const parsed = JSON.parse(readFileSync(wsJsonPath, 'utf8'))
  for (const entry of Object.values(parsed.tables?.workspaces ?? {})) {
    entry.path = WS                    // <repo>/tmp/iso-ws，空目录或你自己的副本
    entry.title = 'iso-workspace'
  }
  writeFileSync(wsJsonPath, JSON.stringify(parsed, null, 2) + '\n')
}
```

- `WS` 推荐用**空目录**：插件打开时会自己 bootstrap 出新版 schema 的数据，
  这样验到的是真实空态；直接拷仓库里那份旧 `.dsh-myteam` 反而可能因为版本不匹配而整屏未初始化。
- 改的是**我们自己那份 home**，不动用户状态。
- 判据：界面上面板标题里的项目名应该是你的副本名（`iso-workspace` / `iso-ws`），不是 `default-workspace`。

**第一次**（profile 还不存在）：

```powershell
dsh --profile iso-myteam --from-default-profile web --dump-config   # 从出货模板复制一份 profile
dsh plugin --profile iso-myteam add link:E:/abs/path/plugin         # 用 CLI 装
```

**之后每次**（同一插件迭代、改了源码）：**跳过上面两步，直接起**。

```powershell
dsh --profile iso-myteam --host 127.0.0.1 --port 3099 --no-open     # 前台跑，能 Ctrl+C
# 打印：dsh web: http://127.0.0.1:3099/?token=…
```

改了源码要不要重装？取决于包形态：`link:` 是指向源码目录的链接，宿主读的是 `lib/`
→ **只需重建 `lib/`**，不重装；如果 `package.json` 的 `files`/入口变了，才需要 `remove` + `add`。
（`dsh plugin add` 输出 `Already up to date` 时它什么也没做，别误以为换上了。）

### 3.2 脚本里怎么写（别写成每次 `rm -rf`）

```js
const REUSE = process.argv.includes('--reuse-home')   // 默认复用
if (REUSE) {
  // 保留 home：里面的模型凭据、profile、插件版本都还在
} else {
  rmSync(ISO, { recursive: true, force: true })       // 只在「要干净复现」时走
}
mkdirSync(ISO, { recursive: true })
```

把 `--reuse-home` 做进去，并且**在输出里打印当前是「复用」还是「重建」**——
否则「上次能跑、这次不能跑」永远查不出是 home 换掉了。

**什么时候才重建**：怀疑上一次把 home 搞脏了（改坏的 profile、坏凭据、损坏的 storages），
或者要给用户演示「全新安装」。重建前先想清楚会丢掉什么，重建后要重新装插件 + 重新加模型。

### 3.3 验证隔离真的成立（四条，缺一条就停下）

1. `$iso\profiles\iso-myteam\package.json` 的 `bundles` 里有你的插件（**`dependencies` 有、`bundles` 没有 = 没装**）。
2. `$iso` 下出现了 `storages/`、`.credentials.yaml`（`.credentials.yaml` 可能是 0 字节，见 3.4）。
3. 用户 `~/.dsh` 里**没有** `iso-myteam` 这个 profile；**界面上的项目名是你的副本**（见 3.0）。
4. `git status` 干净（测试产物都在 `tmp/`、`.debug/` 里）。

### 3.4 凭据与模型：**0 字节 = 调不动模型**

隔离 home 的 `.credentials.yaml` 默认是空的。**看文件存在没有用，要看大小**：

```powershell
Get-Item "$iso\.credentials.yaml" | Select-Object Length     # 0 = 空骨架
```

空的后果不是报错，而是静默降级：页面能读能写面板，但输入框右下角显示「请选择模型」，
**消息发不出去、会话建不出来**——于是依赖会话的验收（会话 tab、agent 回合）全都走不通。

两条路，按场景选：

| 场景 | 做法 |
|---|---|
| 临时跑一次 agent | 把真实 home 的 `.credentials.yaml` **复制**到隔离 home（只读复制，别动真实那份） |
| 要人肉点、要长期迭代 | **让用户在这个隔离实例里加一次模型**，然后**复用这个 home**（这才是默认做法） |

第二种更可靠：模型凭据是用户的私密信息，不该由脚本搬运；而只要 home 复用，加一次就够了。

### 3.5 停止

```powershell
Get-NetTCPConnection -LocalPort 3099 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 3.6 清除（**不是每次做完都清**）

- 交付/收尾时才删 `$iso`；日常迭代**留着**。
- 删之前对照一次用户 `~/.dsh` 没有被改动；临时改过的用户状态要还原。
- `tmp/` 是产物目录，别提交。

## 4. 可重复的工作流（A → F）

| 步 | 做什么 | 完成判据 |
|---|---|---|
| **A 定性** | 先分清"该有"和"在看"：插件在哪个 profile、要看的是哪个实例、那次启动成没成 | 能一句话说清，如"插件在 `web`，我看到的是 `desktop`" |
| **B 静态** | 语法/单测/`--dump-config`/manifest | 组合树有那一行且未 `disabled`；单测绿 |
| **C 起实例** | 隔离 home（**复用**，首次才装）+ 独立 profile + 独立端口 | 打印 URL；`GET /` 有响应（401 也算"活着"） |
| **D 打契约** | 按路由逐条打：401/400/404/405 + 需要活会话时的明确拒绝 | 错误码与信封都对得上表 |
| **E 对数据** | 用活会话读一遍，再和磁盘对账（计数、条数、名字） | 至少一处能对上；对不上就是真 bug |
| **F 写与回滚** | 先负路径（缺 confirm/篡改令牌），再正路径；发布类先在隔离实例演练回滚 | 负路径被明确拒绝；正路径落盘可核对；回滚后回到原状 |

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

1. 在页面里点「新会话」并在输入框发一条消息（前提：能选模型，见 §3.4）；
2. 或者让用户手动开一个会话（最省事）。

判据：**"接口能用这个会话" ≠ "界面上点得到它"**。前者靠 `session.create`，后者只能靠真实点击。

## 6. 客户端：Inspect 看的是"我这儿"

- `cordis_inspect_list` → `cordis_inspect_query`：`client/Slots.listSubTree` 看 slot 注册与标签文案，
  `client/Theme.listTokens` 看深色 token 是否齐全。
- **但它绑定在发起调用的 agent 所在宿主**：插件装在隔离实例里 → Inspect 看不到它，别据此判"没装上"。
  隔离实例靠 HTTP 探针 + 人眼；只有插件就在你当前宿主里时，Inspect 才是第一手证据。
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
5. **先演练回滚，再装新版**：回滚命令与"回滚后应该看到什么"在装之前写好；在隔离实例里先跑一遍"装新版→回滚→装回"。
6. 装到真实 profile：`dsh plugin --profile web add <pkg>@<version>`；回滚 = `remove` + 装回上一版。
7. 发布后**对账**：看板计数 == 概览 totals；审计条数 ≈ 账本行数；文件 mtime 变了且内容就是那条。
8. 把没验到的写进"已知限制"。

## 9. 故障对照表

| 现象 | 根因 | 处置 |
|---|---|---|
| 桌面端被顶掉 / 宿主 `exited with …` | 起了桌面端二进制 | 改用 `dsh --profile <p>`；换 `DSH_HOME` |
| `EADDRINUSE` | 端口被占 | 换端口（或 `--port 0`）；不杀不认识的进程 |
| `N required plugins did not activate` | 某行插件加载失败，宿主带伤启动 | `--dump-config` 定位 → 装依赖/重建 `lib`/修 patch |
| 装了但入口不见 | ① 插件在哪个 profile ② 你看哪个实例 ③ 那次启动成没成 | 三问都回答完再查代码 |
| `401 MT_UNAUTHENTICATED` | 没带会话 cookie | 用**你自己实例**打印的 `?token=` 打开 |
| `403 MT_UNTRUSTED_HOST` | 反代/局域网 Host | 给实例加 `--trusted-host` |
| 面板说"没有绑定工作区" | `sessionId` 不是本进程活会话 | 用 `session.create` 造，或让人在页面里开 |
| `WRITER_LEASE_LOST` | 两个实例写同一个项目 | 用工作区副本（删副本里的 `state/writer.lock`）或停另一个写者 |
| Inspect 查不到 slot | Inspect 只认你所在宿主 | 隔离实例改用 HTTP 探针 + 人眼 |
| 改了源码没反应 | `link:` 不跑 `prepack`；改的是宿主那半还是客户端那半 | 重建 `lib` / 硬刷新页面 |
| 隔离实例里调不动模型 | 隔离 home 的凭据是空的（**看字节数，不是看文件在不在**） | 复制 `~/.dsh/.credentials.yaml` 过去，或让人在该实例里配一次再复用 home |
| 「请选择模型」是空的 / 消息发不出去 / 建不出会话 | 同上一行：没有凭据就没有模型可选 | 先解决凭据；否则会话级 UI 一律验不到 |
| `session.create` 成功但左侧栏看不到那个会话 | 它不进 `storages/workspace.json` 的 `sessionIds` | 会话级 UI 只能靠页面里真发一条消息产生会话（§5） |
| 输入框"打字"没进去 / 发不出消息 | 用 JS 改 `value` 对 contenteditable / 富文本编辑器无效 | 走 CDP 真实输入：`Input.dispatchMouseEvent` + `Input.insertText` + `dispatchKeyEvent`（incidents 20） |
| 面板每栏都显示"未初始化" / 读到别人的旧数据 | **工作区没隔离**，会话跑在用户的 `Documents` 目录上 | 改 `$ISO\storages\workspace.json` 的 `path` 指向副本（§3.0、incidents 19） |
| 上次能跑 agent、这次不能 | 这次把隔离 home 删了重建，凭据/模型没了 | 脚本默认**复用** home，只在需要干净复现时重建（§3） |
| 命令"失败"但输出正常 | 管道截断 / UTF-16LE 日志 | 以退出码为准；按 BOM 判编码 |

## 10. 判据速查（什么叫"测过了"）

- **能装**：组合树有那行、启动无激活失败、路由有应答。
- **能读**：无会话方法通；有会话方法在活会话下返回真实数据，并**与磁盘对账**。
- **能写**：正路径落盘可核对；负路径被明确拒绝（错误码清楚，不静默）。
- **能看**：标签/位置符合预期（活注册或合并 bundle 证据）+ 人说"看到了"。
- **能退**：停实例；用户环境零改动；回滚演练过。
  隔离 home **日常迭代保留**（里面有凭据与安装），交付收尾时才删。
- **能说清**：报告里同时写"验过什么"和"没验什么"。
- **能续**：下次接手的人（或下次的自己）能用**同一个 home** 接着跑，不用重新装、重新配模型。
