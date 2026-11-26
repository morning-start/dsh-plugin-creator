# {{packageName}}

{{description}}

Generated from the `dsh-plugin-powerful` bundle template.

## What it adds

{{summary}}

## Install

**This bundle is under development, so it goes into a sandbox first.** Installing a
local bundle into the environment you actually work in risks a host that boots with a
broken composition; a sandbox makes that cost nothing.

```
node scripts/sandbox.mjs create dev --plugin <this directory>
node scripts/sandbox.mjs open dev
```

Then add a model once in the page (Settings → Models); the sandbox keeps it, so later
runs are just `open dev`.

Installing into the current environment is a deliberate step, not the default:

- publish it and install by registry spec, or
- the user explicitly decides to link it here, and sets `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`
  for the host before restarting (the install guard in `dsh-plugin-powerful` refuses a
  local bundle install otherwise).

A local directory install links this checkout, so later edits are picked up without
reinstalling — but a changed module needs a restart to load a fresh module generation.

## Verify

1. `dsh --profile <profile> --dump-config` shows the `{{rowId}}` row.
2. The capability is actually there: {{verify}}

## Next steps

- Replace the placeholder icon (`icon.svg`). Plugin Manager draws default
  artwork when the icon is missing or does not decode.
- Fill in `locale/en.json`'s `meta.description`: it is the text users read in
  Plugin Manager, and it should say what the plugin does and how to trigger it.
- Run the structural check before publishing:
  `dsh_plugin_check` with this directory, or `node scripts/new-bundle.mjs --help`
  from the toolkit that generated this bundle.
