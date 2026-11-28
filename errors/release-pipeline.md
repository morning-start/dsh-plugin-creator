---
id: release-pipeline
name: 发版没走 CI
title: 手工发版绕过 tag 驱动，版本、provenance 与 Release 三者对不上
cause: 不走 tag 而是本地 npm publish；或 workflow 丢了 tag 触发器、版本对账、Release 步骤、concurrency group
since: 0.2.0
applies-to: [plugin]
severity: broken
matches:
  - "does not match package.json version"
  - "publish over the previously published versions"
  - "a release with the same tag name already exists"
  - "ENEEDAUTH"
location: .github/workflows/release.yml 的触发器与步骤；以及任何本地手工 npm publish
consequence: 本地推的包没有 provenance；版本号与 tag 不一致没人拦；两个人同时发版会抢同一个版本号
fix: 只走 tag——改 package.json 版本 → 提交 → git tag vX.Y.Z → git push origin vX.Y.Z，其余交给 CI
check: release-pipeline
---

# 发版只走 tag

## 固定的流程

```powershell
# 1. 改版本号（唯一需要手改的地方）
node -e "const p=require('./package.json');p.version='0.5.0';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
git add package.json
git commit -m "chore(release): 0.5.0"

# 2. 打 tag 并推送——这一下就是发版
git tag v0.5.0
git push origin main
git push origin v0.5.0
```

推送 tag 之后 CI 依次做：**check → pack → publish → release → verify**，任何一步失败就停，不会留下半个发布。

`workflow_dispatch` 是**补救入口**，不是日常路径——它按分支 ref 跑，版本↔tag 校验会直接失败。

## 什么时候会踩

只在**有人不走 tag** 的时候：

- 本地 `npm publish`，然后补 tag —— 包**没有 provenance**，且本地那次 `publish` 成功后退不回去；
- 改完版本忘了打 tag，或者 tag 写错号 —— CI 里 `The tag must match package.json` 那步会红，但**只有推了 tag 才发现**；
- 两个 tag 一起推 —— 两个 Release run 并发，后完成的那个把 `latest` 覆盖回旧版本（真实事故：0.2.0 覆盖了 0.3.0）；
- workflow 被改坏：丢了 `push: tags` 触发器、丢了版本对账步、丢了 `gh release create` —— 界面看起来一切正常，只是**发版这件事再也不会自己发生**。

## 原理：为什么这些都不报

手工路径上没有任何东西是「错」的：`npm publish` 退出码 0，`gh release create` 也 0。问题出在**它们不该由人触发**：

- **provenance 只在 CI 里有**：`npm publish --provenance` 用 OIDC 身份向 registry 证明「这个包是从哪个仓库、哪次提交构建的」。本地发版没有这个身份，签名就是空的。
- **版本↔tag 只在推 tag 那一刻对账**：本地永远不知道你要打什么 tag。`release check` 的 `release:tag` 只有在 HEAD 已经有 tag 时才比，所以 `git tag` 之前跑它永远是「无 tag 可对」。
- **并发只有 concurrency group 能挡**：两个 tag 推得近，两个 job 同时 `npm publish`，一个拿到 `latest`，另一个要么 E403 要么把 `latest` 改回去。

## 查到之后确认什么

看仓库到底有没有一条能跑的 pipeline：

```powershell
node scripts/check-project.mjs --only release:pipeline
```

它查五件事：**tag 触发**、**tag 与 package.json 对账**、**registry 发布**、**GitHub Release**、**concurrency group**。少一样就红。

再确认远端真的跑起来了：

```powershell
gh run list --repo <owner>/<repo> --workflow release.yml --limit 3
gh run view --job=<id> --repo <owner>/<repo>
```

`Publish to the registry` 那步的日志里应当出现 `publishing ... with tag latest` 和 `Signed provenance statement`。

## 怎么修

**workflow 缺东西**：从 `templates/bundle/github-release.yml.tpl` 复制一份——它和本仓库的 `.github/workflows/release.yml` 由 `gen-ci-template.mjs` 对账，不会漂移。

**已经手工发过一个版本**：不要重发同一个版本号（E403）。改 `latest` 指向正确版本即可，这一步也由 CI 做：

```powershell
gh workflow run release.yml --ref vX.Y.Z    # 需要先让 tag 指向含幂等修复的提交
```

重新 publish 会命中「版本已存在」，workflow 里那一步会退化成 `npm dist-tag add <pkg>@<ver> latest`，把 `latest` 摆正后继续建 Release。

**版本已经错了**：改 `package.json` → 提交 → 打**新** tag。不要移动旧 tag：tag 一旦被消费（Release 已建、包已发），移动它只会让「tag 指向什么」变得不可信。

## 和 `docs/RELEASE.md` 的分工

这条卡片只管**「发版有没有走 CI」**。至于 `check` / `pack` / `rehearse` 各自查什么、`ship` 的五步顺序为什么是这个顺序、`gh-release` 的资产名为什么不带版本号——那是 `docs/RELEASE.md` 的内容。

`node scripts/release.mjs check .` 仍然有用：它在**打 tag 之前**告诉你这个包发出去会不会炸。但它是**发版前的自查**，不是发版动作。