# dsh-plugin-powerful

A plugin-development toolkit for DeepSeek Harness (DSH). Installing it adds tools and skills to **Creator mode (创造模式, the `cordis` preset)** and to nothing else. Removing it takes everything back out.

## What it adds

| Kind | Name | What it does |
|---|---|---|
| Tool | `dsh_plugin_check` | Read-only structural check of a bundle directory: manifest fields, the declared `dsh.bundle.patch`, exported locale and icon resources, the entry module, the declared detail document, the `files` whitelist, and relative module names in the patch. Reports pass / warn / fail per check instead of throwing on the first problem. |
| Tool | `dsh_plugin_new` | Generates a complete plugin package from the standard template: manifest, bundle patch, entry module, locale dictionaries, icon, README, optionally an example tool and a skill. Deterministic, and it runs `dsh_plugin_check` on its own output before returning. |
| Skill | `dsh-plugin-new` | The interview behind that tool: which fields to ask for, which decisions belong to the user, and what to do with each warning in the report. |
| Skill | `dsh-plugin-sandbox` | 插件沙盒测试: how to test a plugin in `dsh web` sandboxes — one project can hold several, each with its own `DSH_HOME`, profile, port, and workspace copy, all reused across runs. Includes the traps that produce "installed but not working". |

Everything is mounted inside the Creator-mode preset, so a Standard, PTC, Minimal, or Data-analysis session sees no new tool, no new prompt section, and no new skill.

## Why a tool, a skill, and a CLI — not one of them

Filling a template is deterministic string work; interviewing a user is judgment. Mixing them is what makes template generators unreliable, so the split is:

- **`lib/scaffold.js`** — the engine. Pure, zero-dependency, testable.
- **`templates/bundle/`** — the template. Files in the package, not skill resources, so they are checked by `dsh_plugin_check` and never drift from what ships.
- **`scripts/new-bundle.mjs`** — CLI over the engine, for a `plan.json` or a human at a terminal.
- **`dsh_plugin_new`** — tool over the same engine, so an agent does not hand-quote shell arguments.
- **`dsh-plugin-new`** — the skill. It only decides what to ask and what to do with the answer.

Selection, not template logic: the template directory holds one file per variant (`index.js.tpl` vs `index.min.js.tpl`, `cordis.patch.yml.tpl` vs `cordis.patch.skill.yml.tpl`), and the engine picks files. Unresolved `{{placeholders}}` after rendering are an error, so a typo in a template fails loudly instead of shipping.

A DSH slash command (`/new-plugin`) is deliberately not included: `commands.register` exists and would be cheap, but a command receives one line of `rawInput`, and the fields here need a conversation — a command would either force `name=... title=...` syntax or just inject a prompt, which is what talking to the agent already does.

### Generate one

```
dsh_plugin_new  { packageName: 'dsh-plugin-my-thing', title: 'My thing', description: '...' }
```

```powershell
node scripts/new-bundle.mjs --name dsh-plugin-my-thing --title "My thing" --description "..." --with-skill
node scripts/new-bundle.mjs --config plan.json
node scripts/new-bundle.mjs --dry-run ...      # validate and list files, write nothing
```

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

Sandboxes live under the project's own `tmp/`, never in `~/.dsh` or a system temp directory, so they travel with the project and disappear with it. `sandbox.json` is the identity check: its `project` must be this project's root, and `open`, `status`, `stop`, and `remove` refuse a folder whose marker says otherwise — a copied sandbox cannot be adopted by another project by accident. Ports are unique within the project register, so two stopped sandboxes never claim the same port. The page's workspace title reads `sandbox <project>/<name>`, which is how you tell several running sandboxes apart.

```powershell
node scripts/sandbox.mjs list
node scripts/sandbox.mjs create default --plugin .
node scripts/sandbox.mjs open default            # print the command for the user to run
node scripts/sandbox.mjs open default --run      # start it here and print the URL
node scripts/sandbox.mjs fix-workspace default
node scripts/sandbox.mjs status default
node scripts/sandbox.mjs stop default
node scripts/sandbox.mjs remove default --yes
```

**Model credentials stay with the user.** A sandbox starts with only a browser-session record in `.credentials.yaml`; the page then says "choose a model" and nothing sends. `open` prints the two lines the user runs in their own terminal, and they add the model once in Settings → Models. It lands in that sandbox's home and every later `open` reuses it — no script copies the user's credentials around. `list` reports `model: yes / no` by reading the record names, because the file is never empty in this DSH version (~160 bytes of skeleton even with no model).

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
tools/index.js        preset-scoped half: dsh_plugin_check, dsh_plugin_new
lib/bundle-check.js   the structural checker (shared by both tools)
lib/scaffold.js       the template engine (shared by the tool and the CLI)
templates/bundle/     the standard plugin template, one file per variant
skills/               skills mounted into Creator mode
locale/{en,zh}.json   Plugin Manager title / description / detail path
docs/                 detail document + feature image
icon.svg              plugin icon
scripts/              new-bundle CLI, sandbox register, patch/skill/tool checks
```

## Install

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
2. A **new** Creator-mode session lists `dsh_plugin_check` among its tools and `dsh-plugin-isolated-test` in its skill catalog.
3. A new Standard-mode session lists neither.
4. `dsh_plugin_check` run against this repository reports `ok: true`.

Existing sessions keep the composition they started with; presets are resolved when a session is created.

## Development

The package is plain ESM with **no dependencies and no build step**, on purpose: a preset row resolves its imports from the profile, so `@deepseek-ai/*` authoring helpers (`defineTool`, schemastery) are not importable from here. Tools are written as raw JSON Schema definitions instead.

Two checks need no Host:

```powershell
node scripts/try-tool.mjs .        # mount both tools on a stub context; check this repo, then scaffold into tmp/smoke-output
node scripts/check-patch.mjs .     # parse cordis.patch.yml and diff it against the shipped preset
```

`try-tool.mjs` is the regression test for the template: it fails when the generated bundle does not pass its own structural check, so a template edit that breaks the output is caught without installing anything.

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

- `scripts/sync-preset.mjs`: regenerate the shipped `preset-cordis` block from the installed DSH, instead of re-copying it by hand.
- More checks: YAML syntax of the patch (needs a parser), preset declarations, skill frontmatter.
- Template variants: a client-half bundle (slot registration), and a preset-only bundle that carries its own preset declaration.
- Optional `/new-plugin` slash command over the same engine, once the `/` menu is confirmed to render in the target host.

## Attribution

`skills/dsh-plugin-sandbox/` started as a copy of the user's local skill `~/.dsh/skills/dsh-plugin-isolated-test` and has since been renamed and restructured around the sandbox model (multiple sandboxes per project, reuse, and handing the model setup to the user). Its `references/` still predate that rename — where they say "隔离实例" or `iso-home`, read "sandbox". The copy at `~/.dsh/skills/` was left untouched.
