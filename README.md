# dsh-plugin-powerful

A plugin-development toolkit for DeepSeek Harness (DSH). Installing it extends **Creator mode (创造模式, the `cordis` preset)** and nothing else; removing it takes everything back out.

## What this project is

An agent-era scaffolding toolkit for DSH plugins. A plugin's life runs **构思 → 项目启动 → 规范化开发与检查 → 功能测试 → 集成测试 → 发版**; this package makes the mechanical parts of that cycle stable and fast, and leaves the judgment to skills and conversation.

Where it stands today, stated plainly: **project start**, **functional testing**, **client UI checks**, and **release checks** are in place; **normalized checks** (lint, architecture, contracts, doc links) are half-built. The gap list is deliberate — it is the roadmap.

The first design rule: **Creator mode's own tools are this plugin's foundation.** Before adding anything, read what the preset already ships (`dsh --profile <p> --dump-config`, `cordis_inspect_*`) instead of re-implementing it. Installing and enabling is `plugin_manager`'s job; runtime truth comes from Inspect, not from reading source; anything that is judgment belongs in a skill. The full statement — the six-stage capability table with its gaps, the 32 shipped plugins grouped by what each means for the design, and the four design principles — is in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) (Chinese).

## What it gives you

Capabilities, not a feature list. Which tool implements which capability — with its parameters, actions, and limits — is in [docs/TOOLS.md](docs/TOOLS.md).

**Start a plugin from a standard template.** One call produces the manifest, the bundle patch, the entry module, locale dictionaries, an icon, a README, and optionally an example tool and a skill. Deterministic: the same input always produces the same files. It validates its own output before returning, so the structural report arrives in the same turn as the plugin.

**Know why a package will not install or will not show up.** A read-only structural check reports every problem it finds instead of throwing on the first one: manifest fields, the declared bundle patch, exported locale and icon resources, the entry module, the declared detail document, the packaging whitelist. Each check is pass / warn / fail.

**Keep a plugin under development out of the environment you work in.** Installing from a local directory is refused, with three deliberate exceptions: a published version, a host that is itself a sandbox, or an explicit decision by the user. The risk is asymmetric — a broken patch in a sandbox costs one restart, the same patch in the working profile costs a host that boots broken — so this is a guard, not advice.

**Test a plugin in a sandbox instead of the desktop app.** A project can hold several isolated instances — daily iteration, a clean reproduction, client UI states, a rollback rehearsal — each with its own home, profile, port, and workspace copy. They are reused rather than rebuilt, they carry a marker so one project's sandbox cannot be adopted by another, and they can be launched, probed over HTTP, seeded with real data, and stopped without touching anything the user is running.

**See the page, and assert on it.** A headless browser is driven over the DevTools Protocol against the sandbox: real screenshots, assertions on selectors, text, expressions and console errors, and real clicks and typing — not a synthetic `element.click()`, which React inputs and contenteditable ignore. The session token is taken from the sandbox's own log, so no one has to hunt it out of a URL. A screenshot proves what rendered; assertions prove what must be true; neither replaces a human on look and feel. See [docs/UI.md](docs/UI.md).

**Generate any structured content from a template.** The plugin scaffold is one instance of a general capability: a scheme is data (variables, file mapping, conditions, rules) plus templates, so a new scheme is a directory rather than a new generator. See [docs/SCHEMES.md](docs/SCHEMES.md).

**Ship a release you have already installed once.** A readiness check asks the packer what would actually ship — not what `files` claims — and compares the package's `engines.dsh` with the running DSH, so a version mismatch is caught before installation rather than during it. A rehearsal then packs the tarball, installs it into a sandbox, and reads the composed config back, handing you the rollback command in the same breath. Publishing stays a human decision: the tool reports whether it would be safe and what to run. See [docs/RELEASE.md](docs/RELEASE.md).

**Judgment where it belongs.** Two skills carry what a tool cannot: which questions to ask before generating a plugin, and how to test one without producing fake evidence.

Everything is mounted inside the Creator-mode preset, so a Standard, PTC, Minimal, or Data-analysis session sees nothing new.

## Schemes: template + config + command

Generating a plugin is one instance of a general capability, so it is built as one. A **scheme** is a directory holding a `recipe.json` (variables, file mapping, conditions, rules), its templates (one file per variant), and — only where something must be computed — a small module of `derive` hooks:

