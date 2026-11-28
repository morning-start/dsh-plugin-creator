# {{packageName}}

{{description}}

Generated from the `dsh-plugin-creator` bundle template.

## What it adds

{{summary}}

## Checks

`checks.json` ships with this project so the rules it should not have to rediscover are already declared: relative documentation links resolve, the locale files carry the same keys, the entry and patch exist, and every file in the tree is inside `package.json` `files`.

Run them with the `dsh_project_check` tool from `dsh-plugin-creator`, or with its `scripts/check-project.mjs`:

```
node <dsh-plugin-creator>/scripts/check-project.mjs .
```

Add your own rules as the project grows — architecture boundaries are the usual next one; the rule reference is `dsh-plugin-creator`'s `docs/CHECKS.md`.

## Install

**This bundle is under development, so it goes into a sandbox first.** Installing a
local bundle into the environment you actually work in risks a host that boots with a
broken composition; a sandbox makes that cost nothing.

With `dsh-plugin-creator` installed, ask the agent in Creator mode to:

```
dsh_sandbox { action: 'create', name: 'dev', plugin: '<this directory>' }
dsh_sandbox { action: 'start', name: 'dev' }
```

Then add a model once in the page (Settings → Models); the sandbox keeps it, so later
runs are just `start dev`.

Installing into the current environment is a deliberate step, not the default:

- publish it and install by registry spec, or
- the user explicitly decides to link it here, and sets `DSH_ALLOW_LOCAL_PLUGIN_INSTALL=1`
  for the host before restarting (the install guard in `dsh-plugin-creator` refuses a
  local bundle install otherwise).

A local directory install links this checkout, so later edits are picked up without
reinstalling — but a changed module needs a restart to load a fresh module generation.

## Verify

1. `dsh --profile <profile> --dump-config` shows the `{{rowId}}` row.
2. The capability is actually there: {{verify}}

## Releasing

The flow is fixed, and the workflow that implements it ships in this project:

1. **Move the version** in `package.json` — with `dsh-plugin-creator` installed,
   `dsh_plugin_release { action: 'version', path: '<this directory>', part: 'patch' }`
   bumps it and prints the rest, so the JSON shape stays npm's.
2. **Tag it**: `git tag v<version>`.
3. **Push**: `git push origin HEAD && git push origin v<version>`.
4. **CI publishes**: `.github/workflows/release.yml` checks the tag against
   `package.json`, packs, publishes to npm, and creates the GitHub Release.

Nothing is published from your machine, so there is no `npm publish` to
misremember and no local build to reproduce.

**No registry token is stored.** The workflow exchanges the job's OIDC identity
for a short-lived credential (trusted publishing), so the repository holds no
long-lived secret to leak or rotate. One-time setup: npmjs.com → this package →
Settings → **Trusted Publisher** → GitHub Actions, workflow filename
`release.yml`. Until that is saved, the publish step **fails to authenticate**
rather than silently succeeding.

`checks.json` guards the pipeline itself (`release:pipeline`): a workflow that
loses the tag trigger, the version reconciliation, the concurrency group, or
that starts reading a stored registry token fails the check — so the standard
cannot quietly erode.

## Next steps

- Replace the placeholder icon (`icon.svg`). Plugin Manager draws default
  artwork when the icon is missing or does not decode.
- Fill in `locale/en.json`'s `meta.description`: it is the text users read in
  Plugin Manager, and it should say what the plugin does and how to trigger it.
- Run the structural check before publishing:
  `dsh_plugin_check` with this directory, or `node scripts/new-bundle.mjs --help`
  from the toolkit that generated this bundle.
