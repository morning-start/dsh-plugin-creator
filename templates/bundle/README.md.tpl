# {{packageName}}

{{description}}

Generated from the `dsh-plugin-powerful` bundle template.

## What it adds

{{summary}}

## Install

```
plugin_manager  action: install_bundle  target: <this directory>
```

or from a shell in the profile:

```
dsh plugin --profile <profile> add link:<this directory>
```

A local directory install links this checkout, so later edits are picked up
without reinstalling — but a changed module needs a restart to load a fresh
module generation.

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
