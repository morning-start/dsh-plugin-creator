---
name: dsh-plugin-npm
description: "把 DSH 插件发到 npm 上，以及发完之后怎么管：第一次发布怎么本地引导（scoped 包名、--access public、--provenance=false）、Trusted Publisher 怎么配/查/撤销（每包一份、2FA 只能真人过）、0.6.0 改名踩到的三处模块说明符、tag → CI → OIDC 的日常发版、`latest` 与预发布 dist-tag、发错了用 deprecate 不用 unpublish，以及 E403 / EUSAGE provenance / EOTP / 0.0.0-stage / 404 这些报错的真实含义。当你要「发版」「改名」「配 trusted publisher」「npm 上版本不对」「dist-tag 指错了」「撤销信任」「首次发布」「npm 报 403/404/需要 2FA」时用它；只改版本号、打包、沙盒演练走 `dsh_plugin_release` 工具，不需要这个技能。"
---

# DSH 插件的 npm 侧

工具（`dsh_plugin_release`）管到「改版本、就绪检查、打包、演练」为止。**再往上是账号与 registry 的事**：信任关系、凭据、名字、标签、弃用、对账——这个技能管这一段。

下面的每条判据都是在本仓库真实跑出来的，不是文档转述。

## 一、先看清自己在哪一段

| 你在哪 | 判据（只认产物） | 走哪 |
|---|---|---|
| 包名**在 npm 上还不存在** | `npm view <name>@<ver>` 报 404，且 registry 的版本端点也 404 | 「引导」——只能本地发一次 |
| 包已存在，要发新版 | registry 版本端点 200 | 打 tag，CI 用 OIDC 发 |
| 发了但别人装不到 | 版本端点 200 但**根文档** 404 | 等副本追平，别重发 |
| 只是要查/改信任 | —— | 「Trusted Publisher」 |

**判据只用 registry 的 JSON**：

```bash
curl -s https://registry.npmjs.org/<name>/<version> | jq '.version, ._npmUser'
```

本机 `npm view` 走的是 `.npmrc` 里的 registry（国内常被镜像接管），**它会骗人**：包已经发了，它还显示旧版本。

## 二、包名：scope 一旦加上，三处会断

本仓库 0.6.0 从 `dsh-plugin-creator` 改成 `@morning-start/dsh-plugin-creator`。改名不是改一行 `package.json`：

| 位置 | 为什么必须改 |
|---|---|
| `package.json` 的 `name` | 发布名 |
| `cordis.patch.yml` 的 `creator-host.name` | 宿主按这个名字解析 bundle 行 |
| `cordis.patch.yml` 的 `creator-tools.name` | **模块说明符**，`@scope/pkg/tools` |
| `cordis.patch.yml` 的 `createRequire(...).resolve('<pkg>/package.json')` | 同上，漏了 skill 目录就指空 |

后三处是**模块说明符**，不是注释：漏一处，包装得上但工具或 skill 加载不出来。

还要顺手 grep 一遍你自己仓库里的**断言**：`checks.json` 里常有 `package-name` 之类的规则，文档/技能里也有写着旧包名的命令示例。改名后先跑全量检查，让它告诉你漏了哪里：

```bash
node scripts/check-project.mjs . && node scripts/try-checks.mjs
```

**不用改的**（这些都是稳定标识，不是包身份）：

- 仓库 URL（仓库名没跟着变）
- 工具 id `dsh-plugin-creator/dsh_plugin_*`、沙箱 marker `dsh-plugin-creator/sandbox`
- 用户已存在的沙箱目录名（`.dsh-*` 那种）——改了旧沙箱就找不着了
- release 资产名——生成的 workflow 本来就剥 scope：
  ```bash
  asset=$(node -p "require('./package.json').name.replace(/^@[^/]+\//, '')")
  ```
  所以 `market.json` 里的 `releases/latest/download/<name>.tgz` 不受 scope 影响。

## 三、引导：新包名的第一次

Trusted Publisher 只能配在**已经存在**的包上，所以第一次绕不过本地：

```bash
npm login                       # 或环境变量里给 NODE_AUTH_TOKEN
node scripts/release.mjs check .

# scoped 包默认 private，必须显式 public；本地没有 OIDC，必须关掉自动 provenance
npm publish --access public --provenance=false
```

两条都是硬要求，少一条就发不出去：

- 不写 `--access public` → 403（scope 下默认私有）
- 不写 `--provenance=false` → `EUSAGE: Automatic provenance generation not supported for provider: null`

**代价要认**：这样发出来的版本 `_npmUser` 是你本人，**没有 provenance**，且补不回来。

## 四、Trusted Publisher：每包一份，2FA 只能真人

