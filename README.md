# dsh-plugin-powerful

A plugin-development toolkit for DeepSeek Harness (DSH). Installing it adds tools and skills to **Creator mode (创造模式, the `cordis` preset)** and to nothing else. Removing it takes everything back out.

## What it adds

| Kind | Name | What it does |
|---|---|---|
| Tool | `dsh_plugin_check` | Read-only structural check of a bundle directory: manifest fields, the declared `dsh.bundle.patch`, exported locale and icon resources, the entry module, the declared detail document, the `files` whitelist, and relative module names in the patch. Reports pass / warn / fail per check instead of throwing on the first problem. |
| Skill | `dsh-plugin-isolated-test` | How to create, test, debug, and publish a plugin inside a `dsh web` instance with its own `DSH_HOME`, profile, and port — including the traps that produce "installed but not working". |

Everything is mounted inside the Creator-mode preset, so a Standard, PTC, Minimal, or Data-analysis session sees no new tool, no new prompt section, and no new skill.

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
tools/index.js        preset-scoped half: the dsh_plugin_check tool
skills/               skills mounted into Creator mode
locale/{en,zh}.json   Plugin Manager title / description / detail path
docs/                 detail document + feature image
icon.svg              plugin icon
scripts/              dev checks: patch drift, tool smoke test
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
node scripts/try-tool.mjs .        # mount the tools plugin on a stub context and run dsh_plugin_check here
node scripts/check-patch.mjs .     # parse cordis.patch.yml and diff it against the shipped preset
```

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
- A scaffolding tool that writes a new bundle skeleton.

## Attribution

`skills/dsh-plugin-isolated-test/` is copied from the user's local skill directory (`~/.dsh/skills/dsh-plugin-isolated-test`). Keep it in sync with that source when it changes.
