# 发版流程

发版这件事只有两个问题：**包里到底是什么**，和**装上会不会把别人的宿主搞坏**。这个文件按顺序回答，并给出每一步的判据。

## 唯一的发版方式：打 tag，交给 CI

**不要手打 `npm publish`，不要手建 GitHub Release。** 发版只有一个动作：推一个 `v*` 标签。

```powershell
# 1. 改版本号——这是唯一需要手改的地方
node -e "const p=require('./package.json');p.version='0.5.0';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
git add package.json
git commit -m "chore(release): 0.5.0"

# 2. 推代码，再推标签——推标签这一下就是发版
git push origin main
git tag v0.5.0
git push origin v0.5.0
```

之后 CI（`.github/workflows/release.yml`）依次做，任何一步失败就停，不会留下半个发布：

```
check → pack → publish → release → verify(advisory)
```

| CI 步骤 | 判据 |
|---|---|
| npm must be new enough | trusted publishing 要 npm ≥ 11.5.1 |
| The tag must match package.json | `v0.5.0` 与 `package.json` 的 `0.5.0` 不一致直接失败 |
| The package must be installable | 有 `dsh.bundle.patch` |
| Readiness check | 本仓库跑 `release check` |
| Suites | 本仓库跑 CI 能跑的回归（`try-ui` 要真浏览器，不在里面） |
| Pack | `npm pack`，复制成**不带版本号**的资产名 |
| Publish to the registry | `npm publish --provenance`，凭据由 OIDC 现场换，**仓库不存 token**；版本已存在则失败并说明下一步 |
| Create the GitHub Release | `gh release create`；已存在就跳过 |
| Registry propagation | advisory，registry 慢不撤销已经发生的发布 |

**为什么必须是 CI**：

- **provenance 只有 CI 有**。`npm publish --provenance` 用 OIDC 身份证明「这个包是从哪个仓库、哪次提交构建的」。本地发版没有这个身份，签名是空的。
- **凭据不落盘**。OIDC 每次运行换一张短期票，仓库里没有可泄露的长期密钥。
- **版本↔标签只在推标签那一刻对账**。本地永远不知道你要打什么 tag。
- **并发只有 `concurrency` 能挡**。两个 tag 推得近，两个 run 同时 publish，后完成的会把 `latest` 覆盖回旧版本。

`node scripts/release.mjs check .` 仍然要做，但它是**发版前的自查**（打 tag 之前跑），不是发版动作。

这条流程由 `release:pipeline` 规则守着——workflow 丢了 tag 触发器、少了版本对账、少了 publish / Release 步骤、没有 concurrency group、**或者要一个存起来的 registry token**，检查就会红：

```powershell
node scripts/check-project.mjs --only release:pipeline
```

## 0. 先选分发形态

| 形态 | 怎么做 | 什么时候用 |
|---|---|---|
| **registry**（npm） | 推 `v*` 标签（CI 发） → `dsh plugin --profile <p> add <name>@<version>` | 要给别人装、要能按版本回滚 |
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

## 4. 发布（只有一条路径：推 tag）

**标准路径就是本文件开头那四行**——改版本、提交、打 tag、推 tag。没有别的。

`ship` 是**补救与离线路径**，不是日常发版：

```powershell
node scripts/release.mjs ship . --dry-run    # 看它要做什么
node scripts/release.mjs ship . --yes        # 真发；不可撤销，所以必须显式 --yes
```

什么时候才用它：CI 不可用、需要在一个没有 Actions 的环境里发、或者要**本地演练一遍**发布链路。用它发出去的包**没有 provenance**——这是它的代价，不是它的缺陷，但也不该是默认。

五步顺序是**在真实 registry 上撞出来的**，不是设计出来的（CI 用的是同一套语义）：

```
check -> pack -> publish -> release -> verify(advisory)
```

- **release 在 verify 之前**：0.1.1 和 0.1.2 都是发布成功、registry 还没传播时被自己的
  verify 判红，结果 GitHub Release 根本没建。产物不该被缓存速度挡住。
- **verify 是 advisory**：等 10 分钟，不可见只提示不失败。真要确认可安装，`npm i` 或
  `dsh plugin add` 一次比任何等待都准。
- **任何一步失败就停**，后面的步骤不会跑，也不会留下半个发布。

要单步执行或排查时，五条命令仍然在：

```powershell
node scripts/release.mjs publish . --yes      # 只发 npm
node scripts/release.mjs verify . --wait 600  # 只验传播
node scripts/release.mjs gh-release . --tarball tmp/release/<name>.tgz
node scripts/release.mjs market --write data/plugins/<owner>__<repo>.yml
```

**发哪个工具**：有 `npm` 用 `npm publish`；没有就用 DSH 运行时自带的 pnpm（很多安装就是这样）。两者都在 `resolvePublisher()` 里选，选不到就明确报错，而不是跑一半才失败。

**`verify` 不是可选项。** `npm publish` 打印 `+ name@version` 就返回了，那一刻包往往还装不上：有时 registry 里只有一个 `0.0.0-stage` 占位，有时 tarball 几分钟内 404。判断标准是产物不是提示——`dist-tags.latest` 等于你的版本**且** tarball 能下载。国内镜像可能更久，所以真实判据还是 `dsh plugin --profile <p> add <name>` 装一遍。