```
templates/bundle/
  recipe.json          variables, files, when-clauses, rules, warnings
  *.tpl                one file per variant; never evaluated as code
lib/generate.js        the generic engine: variables → files → rules
lib/rules.js           declarative structure checks
lib/scaffold.js        the bundle scheme: derive hooks + the deep bundle check
```

The engine knows nothing about plugins. That is what makes a new scheme a directory instead of a new generator: describe the variables, map the files, declare the invariants, and the existing entry points drive it unchanged.

Three properties are enforced rather than documented, because they are what makes generators untrustworthy:

- **Selection, not conditionals** — a variant is a different template file chosen by a `when` clause, so templates stay readable text and the choice logic is visible in one place.
- **Unresolved placeholders are fatal** — a leftover `{{token}}` means the recipe and the template disagree; failing beats shipping half a file.
- **Rules run on the output** — `placeholder-free`, `files-listed` (every generated file must be inside `package.json` `files`), `json-field`, `frontmatter-name`. The bundle's own rules already caught a real bug: `.gitignore` and `.gitattributes` were generated but not marked as local-only, so they showed up as uncovered package content.

JSON is rendered from a template too, with `{{name|json}}` for escaping, so "what gets generated" has exactly one source of truth.

The full format — every variable field, the `when` grammar, the rule types, and how to add a scheme — is in [docs/SCHEMES.md](docs/SCHEMES.md).

## Why a layer split, and not one entry point

Filling a template is deterministic string work; interviewing a user is judgment. Mixing them is what makes template generators unreliable, so every capability here is built the same way:

- **an engine** (`lib/`) — pure, dependency-free, testable, with no idea what a plugin is;
- **a scheme** (`templates/`) — the structure as data: variables, file mapping, conditions, rules;
- **two fronts** — an agent-facing tool and a human-facing CLI over the same engine, so neither has to re-implement it;
- **a skill** — the judgment the engine must not encode: what to ask, what to decide, what counts as verified.

The tool front is not decoration: it is what makes the automation work outside this repository (the project root comes from the session, not from this package) and what makes it independent of PATH (the launcher is derived from the Host executable). The sandbox follows the same shape with one layer fewer — it renders no files, so a template layer would be ceremony.

Selection, not template logic: the template directory holds one file per variant (`index.js.tpl` vs `index.min.js.tpl`, `cordis.patch.yml.tpl` vs `cordis.patch.skill.yml.tpl`), and the engine picks files. Unresolved `{{placeholders}}` after rendering are an error, so a typo in a template fails loudly instead of shipping.

A DSH slash command (`/new-plugin`) is deliberately not included: `commands.register` exists and would be cheap, but a command receives one line of `rawInput`, and the fields here need a conversation — a command would either force `name=... title=...` syntax or just inject a prompt, which is what talking to the agent already does.

### Generate one

Ask the agent in Creator mode for a plugin and it will interview you first; or drive the engine from a plan file. Invocations, fields, and flags are in [docs/TOOLS.md](docs/TOOLS.md).

The generated bundle's patch inserts one Host row and patches no preset, so installing it changes no existing preset's composition. Its README documents the two ways to scope a tool or skill to a single preset instead.

## Sandboxes

Testing a plugin means running a `dsh web` instance that is not the user's desktop app. This package ships the register that makes that repeatable:

```
<project>/tmp/sandboxes/
  registry.json            name → home / workspace / profile / port
  default/
    sandbox.json           marker: which project and sandbox this folder is
    home/                  the sandbox's DSH_HOME
    workspace/             the copy sessions actually run in
    open.log               output of `open --run`; the URL is read from here
```

One project holds as many sandboxes as it needs — `default` for daily iteration, `clean` for a from-scratch reproduction, `client` for UI states, `rollback` for rehearsing a rollback. All of them are **reused**, never recreated implicitly: the pnpm install, the profile's plugin versions, and the model credentials live in the sandbox home.

Sandboxes live under the project's own `tmp/`, never in `~/.dsh` or a system temp directory, so they travel with the project and disappear with it. `sandbox.json` is the identity check: its `project` must be this project's root, and every operation refuses a folder whose marker says otherwise — a copied sandbox cannot be adopted by another project by accident. Ports are unique within the project register, so two stopped sandboxes never claim the same port. The page's workspace title reads `sandbox <project>/<name>`, which is how you tell several running sandboxes apart.

Three behaviours come from real failures on a plugin UI project:

