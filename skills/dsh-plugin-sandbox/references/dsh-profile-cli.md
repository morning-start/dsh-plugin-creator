# dsh / profile 命令速查（含输出怎么读）

> 目标：任何"这个插件到底装没装、跑的是哪套配置"的问题，都能在 30 秒内用命令回答，
> 而不是靠重启试试看。

## 1. 两个入口，别搞混

| 入口 | 是什么 | 什么时候用 |
|---|---|---|
| `dsh`（运行时 CLI，如 `C:\APP\agent\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`） | 启动器：按 profile 组合插件树并跑 app | 起 web / headless / 看组合树 / 装插件 |
| `DeepSeek Harness.exe … dsh-desktop-host/lib/cli.js` | **桌面端自己的宿主进程** | 永远不要由你启动（见 SKILL.md 铁律 1） |

`dsh --help` 的用法行已经说明一半事实：

```
dsh [--profile] <name> [options] [app-args...]
dsh plugin --profile <name> <pnpm-args...>
```

也就是说：**第一个位置参数是 app 名**（`web` / `headless` / `tui` / `desktop` / 自定义 profile 名），
`--profile` 指向 `$DSH_HOME/profiles/<name>`；`dsh web` 等价于 `dsh --profile web`。

## 2. 命令地图

| 命令 | 作用 | 判据 / 输出怎么读 |
|---|---|---|
| `dsh --profile <p> --dump-config` | 打印**组合后**的插件树（含 user layer 与 `--patch`） | 你要找的插件行在不在、`disabled` 是不是 true。这是"装没装上"的第一手证据 |
| `dsh --profile <p> --dump-default-config` | 只打默认层（去掉 user layer 与 patch） | 对比用：差异就是你的 profile 加的 |
| `dsh --profile <p> --dump-config-schema` | 打条目与 patch 的 JSON Schema，不挂载 | 写 patch/覆盖层时校验字段 |
| `dsh web --help` | web app 自己的参数 | `--host` `--port` `--no-open` `--public-url` `--trusted-host` `--tls-cert/--tls-key` |
| `dsh --profile <p> --from-default-profile <shipped>` | 用**出货模板**重建这个自定义 profile | 只在 profile 坏了/要干净起点时用；会覆盖该 profile 的 user layer |
| `dsh --profile <p> --patch <file.yml>` | 额外叠加覆盖层（可重复） | 覆盖某行 `disabled`、插入本地插件。**只贡献配置，不改 loader 解析模块路径所用的 profile 目录** → 插件路径要写绝对路径 |
| `dsh plugin --profile <p> list` | 列出该 profile 装的包 | 看 `dependencies` 里有没有你的包、是不是 `link:` |
| `dsh plugin --profile <p> add link:<abs>` | 装本地包（pnpm 转发） | 输出 `+ 包名 版本 <- 相对路径` 即成功 |
| `dsh plugin --profile <p> remove <pkg>` | 卸包 | 回滚用 |
| `dsh headless "任务"` | 跑一次任务、打印结果、退出 | 验证 host 侧工具/服务，不需要 UI |
| `dsh rescue --from-default-profile web` | 用出货 web 模板重建 rescue 并启动 | 自己把 profile 玩坏时的急救 |

> 别在 profile 目录里直接跑 `pnpm …`，也别手写 profile 的 `package.json` / `cordis.patch.yml`：
> 让 `dsh plugin` 去做，它才会同时维护依赖与 `dsh.profile.bundles` 两处一致性。

## 3. profile 到底是什么顺序

组合顺序（从下到上）：出货 bundle 层 → profile 的 user layer（`package.json` 的 `dsh.profile.bundles`）
→ `--patch` 覆盖层。所以：

- 一个插件"在 `dependencies` 里"但没进 `bundles` → **等于没装**（不会被挂载）。
- 一行被上游 bundle 写成 `disabled: true` → 你的 patch 必须显式 `disabled: false` 才能启用。
- 同一个 `webServer`/slot 路径注册两次会抛错，报在日志里而不是页面：`myteam.panel.route-register-failed` 这类
  自定义 warn 要么提前埋，要么去宿主日志里找。

## 4. 环境变量（每个 shell 调用都能读到）

| 变量 | 含义 | 常见误用 |
|---|---|---|
| `DSH_HOME` | 会话/存储/凭据/profile/skills 的根 | 两个实例共用会抢会话；隔离测试就换它 |
| `DSH_PROFILE` | 当前启动的 profile 名 | 只在**由 profile 启动**的 shell 里存在；它证明不了"哪个实例" |
| `DSH_PROFILE_DIR` | 该 profile 的目录（`node_modules` 只有 profile 装的包） | 别从这里推断出货包路径 |
| `DSH_INSTALL_DIR` | CLI 包目录（`…\@deepseek-ai\dsh`） | 文档在 `$DSH_INSTALL_DIR/docs/user`；asar 里普通 node 读不了 |
| `DSH_NODE_EXECUTABLE` | 运行时的 Electron 可执行文件 | 读 asar 要配 `ELECTRON_RUN_AS_NODE=1`，否则只会打开 GUI |
| `DSH_WEB_URL` | 宿主对外公布的可访问根 | 只在 web 实例里由宿主注入 |

## 5. 本机验证过的输出长什么样

装本地包：

```
+ dsh-plugin-myteam 2.0.0-alpha.1 <- ..\..\..\..\plugin
Done in 387ms using pnpm v11.28.5
```

- `Already up to date` = 已经 link 过，没有变化（不是失败）。
- `[WARN] The store at … is not used because packages cannot be hard linked from it` = 跨盘 store 警告，可忽略。
- `link:` 安装**不会**跑 `prepack`：如果包有 `src → lib` 构建，装完还要 `node scripts/build-lib.mjs`，
  否则宿主加载的是旧/缺的 `lib`。

组合树里找你的行：

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'myteam' -Context 0,2
```

看到 `- id: <你的行>` 且没有 `disabled: true` 才算挂上；看不到就是没进 `bundles`。

## 6. 坑清单

| 坑 | 现象 | 处置 |
|---|---|---|
| 手改 `package.json` 加依赖 | 装了但组合树里没有 | 用 `dsh plugin add` 重装 |
| 只加了 `dependencies` 没进 `bundles` | 同上 | 让 CLI 装，或按 CLI 的结果核对 `bundles` |
| `link:` 后没重建 `lib` | 宿主跑旧代码（改了没反应） | `node scripts/build-lib.mjs` 后重启（客户端另有：硬刷新） |
| 用 `--patch` 指向相对路径的插件 | 加载失败（解析基准是 profile 目录） | patch 里的插件路径写绝对路径 |
| 两个实例同 home | 抢会话、`WRITER_LEASE_LOST`、桌面端被顶掉 | 换 `DSH_HOME`（见 SKILL.md §3） |
| 端口写死 3080/52332 等常见口 | `EADDRINUSE` | `--port 0` 让系统分配，或换一个自己的口 |
| profile 目录被别的进程占用 | 安装/重建报错 | 先停掉用它的实例 |