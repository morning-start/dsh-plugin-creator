---
name: npm-package-manager
description: "管一个 npm 包的账号与 registry 那一侧：第一次发布怎么引导（本机 token 本地发一次）、Trusted Publisher 怎么配/查/撤销（npm trust github / list / revoke）、token 与 OIDC 谁优先、`latest` 与预发布的 dist-tag 怎么放、发完怎么对账、发错了怎么弃用而不是 unpublish，以及 E404 / E403 / ENEEDAUTH / 镜像警告这些报错各是什么原因。当你要「发版」「配 trusted publisher」「npm 上版本不对」「dist-tag 指错了」「撤销信任」「deprecate」「首次发布」「npm 报 404/403/需要 OTP」时用它——不限 DSH 插件，任何 npm 包都适用；只改版本、打包、沙盒演练这类机械步骤走项目自己的发布工具，不需要这个技能。"
---

# npm 包管理

这个技能管的是**账号与 registry 那一侧**的事：信任关系、凭据、标签、弃用、对账。**与具体项目无关**——DSH 插件、普通库、CLI 都一样。

**机械步骤不在这里面**：改版本、就绪检查、打包、演练是项目自己发布工具的事（在 DSH 插件项目里是 `dsh_plugin_release` 的 `version` / `check` / `pack` / `rehearse`，外加 `docs/RELEASE.md`）。这里只写工具不该编码的判断。

## 第一条：先分清自己在哪一段

| 你在哪 | 判据 | 走哪 |
|---|---|---|
| 包名**在 npm 上还不存在** | `npm view <name> version` 报 404 | 下面「引导」——必须本地发一次 |
| 包已存在，要发新版 | 上面有输出 | 打 tag，CI 发；不要本地 publish |
| 版本发了但不对 | `npm view <name>@<ver>` 与预期不符 | 「发错了怎么办」 |
| 只是要查/改信任关系 | —— | 「Trusted Publisher」 |

**判断包存不存在只用 `npm view`，不要凭记忆。**

## 引导：新包名的第一次发布

Trusted Publisher 只能配在**已经存在**的包上，所以新包绕不过本地一次：

```bash
npm login                      # 或环境变量里给 NODE_AUTH_TOKEN
# 先跑项目自己的发版前自查；在 DSH 插件项目里是：
node scripts/release.mjs check .
node scripts/release.mjs publish . --yes    # 没有 provenance，这一步无法避免
# 其它项目：npm publish --access public
```

之后配信任（见下），再决定 token 留不留：**留着就一直用它发，删掉就切 OIDC**，两条都行。

## Trusted Publisher

四条命令，全部要**官方 registry**：

```bash
npm trust github <包名> --file release.yml --allow-publish --dry-run   # 先看
npm trust github <包名> --file release.yml --allow-publish             # 真配
npm trust list <包名>                                                  # 核对已配的
npm trust revoke <包名> --id=<trust-id>                                # 撤销（轮换用这个）
```

规则（都实测过）：

- `--file` **只是文件名**，必须 `.yml` / `.yaml`——传路径报 `workflow must be just a file not a path`；
- `--repo` **可省**，省略时取 `package.json` 的 `repository`（不是 git remote）；清单里没写就必须显式给；
- **至少一个权限标志**：`--allow-publish`（直接发）或 `--allow-stage-publish`（分阶段发，别名 `--allow-staged-publish`），两个可同时加；
- 需要**账号 2FA 且对该包有写权限**；
- 另有 `npm trust gitlab` / `npm trust circleci` 子命令，权限标志是同一套。

### 2FA 这一步：谁能做、在哪做

**先看自己的 token 类型。** CI 里那种 `npm_` 开头、勾了 bypass 2FA 的 token **配不了信任**：

```
E403  Granular access tokens that bypass two-factor authentication
      may not perform this action.
```

它连 `npm trust list` 都读不了。能改信任的只有两类：网页登录得到的会话 token，或不勾 bypass 的 granular token + 当场给码。

**再看自己有没有终端。** `npm trust` 的 2FA 步骤走 `otplease`，第一件事就是：

```js
if (!process.stdin.isTTY || !process.stdout.isTTY) throw err
```

非 TTY 时它直接抛 `EOTP`，而且**授权链接被 npm 的输出层脱敏成 `auth/cli/***`**——registry 返回的原文里有完整链接，但 npm 不显示。所以：

| 环境 | 可行做法 |
|---|---|
| 你本人的真终端 | 直接 `npm trust ...`，它会打印链接并要求按 ENTER 开浏览器 |
| agent / 脚本 / CI | `--dry-run` 看配置对不对，然后**用浏览器表单** |
| 浏览器表单 | npmjs.com → 这个包 → Settings → Trusted Publisher → 填 owner / repo / `release.yml` / 环境留空 / 勾 Allow publish |