- **A port is not an identity.** Launching records the pid that actually listens, and stopping kills only that pid — a stranger holding the port is reported and left alone. Killing "whatever holds the port" once took the user's desktop app down with it.
- **Contract checks carry the session token.** Routes are requested with the token the sandbox parsed from its own log, so 401 / 400 / 404 / 405 can be checked without hunting a token out of a page URL; the token is redacted from anything returned.
- **Seeding beats an empty home.** An isolated home is empty, so every panel shows an empty state and the interesting rendering is never exercised; named entries can be copied in from the real `~/.dsh`, read-only on the source. Model credentials can be copied too, and the result says so — borrowed credentials are not verified credentials.

**Model credentials stay with the user.** A sandbox starts with only a browser-session record in `.credentials.yaml`; the page then says "choose a model" and nothing sends. The user adds one once in Settings → Models, it lands in that sandbox's home, and every later run reuses it — no script copies the user's credentials around. The register reports `model: yes / no` by reading record names, because the file is never empty in this DSH version (~160 bytes of skeleton even with no model).

Commands, actions, and flags for all of this: [docs/TOOLS.md](docs/TOOLS.md).

## A plugin under development never lands in the current environment

Installing a local bundle is refused — whether through Plugin Manager or through a shell `dsh plugin … add` with a path or `link:` — with three deliberate exceptions: a registry spec (`name@version`), because publishing is the sanctioned way to ship; a host that **is** a sandbox (its `DSH_HOME` sits under a folder carrying `sandbox.json`, or under `tmp/sandboxes/`), where installing is the whole point; and an explicit user decision, expressed as `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1` on the host before a restart.

The reasoning is asymmetric risk: a broken patch in a sandbox costs one restart, and the same patch in the profile the user actually works in means a host that boots with a broken composition. A guard, rather than a rule in a skill, because a rule is advice the model may skip under pressure.

Limits, stated plainly: it does not cover a human typing `dsh plugin add` in their own terminal, and it is not a security boundary — it is an accident brake. The exact matcher is in [docs/TOOLS.md](docs/TOOLS.md).

## How "Creator mode only" is implemented

The bundle patch (`cordis.patch.yml`) overrides the shipped `preset-cordis` row and appends two rows to its plugin list:

- `powerful-tools` → `dsh-plugin-powerful/tools`, which registers `dsh_plugin_check` on the preset's context;
- `powerful-skills` → a second `@deepseek-ai/dsh-skill-filesystem` provider with `includeDefaultRoots: false` and `customSkillDirs` pointing at this package's `skills/` directory.

The patch also inserts one Host row, `powerful-host`, which registers nothing today and exists so the bundle has a stable identity row in Plugin Manager.

Uninstalling removes the whole patch layer, so `preset-cordis` falls back to the declaration shipped in `@deepseek-ai/dsh-web-app` and the tools and skills disappear with it. No other preset is patched or restated.

### The cost of this approach, stated plainly

A patch replaces a row's `config` wholesale — patches never deep-merge, and a preset's `plugins` is inside `config`. There is no "append to an existing preset" mechanism. So the override restates the entire shipped plugin list, marked in the patch file between `# --- shipped preset-cordis ---` and `# --- end shipped ---`.

Consequence: **after upgrading DSH, re-copy that block** from `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml` (the block was copied from DSH 0.2.2-rc.5). If the new DSH adds a row to Creator mode, this bundle would otherwise hide it. A generator/check script for that block is the next item on the roadmap.

A second consequence worth knowing: if a user later edits Creator mode in the Web UI's preset editor, that editor writes its own full override into the profile patch, which wins over this bundle's layer. The tools and skills then disappear until the user re-adds them or the profile override is removed.

## Structure

```
package.json          bundle manifest: exports, files, dsh.bundle.patch
cordis.patch.yml      the patch layer: Host row + Creator-mode preset override
index.js              Host half (registers nothing yet; future shared services)
tools/index.js        preset-scoped half: the three tools and the install guard
lib/bundle-check.js   the structural checker (shared by both tools)
lib/generate.js       the generic template engine (recipe → files → rules)
lib/rules.js          declarative structure checks
lib/scaffold.js       the bundle scheme (derive hooks + the deep check)
lib/sandbox.js        the sandbox engine (shared by the tool and the CLI)
templates/bundle/     the bundle scheme: recipe.json, one template per variant
skills/               skills mounted into Creator mode
locale/{en,zh}.json   Plugin Manager title / description / detail path
docs/                 design docs (philosophy, schemes, tools) + detail page
icon.svg              plugin icon
scripts/              CLIs and the regression checks
```

## Install

This bundle is itself a development checkout, so it follows its own rule: install it into a sandbox first, and install it into the profile you work in only when you have decided to — see the guard above.