```bash
npm trust github <包名> --file release.yml --allow-publish --dry-run   # 先看
npm trust github <包名> --file release.yml --allow-publish             # 真配
npm trust list <包名>                                                  # 核对，记下返回的 id
npm trust revoke <包名> --id=<id>                                      # 轮换/改名时用
```

规则（逐条实测）：

- `--file` **只是文件名**，必须 `.yml`/`.yaml`；传路径报 `must be just a file not a path`；
- `--repo` **可省**，取自 `package.json` 的 `repository`（不是 git remote），清单里没写才必须给；
- **至少一个权限标志**：`--allow-publish` / `--allow-stage-publish`（别名 `--allow-staged-publish`）；
- 需要**账号 2FA + 对包有写权限**；
- **信任是 per-package 的**：改了名，新名字要**重新配一遍**，旧的信任不会跟过来；
- 成功后接口返回 **201**（不是 200）。判成功用 `201 / 200` 都算，别只认 200——这会把自己的成功误报成失败。

### 两个必踩的坑

**坑一：bypass-2FA 的 token 配不了信任。** CI 用的那种 `npm_` 开头、勾了 bypass 2FA 的 token：

```
E403  Granular access tokens that bypass two-factor authentication
      may not perform this action.
```

它连 `npm trust list` 都读不了。能改信任的只有：网页登录得到的**会话 token**，或不勾 bypass 的 granular token + 当场给码。

**坑二：非交互环境拿不到链接。** `npm trust` 的 2FA 走 `otplease`，第一行是：

```js
if (!process.stdin.isTTY || !process.stdout.isTTY) throw err
```

所以 agent / CI / 脚本里它会直接抛 `EOTP`，并把授权链接脱敏成 `auth/cli/***`。

| 环境 | 可行做法 |
|---|---|
| 你本人的真终端 | `npm trust ...`，它打印链接、等你按 ENTER |
| agent / 脚本 | 见下面「非交互环境怎么走完」——**链接是能拿到的** |
| 只想看会配成什么 | `--dry-run`，不需要 2FA |

**2FA 必须真人。** 安全密钥要插上触摸、指纹要按；程序注入的点击**不算**「用户激活」——页面停在原地，不报错，也不前进。真实记录：两轮注入点击各等 5 分钟超时，换成用户亲手点，同一秒就收到票据。

### 非交互环境怎么走完 2FA

脱敏发生在 **npm 的输出层**，registry 返回的响应体里 `authUrl` 和 `doneUrl` 是完整的。所以照 npm 内部做的三步自己发一遍就行：

1. `POST https://registry.npmjs.org/-/package/<escapedName>/trust`
   - 头：`authorization: Bearer <会话 token>`、`npm-auth-type: web`、`npm-command: trust`、`npm-session: <随机 uuid>`、`content-type: application/json`
   - 体：`[{"type":"github","claims":{"repository":"owner/repo","workflow_ref":{"file":"release.yml"}},"permissions":["createPackage"]}]`
2. 返回 `401` 时**响应体里就有完整 `authUrl`**：把它交给用户，他过 2FA；同时轮询 `doneUrl`
   （`202` 继续等，按 `retry-after`；`200` 拿到 `token`）
3. 带着票据重发第 1 步，加 `npm-otp: <ticket>`；`201` 即成功

三个细节，踩过才知道：

- **`npm-auth-type: web` 不能少**。缺这个头，会话 token 会被当成旧式凭据，直接回 `401 {"message":"Unauthorized"}`，**没有** `authUrl`——看起来像权限问题，其实是头不全。
- **scoped 包名要按 npa 的 `escapedName` 编码**：`@scope/name` → `@scope%2fname`。`encodeURIComponent` 会把 `@` 变成 `%40`，路由就不对。
- **`authUrl` 有效期很短**（分钟级）。等太久 `doneUrl` 会回 `404`，那一轮就废了，重新发一次第 1 步换新链接。

**核对信任时 `npm trust list` 同样要 2FA**，非交互环境一样走不通。改用探测：

```
不带 OTP 发一次第 1 步 → 200 表示已配好（幂等），401 表示还没配
```

## 五、日常发版：tag → CI → OIDC

```bash
node scripts/release.mjs version . patch    # 只改 package.json，不动 git
git add package.json && git commit -m "chore(release): X.Y.Z"
git tag vX.Y.Z && git push origin HEAD && git push origin vX.Y.Z
```

之后什么都不用跑。判断成功看 registry，不看 CI 的绿勾：

