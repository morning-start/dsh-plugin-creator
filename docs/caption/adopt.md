# 插件规范化（adopt）

## 契约

**任务**：给本项目加「把已有插件项目规范化」的能力——审计任意插件目录，只补齐确定性的标准件，不重写别人的代码。

**流程**：改代码（requirement → investigate → propose → **已批准** → execute → test gate → docs）。

**闸门**：`node scripts/try-adopt.mjs && node scripts/check-project.mjs .`（两个都退出 0 才算绿）

**验收标准**

1. 对 `dsh_plugin_new` 生成的项目跑 adopt：**零动作**，退出 0。
2. 对故意剥掉标准件的 fixture 跑 adopt：auto 动作全部命中；**第二遍零动作**。
3. 工作区脏时拒绝执行；`--dry-run` 不写任何文件。
4. 规范化后 `check-project` 与 `release check` 全绿。
5. 已存在的文件**逐字节不变**（不覆盖）。

**已批准的设计**：audit → plan（auto / decide / manual）→ apply，只做 auto；动作 = `add-repository`、`add-ci-workflow`、`add-checks-json`、`append-gitignore`、`add-market-json`、`report-patch-drift`。

**明确不做**：不改用户其他 manifest 字段、不重排代码、不猜预设归属、无 git 不动手。

## 1. 摸清现有检查器的形状

- Saw: 需要复用已有检查而不是另写一套。
- Decided: 先确认 `inspectBundle` / `runRules` / `check-project` 的调用形状，再写 audit 层。
- Did: 读三个文件的导出与规则分支。
- Evidence: `Select-String ... lib\bundle-check.js|lib\rules.js|scripts\check-project.mjs` → `inspectBundle` 为 async；规则 12 种；check-project 走 checks.json。
- Outcome: done

## 2. 写 lib/adopt.js + CLI

- Saw: 形状已摸清，可以直接复用。
- Decided: 按已批准设计写 audit → plan → apply；起手 `checks.json` 只收「项目当前已通过」的规则。
- Did: 新建 `lib/adopt.js`、`scripts/adopt.mjs`（默认只出计划）。
- Evidence: `node scripts/adopt.mjs . --force` → 本仓库 `nothing to add`，仅 `manual patch:drift`；剥掉标准件的 fixture → `add-ci-workflow` + `add-checks-json`。
- 死路: `runRules` 返回对象不是数组，`results.filter` 抛 TypeError；改成解构 `{ checks }`。
- Outcome: done

## 3. try-adopt.mjs：28 项，守卫被证伪过

- Saw: 手工 smoke 只证明「能跑」，没证明「不会写错」。
- Decided: 写正式套件覆盖五条验收标准；对「不覆盖」造竞态用例（计划后文件才出现），否则跳过分支永远走不到。
- Did: 新建 `scripts/try-adopt.mjs`；修正：custom fixture 写文件后要提交、`loose` fixture 放到仓库外临时目录、补竞态用例。
- Evidence: 把跳过条件改成 `false &&` → `FAIL a file that appeared after planning is skipped` + `FAIL and left byte-identical`；恢复后 `adopt ok`，exit 0。
- Outcome: done

## 4. 修掉自己标出的真问题：manifest 被整体重排

- Saw: `add-repository` 用 `JSON.stringify(manifest, null, 2)` 重写 `package.json`——用户写过的格式、键序、单行写法全被改掉，违反「不改用户写过的 manifest 字段」。
- Decided: 改成**插入式**：定位最后一个 `}`，按文件自身缩进插入一个字段，其余字节不动。
- Did: 加 `insertField()`；加 4 项格式测试（4 空格缩进保留、原文是新文件前缀、只多一个键、仍可解析）。
- Evidence: `try-adopt` → `ok the 4-space indent survives` / `ok the original text is still a prefix of the new file` / `ok the added field is the only new key` / `ok the result still parses`。
- Outcome: done

## 5. 接进闸门与文档

- Saw: 新能力不接进 CI 就没人跑它。
- Decided: package.json 加 `check:adopt` / `adopt`，CI 套件循环加 `try-adopt`，写 `docs/ADOPT.md`，README 加能力段与结构行，TOOLS.md 加一行。
- Did: 改六处；改完 `check-project` 立刻报 `contract:ci-template` 漂移。
- Evidence: `check-project . --only contract:ci-template --update` → 1 pass；全量 → 6 pass, 0 warn, 0 fail；八套回归逐个 `ok`。
- Outcome: done

## 未验证