From this checkout, with Plugin Manager (preferred — it also handles bundle selection):

```
plugin_manager  action: install_bundle  target: E:\Workplace\extension\dsh-plugin-powerful
```

or from a shell in the profile:

```
dsh plugin --profile desktop add link:E:/Workplace/extension/dsh-plugin-powerful
```

A local directory install links the checkout, so edits under `tools/` and `skills/` are picked up without reinstalling — but a changed module still needs a restart to load a fresh module generation, and a skill edit is picked up live by the skill provider.

## Verify

1. `dsh --profile desktop --dump-config` shows the `powerful-host` row and a `preset-cordis` whose plugin list ends with `powerful-tools` and `powerful-skills`.
2. A **new** Creator-mode session lists the three added tools and both plugin-development skills.
3. A new Standard-mode session lists none of them.
4. The structural check run against this repository reports `ok: true`.

Existing sessions keep the composition they started with; presets are resolved when a session is created.

## Development

The package is plain ESM with **no dependencies and no build step**, on purpose: a preset row resolves its imports from the profile, so `@deepseek-ai/*` authoring helpers (`defineTool`, schemastery) are not importable from here. Tools are written as raw JSON Schema definitions instead.

Two checks need no Host:

```powershell
node scripts/try-tool.mjs .        # mount all three tools + the guard on a stub context
node scripts/try-sandbox.mjs       # the sandbox engine, with a fake dsh launcher
node scripts/check-patch.mjs .     # parse cordis.patch.yml and diff it against the shipped preset
```

`try-tool.mjs` is the regression test for the template: it fails when the generated bundle does not pass its own structural check, so a template edit that breaks the output is caught without installing anything. `try-sandbox.mjs` drives create / start / status / stop against a fake launcher — no profile is bootstrapped and no real port is taken — and covers the ownership marker, port uniqueness, workspace patching, and the credential record scan.

`check-patch.mjs` parses the patch with the same YAML library DSH uses and compares the Creator-mode override with `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`: dropped rows, changed row order, a changed plan-mode section, and unexpected additions all fail. Against the Desktop install that file lives inside `app.asar`, so run it with the DSH runtime instead of `node`:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $env:DSH_NODE_EXECUTABLE scripts\check-patch.mjs .
```

Test a change in an isolated instance rather than in the desktop app; the `dsh-plugin-isolated-test` skill shipped with this bundle is the procedure, and the short version is:

```powershell
$env:DSH_HOME = "E:\Workplace\extension\dsh-plugin-powerful\tmp\iso-home"   # reuse this home; do not recreate it per run
dsh --profile iso-powerful --host 127.0.0.1 --port 3099 --no-open
```

`tmp/` is git-ignored.

## Roadmap

Ordered by the lifecycle gaps in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) §1 — the three stages that are still half-built.

**规范化开发与检查**

- A verify entry point for generated projects (lint, build, tests) — the template currently ships no `scripts/verify`.
- Contract checks as a tool: the ones a real plugin project had to hand-write (architecture boundaries, panel/tool/config contracts, doc links).
- More `dsh_plugin_check` coverage: YAML syntax of the patch (needs a parser), preset declarations, skill frontmatter.

**集成测试**

- Client-side assertions as a tool: slot registration and theme tokens via Inspect, so "the tab is there" stops depending on a human eye.
- A visual smoke path that does not fake evidence when browser control is unavailable.

**发版**

- Done: readiness checks against the real packer surface and `engines.dsh`, plus a sandbox rehearsal that installs the tarball and reads the composed config back.
- Next: emit `engines.dsh` from the template (the running version is known at generation time), so an incompatible install is refused by DSH before activation instead of after.

**基础设施**

- `scripts/sync-preset.mjs`: regenerate the shipped `preset-cordis` block from the installed DSH, instead of re-copying it by hand.
- Template variants: a client-half bundle (slot registration), and a preset-only bundle that carries its own preset declaration.
- Optional `/new-plugin` slash command over the same engine, once the `/` menu is confirmed to render in the target host.

## Attribution

`skills/dsh-plugin-sandbox/` started as a copy of the user's local skill `~/.dsh/skills/dsh-plugin-isolated-test` and has since been renamed and restructured around the sandbox model (multiple sandboxes per project, reuse, and handing the model setup to the user). Its `references/` still predate that rename — where they say "隔离实例" or `iso-home`, read "sandbox". The copy at `~/.dsh/skills/` was left untouched.
