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