- `dsh_plugin_adopt` **工具入口没做**：按批准范围只做 CLI，先在真实项目上跑一遍再决定。
- 没在第三方真实插件（如 `dsh-myteam`）上跑过 `--apply`；fixture 都是构造的。
- `templates/adopt/` 没建：五条动作都是代码生成，没引入新模板。
- `--json` 输出没被任何测试断言（只手工看过）。

## 6. 在真实项目上跑一遍（dsh-myteam）

- Saw: 批准了「拿真实项目跑 dry-run」。`dsh-myteam` 根目录没有 `package.json`——插件在 `plugin/` 子目录里（monorepo 形状）。
- Decided: 对 `dsh-myteam/plugin` 出计划；先只读，不写。
- Did: `node scripts/adopt.mjs E:\Workplace\extension\dsh-myteam\plugin`。
- Evidence: `bundle: 18 pass, 1 warn, 0 fail`；计划四条——`add-repository`（`git+https://github.com/morning-start/dsh-myteam.git`，与 `git remote get-url origin` 一致）、`add-ci-workflow`、`append-gitignore`（只加 `tmp/`，`node_modules/` 已在）、`add-market-json`（草稿是一句真实描述）；**`add-checks-json` 正确地没有出现**——它已有自己的 `checks.json`；`manual patch:drift` 一条；工作区 20 个未提交路径 → 正确拒绝写入。
- Outcome: done（关键证据：它没有动别人的 checks.json）

## 7. 修真实项目暴露的缺陷：非包目录抛 ENOENT

- Saw: 指向 `dsh-myteam` 根目录时抛原始 `ENOENT ... package.json`，栈直接打给用户。
- Decided: 换成明确拒绝，并提示 monorepo 的插件通常在子目录。
- Did: `auditProject` 前置 `existsSync`；CLI 捕获后打印一行并 exit 1；加 2 项测试。
- Evidence: `node scripts/adopt.mjs E:\Workplace\extension\dsh-myteam` → `adopt: not a plugin package: ... has no package.json (a monorepo's plugin usually lives in a subdirectory such as plugin/)`；`try-adopt` → `ok a directory without package.json is refused clearly` / `ok the message names the monorepo case`。
- 死路: 第一次写的正则被模板转义成 `/no package\\\\.json/`，匹配不到；改成单反斜杠后通过。
- Outcome: done

## 9. 用真实项目的副本验 --apply（不碰别人的项目）

- Saw: 未验证清单里挂着「没真正 --apply 过」。myteam 工作区是脏的，而按纪律不能改别人的项目。
- Decided: 拿 myteam 的**一次性 git 克隆**当靶子——不是它的工作区，验完即删。这样既真实（monorepo、真实 checks.json、18 项 bundle 检查）又不碰任何人。
- Did: `git clone` 到 `tmp/adopt-e2e/myteam`；重置行尾、把 origin 指回 GitHub（本地克隆的 remote 是路径，推不出 repository 字段）；`adopt --apply`。
- Evidence: 三条动作落地（repository / CI / .gitignore）；`package.json` 的 diff 是**插入**（`+6 -1`，只多 repository 块），不是重排；`git status` 只显示 `M plugin/.gitignore`、`M plugin/package.json`、`?? plugin/.github/`——**checks.json 没被碰**。
- Outcome: dead end（第一次）→ 见下一条

## 10. 副本抓到的真 bug：规范化把项目弄红了

- Saw: 副本跑自己的规则 → `6 pass, 0 warn, 1 fail: bundle:files-listed: not covered by package.json "files": market.json`。给 `checks.json` 定的原则（不能把项目变红）没用在 `market.json` 上。
- Decided: 加 pre-flight——写根文件之前，先看项目自己的 `files-listed` 规则会不会拒它；会拒就降级成 decide 并说明理由，不写。
- Did: 加 `rootFileConflict()`；先用在 `add-market-json`，跑测试发现 **CI workflow 同样会红**（`.github/workflows/release.yml` 也没在白名单里），于是同样用在 `add-ci-workflow`。
- Evidence: 副本上 `decide market:files-listed ...`；apply 后副本自己的规则 **7 pass, 0 warn, 0 fail**；`try-adopt` 新增 3 项（不计划 market.json / 变成带理由的 decision / 之后项目规则仍绿）。
- 死路: 第一版测试夹具的 `files` 为空，项目**在 adopt 之前就是红的**，断言没意义；改成先让夹具绿（files 覆盖它实际有的文件）。
- Outcome: done

## 未验证（更新）

- `dsh_plugin_adopt` 工具入口仍未做。
- 副本只验了 myteam 一个项目；没验「项目已有 market.json 但内容过期」这类路径。
- 真实 owner 在自己项目里跑 `--apply` 之后 `git diff` 的观感，没有第三方反馈。
