# 发版流程

发版这件事只有两个问题：**包里到底是什么**，和**装上会不会把别人的宿主搞坏**。这个文件按顺序回答，并给出每一步的判据。

## 0. 先选分发形态

| 形态 | 怎么做 | 什么时候用 |
|---|---|---|
| **registry**（npm） | `npm publish` → `dsh plugin --profile <p> add <name>@<version>` | 要给别人装、要能按版本回滚 |
| **tarball**（本地/内网分发） | `pnpm pack` → `dsh plugin --profile <p> add <file>.tgz` | 私有分发、还没准备好公开发布 |
| **link**（源码目录） | `dsh plugin --profile <p> add link:<目录>` | **开发态**，不是发版；改了源码重启即生效 |

`link:` 不是发版——它把宿主绑在你的工作目录上。真正发版必须落到前两种之一。

## 1. 静态检查

```powershell
node scripts/release.mjs check .
# 或：dsh_plugin_release { action: 'check', path: '<包目录>' }
```

它问打包器**真实**会装进 tarball 的文件（`pnpm pack --dry-run --json`），而不是照着 `files` 猜；并拿 `dsh --version` 和包的 `engines.dsh`（没有就看 `@deepseek-ai/dsh` 依赖）比对。

| 检查 | 判据 |
|---|---|
| `release:version` | 是 semver |
| `release:entry` | `exports["."]` 指向真实存在的文件 |
| `release:patch` | `dsh.bundle.patch` 指向真实存在的文件 |
| `release:private` | `private: true` 会**阻止 `npm publish`**（warn：tarball 分发可以保留） |
| `release:compatibility` | `engines.dsh` 与运行版本相容；**没有声明就是 warn**——DSH 只能到装的时候才发现不匹配 |
| `release:surface` | tarball 里没有 `tmp/`、`.debug/`、`node_modules/`、`*.tgz` |
| `release:size` | 解包后 < 5 MB（warn） |
| `release:contents` | tarball 里有 `package.json`、`README.md`、`icon.svg` |

> **兼容性为什么重要**：`dsh plugin add` 由 DSH 校验版本要求，不满足会直接拒绝安装（真实事故：插件依赖 `alpha` 线、运行时是 `rc` 线，装不上）。在包里写 `"engines": { "dsh": "^0.2.2-rc.5" }`，DSH 就能在装之前拒绝，而不是装完激活失败。

## 2. 打包

```powershell
node scripts/release.mjs pack .            # → tmp/release/<name>-<version>.tgz
```

## 3. 在沙盒里演练（**别跳过**）

```powershell
node scripts/release.mjs rehearse . --sandbox rollback
```

它做四件事，每一步都有输出：建/复用 `rollback` 沙盒 → 打包 → 把 **tarball** 装进沙盒 profile → `--dump-config` 读回组合结果。

判据（`rehearse` 直接给结论）：

1. `--dump-config` 里**出现你的包名**（`dependencies` 有、`bundles` 没有 = 没装）；
2. 没有 `N required plugins did not activate`；
3. 回滚命令可用（输出里给了），并且**先演练过一次回滚**再装新版。

沙盒是复用的，所以第二次演练只花几秒。演练完记得把沙盒切回 `link:`（如果你还要继续改源码），否则沙盒里跑的是冻结的 tarball。

## 4. 发布

```powershell
npm publish            # registry 形态；private 必须先去掉
# 或直接把 tmp/release/*.tgz 分发出去
```

**这一步不由工具代劳**：`npm publish` 不可撤销，账号与可见性（`publishConfig.access`）是人的决定。`dsh_plugin_release` 只报「能不能发、该跑什么」。

## 5. 装到真实 profile

```powershell
dsh plugin --profile <profile> add <name>@<version>
```

装之前先记下当前版本（回滚要用）：

```powershell
dsh plugin --profile <profile> why <name>
```

## 6. 回滚

```powershell
dsh plugin --profile <profile> remove <name>
dsh plugin --profile <profile> add <name>@<上一版版本>
```

回滚后**按同一判据复查**：`--dump-config` 有那一行、没有激活失败、界面/工具回到旧行为。

## 7. 发布后对账