**`gh-release` 的资产名不带版本号。** 市场的 `tarball:` 字段常用 `releases/latest/download/`，那里 tag 在请求时解析、**文件名照字面取**——资产名里带版本号，你下一次发版它就成了 404。所以命令会把 tarball 复制成 `<name>.tgz` 再上传；要带版本号就钉住 tag（`--tag v1.2.0` + 版本化文件名）。

`private: true` 会直接挡住 `publish`，这是有意的：本地 bundle 分发不需要 registry。

## 4.5 CI 里那条流程长什么样

本仓库和**每个生成的插件包**都带一份 `.github/workflows/release.yml`，触发条件是 `push` 到 `v*` 标签：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

工作流做五件事，任何一步失败就不发：

| 步骤 | 判据 |
|---|---|
| 标签与版本一致 | `v1.2.0` 必须对应 `package.json` 的 `1.2.0`——防止打了 tag 忘了改版本 |
| 包是可安装的 | 有 `dsh.bundle.patch`；本仓库额外跑 `release check` 和全部 `scripts/try-*.mjs` 回归 |
| npm 版本够新 | trusted publishing 要求 npm ≥ 11.5.1，首步升到最新并校验 |
| 打包 | `npm pack`，然后复制成**不带版本号**的资产名 |
| 发 registry | `npm publish --provenance --access public`；`private: true` 时跳过 |
| 建 GitHub Release | `gh release create <tag> <asset> --generate-notes` |

两个刻意的设计：

- **资产名不带版本号**（`<name>.tgz`）。市场的 `tarball:` 常写 `releases/latest/download/<name>.tgz`，那里 tag 在请求时解析、文件名照字面取——带版本号下次发版就 404。
- **`private: true` 时跳过 registry 步骤**而不是报错。本地 bundle 用 GitHub Release 分发就够了，不该因为没配 npm 就发不出去。

### 不需要 npm token：OIDC trusted publishing

**仓库里不存任何 registry 凭据。** `npm publish` 运行时用这个 job 的 OIDC 身份，向 npm 换一张**短期**、而且只对「这个仓库 + 这个 workflow」有效的凭据。跑完即失效，所以不存在能泄露的长期密钥，也没有要轮换的东西。

这也是 `release:pipeline` 规则会查的：workflow 里出现 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 就报红，缺 `id-token: write` 也报红。

一次性设置（**每个包一次**）：npmjs.com → 这个包 → Settings → **Trusted Publisher** → GitHub Actions，填

| 字段 | 值 |
|---|---|
| Repository owner | `<owner>` |
| Repository name | `<repo>` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

**workflow 文件名绑在 publisher 配置里**——以后重命名 `release.yml`，必须同步去 npm 改，否则下次发版认证失败。

没配好之前，publish 那步会**直接认证失败**，不会静默成功。这是有意的：宁可发不出去，也不发一个来历不明的包。

什么时候才需要 token：用不了 OIDC 的时候（私有 registry、self-hosted runner）。那时才加 `NPM_TOKEN` secret，并接受它是长期有效的、需要轮换——能不用就别用。

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

## 6.5 手工发过之后怎么补救

已经绕过 CI 发过一次，按这四种情况处理：

| 情况 | 怎么办 |
|---|---|
| **包发了，`latest` 指错了** | `npm dist-tag add <name>@<ver> latest`。这一步需要登录 npm，CI 的 OIDC 票只覆盖 `publish`，覆盖不了 dist-tag |
| **版本号错了** | 改 `package.json` → 提交 → 打**新**标签。**不要移动旧标签**：标签一旦被消费（Release 已建、包已发），移动它会让「这个标签指向什么」变得不可信 |
| **CI 里 publish 说版本已存在** | 这个版本已经在 registry 上了。改 `package.json` 发新版本，不要重推同一个 tag |
| **发出去的包没有 provenance** | 无法补。下一代版本走 CI 就会有，已经发出的那一个改不了 |

`concurrency: group: release` 让所有发版串行，所以「两个 tag 一起推、`latest` 被覆盖」这类事故不会再发生——它是被串行化挡掉的，不是靠事后修。

## 7. 发布后对账

1. `dsh --profile <p> --dump-config`：那一行在，且没有诊断；
2. **新开**一个会话（已有会话保留创建时的组合）验证工具/技能/slot 真的出现；
3. 面板或数据面至少一处**与磁盘对上**（数字、条数、名字），不是「看着有东西」；
4. 版本号在 profile 里就是你发的那个版本。

## 8. 提交到插件市场

市场（`awesome-dsh-plugin`）的投稿是**一个 YAML 文件**，不是改 README：`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本从 `data/plugins/*.yml` 生成，手工编辑会撞别人的行。

条目**由包生成，不手写**：

```powershell
node scripts/release.mjs market                          # 打印条目
node scripts/release.mjs market --write data/plugins/<owner>__<repo>.yml
node scripts/market-entry.mjs --check                    # 按规则校验 + 问 gh 要仓库状态
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
