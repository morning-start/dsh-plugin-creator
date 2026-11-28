# 发版流程

发版这件事只有两个问题：**包里到底是什么**，和**装上会不会把别人的宿主搞坏**。这个文件按顺序回答，并给出每一步的判据。

## 唯一的发版方式：打 tag，交给 CI

**不要手打 `npm publish`，不要手建 GitHub Release。** 发版只有一个动作：推一个 `v*` 标签。

> **唯一的例外是第一次发布**——见下面 [引导：第一次发布](#引导第一次发布只能本地发一次)。Trusted Publisher 只能配在**已经存在**的包上，所以新包必须先本地发一次。

```powershell
# 1. 改版本号——这是唯一需要手改 package.json 的地方，也可以用工具改
dsh_plugin_release { action: 'version', path: '.', part: 'patch' }
#    （等价于手改 package.json 的 version；工具会顺带打印下面三条命令）

git add package.json
git commit -m "chore(release): 0.5.0"

# 2. 打 tag，3. 推代码 + 推 tag——推 tag 这一下就是发版
git tag v0.5.0
git push origin main
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
| Publish to the registry | `npm publish --provenance`；凭据**有 `NPM_TOKEN` 就用它、没有走 OIDC**，步骤不会被跳过；版本已存在则失败并说明下一步 |
| Create the GitHub Release | `gh release create`；已存在就跳过 |
| Registry propagation | advisory，registry 慢不撤销已经发生的发布 |

**为什么必须是 CI**：

- **provenance 只有 CI 有**。`npm publish --provenance` 用 OIDC 身份证明「这个包是从哪个仓库、哪次提交构建的」。本地发版没有这个身份，签名是空的——**引导那一次是唯一的例外，它发出的版本没有 provenance，补不回来**。
- **凭据二选一，缺一个不会静默**。有 `NPM_TOKEN` 就用它（任何账号都能立刻发），没有就用 OIDC 换一张短期票（仓库里没有长期密钥）。**发布步骤不会被「没 token」跳过**——那是最坏的结果：一路绿灯，却没有版本发出去。
- **版本↔标签只在推标签那一刻对账**。本地永远不知道你要打什么 tag。
- **并发只有 `concurrency` 能挡**。两个 tag 推得近，两个 run 同时 publish，后完成的会把 `latest` 覆盖回旧版本。

`node scripts/release.mjs check .` 仍然要做，但它是**发版前的自查**（打 tag 之前跑），不是发版动作。

这条流程由 `release:pipeline` 规则守着——workflow 丢了 tag 触发器、少了版本对账、少了 publish / Release 步骤、没有 concurrency group、**或者要一个存起来的 registry token**，检查就会红：

```powershell
node scripts/check-project.mjs --only release:pipeline
```

### 引导：第一次发布只能本地发一次

**不是所有项目都直接跳到 CI。** npm 的 Trusted Publisher 配在**一个已经存在的包**上——包还没发过，Settings 里就没有那一栏可配。所以全新包必须先本地发一次，拿到「这个包存在」这个前提：

```powershell
# 一次性：本机要有 npm 登录，或环境变量里有 NPM_TOKEN（只这一次需要）
npm login                                            # 或 $env:NODE_AUTH_TOKEN = '<token>'

node scripts/release.mjs check .                     # 发之前先自查
node scripts/release.mjs publish . --yes             # 本地发，没有 provenance（这一步无法避免）

# 然后去 npmjs.com → 该包 → Settings → Trusted Publisher → GitHub Actions
#   Repository owner / name 填好，Workflow filename 填 release.yml，Environment 留空
```

配好之后可选两件事之一，两条路都对：

- **留着 `NPM_TOKEN`**：CI 每次都用它发，稳定、任何账号都能用；代价是这个长期密钥要记得轮换。
- **删掉 `NPM_TOKEN`**：CI 自动切到 OIDC，仓库里不再有长期密钥；代价是依赖上面那次 Trusted Publisher 配置。

**缺 token 不会让发布被跳过**——工作流的发布步骤无条件执行，在步骤内部选凭据。

| 前提 | 谁来提供 | 之后还要吗 |
|---|---|---|
| 包名已在 npm 上存在 | 第一次本地 `publish`（要 token） | 不需要，包已存在 |
| 发布凭据 | 第一次：本机 token；之后：**有 `NPM_TOKEN` 就用它，没有用 CI 的 OIDC** | 两者之一即可 |
| `release.yml` 的存在与形状 | 生成的插件项目自带 | 一直需要，`release:pipeline` 规则守着 |

**判断自己走到哪一步了**：`npm view <name> version` 有输出 → 包已存在，可以只走 tag；报 404 → 还没引导过，先本地发一次。

这条也是 `ship` / `publish` 存在的理由：它们是**引导工具**，不是日常发版方式。日常只有 tag。

## 0. 先选分发形态

| 形态 | 怎么做 | 什么时候用 |
|---|---|---|
| **registry**（npm） | 推 `v*` 标签（CI 发） → `dsh plugin --profile <p> add <name>@<version>` | 要给别人装、要能按版本回滚 |
| **tarball**（本地/内网分发） | `pnpm pack` → `dsh plugin --profile <p> add <file>.tgz` | 私有分发、还没准备好公开发布 |
| **link**（源码目录） | `dsh plugin --profile <p> add link:<目录>` | **开发态**，不是发版；改了源码重启即生效 |

`link:` 不是发版——它把宿主绑在你的工作目录上。真正发版必须落到前两种之一。

### 先把仓库放到 GitHub 上

CI 发版跑在 GitHub 上，所以前两种形态都先要有一个仓库。这一步也是工具化的（`dsh_repo`）：

```powershell
node scripts/repo.mjs plan .          # 只读：打印它将会跑的 gh 命令
node scripts/repo.mjs create . --owner <owner>   # 还没有 origin：建仓库 + 首次推送
node scripts/repo.mjs update .        # 已经有 origin：只对齐可见性 / topic / repository 字段
```

两个默认值是这个仓库的约定：**公开**、带 **`dsh-plugin` topic**——市场的发现靠这个 topic，默认 private 等于让插件找不到。

`update` **不推送**：它只把 `package.json` 的 `repository` 对齐成单独一个提交，推不推你决定。已经对齐时它什么都不做。

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

`ship` 是**引导与补救路径**，不是日常发版：

```powershell
node scripts/release.mjs ship . --dry-run    # 看它要做什么
node scripts/release.mjs ship . --yes        # 真发；不可撤销，所以必须显式 --yes
```

什么时候才用它：**全新包名的第一次发布**（必须先本地发，才能配 Trusted Publisher）、CI 不可用、需要在一个没有 Actions 的环境里发、或者要**本地演练一遍**发布链路。用它发出去的包**没有 provenance**——这是它的代价，不是它的缺陷，但也不该是默认。

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

### 凭据：有 token 就用 token，没有就走 OIDC

workflow 里的发布步骤**无条件执行**，在步骤内部按顺序挑凭据：

| 顺序 | 凭据 | 什么时候用 | 代价 |
|---|---|---|---|
| 1 | `NPM_TOKEN` secret | 仓库配了这个 secret 就用它 | 长期有效，要记得轮换 |
| 2 | OIDC trusted publishing | 没有 secret 时用这个，不需要任何长期密钥 | 要先去 npm 上给这个包配一次 Trusted Publisher |

**缺 token 不会跳过发布。** 这是有意的：早先的版本把步骤写成 `if: env.NPM_TOKEN != ''`，结果是「没配 secret 的仓库静默地不发版，而且一路绿灯」——这比发版失败糟糕得多。`release:pipeline` 规则专门查这一条：把发布步骤挂在 token 上就报红。

两种都支持，但**报错要分清**：认证失败会提示去配 Trusted Publisher 或加 token；「版本已存在」会提示 bump 版本打新 tag。两条建议不该混在一起——往错误的方向修一遍，比不知道原因还费时间。

OIDC 那条路的一次性设置（**每个包一次**）：npmjs.com → 这个包 → Settings → **Trusted Publisher** → GitHub Actions，填

| 字段 | 值 |
|---|---|
| Repository owner | `<owner>` |
| Repository name | `<repo>` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

**workflow 文件名绑在 publisher 配置里**——以后重命名 `release.yml`，必须同步去 npm 改，否则下次发版认证失败。

**没配好之前，tokenless 发布是直接认证失败**，不会静默成功。配了 token 就绕开这个前提——这也是它作为第一顺位的原因：新包、新账号、临时环境都能立刻发。

配信任用 CLI 就行（比去网页点表单可靠，且能写进脚本）：

```bash
npm trust github <包名> --file release.yml --allow-publish \
  --registry https://registry.npmjs.org --dry-run   # 先看，再去掉 --dry-run
npm trust list <包名>          # 核对
npm trust revoke <包名> --id=<id>   # 轮换/改名时用
```

账号与 registry 那一侧的判断（信任关系、token 与 OIDC 的取舍、dist-tag、`deprecate` 代替 `unpublish`、各种 npm 报错的原因）在 [`skills/dsh-plugin-npm/SKILL.md`](../skills/dsh-plugin-npm/SKILL.md)。

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
| **CI 在门禁阶段就红了，什么都没发出去** | 这种情况可以移动 tag：改完重新 `git tag -f vX.Y.Z <commit>` 再强推。**判据是「有没有被消费」**——npm 上没有这个版本、Release 也没建，就还没被任何人拿到 |
| **发出去的包没有 provenance** | 无法补。下一代版本走 CI 就会有，已经发出的那一个改不了 |

**移动 tag 的唯一合法时机**就是上面第三行：门禁失败、产物为零。一旦 npm 上有了这个版本、或 Release 已建，标签就被消费了——那时它指向什么已经是别人下载的依据，只能打新版本。

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