1. `dsh --profile <p> --dump-config`：那一行在，且没有诊断；
2. **新开**一个会话（已有会话保留创建时的组合）验证工具/技能/slot 真的出现；
3. 面板或数据面至少一处**与磁盘对上**（数字、条数、名字），不是「看着有东西」；
4. 版本号在 profile 里就是你发的那个版本。

## 8. 提交到插件市场

市场（`awesome-dsh-plugin`）的投稿是**一个 YAML 文件**，不是改 README：`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本从 `data/plugins/*.yml` 生成，手工编辑会撞别人的行。

条目**由包生成，不手写**：

```powershell
node scripts/market-entry.mjs            # 打印条目
node scripts/market-entry.mjs --check    # 按发布规则校验 + 问 gh 要仓库状态
node scripts/market-entry.mjs --write data/plugins/<owner>__<repo>.yml
```

`url` 和 `name` 来自 `git remote`，所以不可能指向别的仓库；一句话描述来自项目根的 `market.json`（写清楚这一行是**声明**，会被维护者对着代码核对）。

### 市场自动检查的（本地也检查）

| 规则 | 判据 |
|---|---|
| 文件名 | 必须等于 `url` 推出的 slug：`owner__repo.yml`；monorepo 是 `owner__repo--packages-x.yml` |
| `url` | `https://github.com/owner/repo`，monorepo 指到子目录 |
| `category` | 必须是发布列表里的取值（`dev` / `tools` / `ui` / `workflow` …） |
| `description.en` | 必填、单行、**以句号结尾** |
| 含 `: ` 的描述 | **必须加引号**，否则 YAML 读成嵌套键——最常见的投稿失败原因 |
| `icon` | 只收 GitHub 托管的位图（png/jpg/jpeg/webp），**矢量图会被拒** |
| `tarball` | 必须是 GitHub Release 上的 `.tgz` |

### 只能由 GitHub 回答的

`--check` 会问 `gh`，把这两条单独报出来，而不是假装离线能验：

- **仓库满 1 天**。刚建的仓库第一次提交必红，指南说这道闸会自动重跑，几小时后自己变绿——不用重开 PR，也不用推空提交。
- **`dsh-plugin` topic**。没加就会被拒。

### 五个坑（来自指南，逐条对应我们的做法）

1. **`dsh.bundle` 是安装的前提**。只声明 `dsh.client` 的仓库装不上——我们的 `package.json` 里 `dsh.bundle.patch` 一直有，结构检查也会查。
2. **`@deepseek-ai/*` 要写 `peerDependencies`，不是 `dependencies`**。而且范围必须带显式的预发布分支，否则 node-semver 会**静默排除**所有预发布构建：
   ```jsonc
   // ❌ 看着宽，实际匹配不到 0.1.0-rc.6
   "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.2.0" }
   // ✅ 在匹配的元组上带预发布标签
   "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0" }
   ```
   本包**没有任何依赖**，所以不受影响；一旦要加，按上面写。
3. **`tarball` 的 `latest/download/` 只解析 tag，文件名照字面取**。资产名里带版本号，链接在你下一次发版时 404，而且没人会察觉。要么资产名不带版本，要么钉住 tag。
4. **npm 包名是新的时，`npm publish` 返回那一刻还不一定装得上**：有时只留一个 `0.0.0-stage` 占位，有时 tarball 几分钟内 404。判断标准看 registry：`dist-tags.latest` 等于你的版本**且** `dist.tarball` 能下载。国内镜像可能更久，`dsh plugin --profile <p> add <name>` 真装一遍再算数。
5. **描述必须属实**。写着「46 个工具、六大领域」就该真有；提了某个命令或 API，它就该存在。夸大是本来不错的插件被打回的主要原因。

## 9. 这个能力不做什么

- **不发布**：不跑 `npm publish`，不改 registry 配置，不碰账号；
- **不验权限**：`publishConfig.access`、npm 登录态由 npm 自己报错；
- **semver 是子集**：支持 `^` `~` `>=` `<=` `>` `<` `=` 与 `||`，不处理 `*`、`x`、范围和标签；
- **不验客户端渲染**：视觉与真实点击仍需人看，沙盒能给的只是实例、URL、契约与数据。