```bash
curl -s https://registry.npmjs.org/<name>/<version> | jq '{user: ._npmUser, att: .dist.attestations}'
# 走 OIDC 时应为：
# {"user":{"name":"GitHub Actions","trustedPublisher":{"oidcConfigId":"<trust list 里的 id>"}}, "att": {...}}
```

`oidcConfigId` 与 `npm trust list` 的 `id` 对得上，才是真的走了 OIDC。

**移动 tag 的唯一合法时机**：门禁阶段就红了、npm 上没有这个版本、Release 也没建——即「没被任何人拿到」。一旦发布过，只能打新版本。

## 六、版本与标签

- `latest` 是别人 `npm i <name>` 装到的那个。**只有真正的稳定版才推到 `latest`。**
- 预发用 `next`：`npm publish --tag next`，装的人要显式 `@next`。别自造 `beta1` 这类名字。
- 改现成版本的标签：`npm dist-tag add <name>@<ver> latest`。**这一步要登录，CI 的 OIDC 票只覆盖 publish**，覆盖不了 dist-tag。
- 一个版本号**只能发一次**。发出去就改不了，只能发新版本。

## 七、发错了怎么办

| 情况 | 做法 | 不要做 |
|---|---|---|
| 版本内容有错 | 发补丁版本 | `npm unpublish`——会打断所有锁了版本的依赖 |
| 版本不该被安装 | `npm deprecate <name>@<ver> "原因"` | 删包 |
| 改了包名 | 新名字发一版，旧名标弃用 | 以为 npm 支持改名（它不支持） |
| 信任配错了 | `npm trust revoke` 再重配 | 留着旧条目 |

`deprecate` 本该只是**声明**：装着的人仍能用，看到警告而已。**但在本账号上实测出了意外** ——

对旧包执行 `npm deprecate dsh-plugin-creator "Renamed to @morning-start/…"` 之后，整个包变成了墓碑：

```json
{"_id":"dsh-plugin-creator","name":"dsh-plugin-creator","time":{…},"_rev":"…"}   // 没有 versions / dist-tags
npm error 404 Unpublished on 2026-11-28T10:37:01.094Z
```

10 个版本全部 404，`time.modified` 与那次 deprecate 的时刻一致。**所以别把 deprecate 当成「安全无害」的动作**：它可能把整包带走。

- 动手前：确认这个包**还需要被别人安装**吗？不需要才做；需要就先只发新版本，弃用等确认没依赖了再说。
- 动手后：立刻查版本端点 `registry.npmjs.org/<pkg>/<ver>`，别只看根文档（它可能只剩墓碑）。
- 已经被下架：名字 24 小时内不能复用；用新名字继续发即可，已装的人不受影响。

## 八、报错反查

| 系统原文 | 真实原因 | 怎么办 |
|---|---|---|
| `E403 ... bypass two-factor authentication may not perform this action` | 用了 bypass-2FA token 改信任 | 网页会话，或浏览器表单 |
| `EUSAGE: Automatic provenance generation not supported for provider: null` | 本地发布却要生成 provenance | 加 `--provenance=false` |
| `404 Not Found - PUT .../<pkg>`（publish 时） | **不是包不存在**，是匿名发布 | 加 token，或配 Trusted Publisher |
| `cannot publish over the previously published versions` | 版本已在 registry | 改版本号发新的；别动旧 tag |
| `EOTP` + `auth/cli/***` | 非 TTY，npm 不给完整链接 | 真终端，或自己发一遍请求（见四） |
| 版本端点 200 但根文档 404 | registry 副本延迟 | 等；用版本端点核对 |
| `404 Unpublished on <日期>` | 包被整包下架（不是弃用） | 见七；新名字重发 |
| `0.0.0-stage` 占位出现 | npm 11 暂存发布的中转状态 | 等真版本落地，别重发 |
| `publish` 成功但 npm 上查不到 | 输出被管道吞了退出码（`npm publish \| tee`） | 看产物：版本端点 |

## 不要做

- 不要本地 `npm publish` 日常版本——没有 provenance，且版本与 tag 在推 tag 那一刻才对账。
- 不要把发布命令接进管道；`npm publish | tee log` 的退出码是 `tee` 的，失败也会「成功」。
- 不要随手 `deprecate` 一个还有人在装的包——本账号上它把整包带走过。
- 不要用 `unpublish` 修内容问题；用 `deprecate` + 新版本。
- 不要在镜像 registry 上配 Trusted Publisher（npm 会警告 `may not support trusted publishing`）。
- 不要只信 CI 的绿勾；看 registry 的 `_npmUser` 与 `attestations`。
- 不要移动一个**已经被消费**的 tag。
- 不要指望 `npm trust` 在非交互环境里能配成功——它连链接都给不出来。