**2FA 必须真人做。** 安全密钥要插上触摸、指纹要按；程序注入的点击**不算**「用户激活」，页面会停在原地不动，也不报错。

配完用 `npm trust list <包名>` 核对，记下返回的 `id`——**发布后能在 registry 上对账**：`_npmUser.trustedPublisher.oidcConfigId` 就是这个 id，对得上才算真走了 OIDC。

```bash
# 对账（不看本机 npm 缓存，直接问 registry）
curl -s https://registry.npmjs.org/<包名> | jq '.versions["<版本>"]._npmUser'
# → {"name":"GitHub Actions", "trustedPublisher":{"oidcConfigId":"<那个 id>"}}
```

**镜像会坏事。** 本机 `.npmrc` 常指向镜像，npm 会警告 `may not support trusted publishing`，然后对镜像配信任。必须显式：

```bash
--registry https://registry.npmjs.org
```

`workflow 文件名绑在信任关系里`——以后重命名 `release.yml`，必须 `revoke` 旧的、配新的，否则发版认证失败。

## 凭据：有 token 用 token，没有走 OIDC

| | token | OIDC |
|---|---|---|
| 什么时候用 | 仓库配了 `NPM_TOKEN` | 没配 secret |
| 优点 | 任何账号立刻可用 | 没有长期密钥要轮换 |
| 代价 | 长期有效，要记得换 | 依赖那次 `npm trust` 配置 |

**永远不要让发布步骤因为「没 token」被跳过**——那会一路绿灯却没有版本发出去。这个坑真的踩过。

## 版本与 dist-tag

- `latest` 是别人 `npm i <name>` 装到的那个。**只有真正的稳定版才推到 `latest`。**
- 预发版用 `next`：`npm publish --tag next`，装的人要显式 `@next`。别用 `beta`/`rc` 之外的自造名字——生态里没人会去猜。
- 改现成版本的标签：`npm dist-tag add <name>@<ver> latest`。**这一步需要登录，CI 的 OIDC 票只覆盖 `publish`**，覆盖不了 dist-tag。
- 一个版本号**只能发一次**。发出去就改不了，只能发新版本。

## 发错了怎么办

| 情况 | 做法 | 不要做 |
|---|---|---|
| 版本内容有错 | 发一个补丁版本 | `npm unpublish`——24 小时后基本不可用，且会打断所有锁了版本的依赖 |
| 版本不该被安装 | `npm deprecate <name>@<ver> "原因"` | 删包 |
| 信任配错了 | `npm trust revoke` 再重配 | 留着旧条目 |
| 发错标签 | `npm dist-tag add` 摆正 | 重新 publish 同一个版本（E403） |

`deprecate` 是**声明**：装了的人仍能装，但会看到警告。这正是它比删除好的地方。

## 报错反查

| 系统原文 | 真实原因 | 怎么办 |
|---|---|---|
| `404 Not Found - PUT https://registry.npmjs.org/<pkg>` | 不是包不存在，是**匿名发布**：没有凭据，也没有配 Trusted Publisher | 加 token，或 `npm trust` 配一次 |
| `cannot publish over the previously published versions` | 这个版本已经在 registry 上 | 改版本号发新的；不要动旧 tag |
| `ENEEDAUTH` | 没登录，或 `.npmrc` 里的 token 没被带上 | `npm login` / 传 `NODE_AUTH_TOKEN` |
| `EOTP` / `one-time password` | 账号开了 2FA 且 CLI 没带 OTP | `--otp=<code>`，或改用 token/OIDC |
| `may not support trusted publishing` | registry 指向镜像 | 加 `--registry https://registry.npmjs.org` |
| `publish` 成功但 npm 上查不到 | 输出被管道吞了退出码（`npm publish \| tee`） | 看产物：`npm view <name>@<ver>` |

**最后一条最值得记**：`npm publish | tee log` 的退出码是 `tee` 的，发布失败也会「成功」。判断发没发出去只看 `npm view`。

## 发完对账（三句话）

```bash
npm view <name> dist-tags --json     # latest 是不是你刚发的
npm view <name>@<ver> version        # 这个版本真的存在
npm view <name>@<ver> dist.attestations   # 有没有 provenance
```

CI 发出来的包应当**有** provenance；本地引导那一次没有，且补不回来。

## 不要做

- 不要本地 `npm publish` 日常版本——没有 provenance，且版本↔标签只在推标签那一刻对账。
- 不要 `unpublish`；用 `deprecate`。
- 不要把已发布版本重新发一遍（E403）；改版本号。
- 不要在镜像 registry 上配 Trusted Publisher。
- 不要只信「Publish 步骤打勾」；看 `npm view` 的产物。
- 不要移动一个**已经被消费**的 tag（npm 上有版本、或 Release 已建）——那会让「tag 指向什么」不可信。