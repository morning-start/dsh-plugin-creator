/**
 * Preset-scoped half of `dsh-plugin-creator`.
 *
 * The bundle patch mounts this row inside the Creator-mode preset only, so every
 * tool registered here is visible in Creator mode and nowhere else. Unloading the
 * bundle removes the row, its registrations, and therefore the tools.
 *
 * Rules for anything added here:
 * - register through `ctx.effect(...)` so teardown is automatic;
 * - use Node built-ins only. A preset row resolves its imports from the profile,
 *   so `@deepseek-ai/*` helpers (`defineTool`, schemastery) are not importable
 *   from this package; write raw JSON Schema instead of a schema builder;
 * - keep each tool read-only unless the tool description says otherwise.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { inspectBundle } from '../lib/bundle-check.js'
import { applyAdoption, auditProject, planAdoption } from '../lib/adopt.js'
import { scaffold } from '../lib/scaffold.js'
import { Sandboxes } from '../lib/sandbox.js'
import { bumpVersion, inspectRelease, packRelease, rehearseRelease } from '../lib/release.js'
import { createRepository, planRepository, updateRepository } from '../lib/repo.js'
import { openPage, runAssertions, stopChrome } from '../lib/ui.js'
import { RULE_TYPES, runProjectChecks } from '../lib/checks.js'

export const name = 'creator-tools'
export const inject = ['tools']

/**
 * Register every Creator-mode tool this bundle adds.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(pluginCheck), 'dsh-plugin-creator/dsh_plugin_check')
  ctx.effect(() => ctx.tools.register(projectCheck), 'dsh-plugin-creator/dsh_project_check')
  ctx.effect(() => ctx.tools.register(pluginNew(() => sessionDirectory(ctx))), 'dsh-plugin-creator/dsh_plugin_new')
  ctx.effect(() => ctx.tools.register(sandboxTool(() => sessionDirectory(ctx))), 'dsh-plugin-creator/dsh_sandbox')
  ctx.effect(() => ctx.tools.register(releaseTool), 'dsh-plugin-creator/dsh_plugin_release')
  ctx.effect(() => ctx.tools.register(repoTool), 'dsh-plugin-creator/dsh_repo')
  ctx.effect(() => ctx.tools.register(uiTool(() => sessionDirectory(ctx))), 'dsh-plugin-creator/dsh_plugin_ui')
  ctx.effect(() => ctx.tools.register(adoptTool(() => sessionDirectory(ctx))), 'dsh-plugin-creator/dsh_plugin_adopt')
  ctx.effect(() => ctx.tools.guard(localInstallGuard), 'dsh-plugin-creator/no-local-install')
}

/* ------------------------------------------------------------------ *
 * Guard: never install a plugin under development into this environment.
 *
 * A bundle being developed is installed from a local directory or a `link:`
 * spec. That belongs in a sandbox, where a broken patch, a half-written module,
 * or a crashed activation costs nothing. Installing it here — the profile the
 * user actually works in — risks a host that boots with a broken composition.
 *
 * The guard covers the two paths an agent has: the `plugin_manager` tool and a
 * shell `dsh plugin add`. It does not cover a human typing in their own
 * terminal, and it is not a security boundary: it is an accident brake with a
 * documented release valve.
 * ------------------------------------------------------------------ */

/** Marker written by scripts/sandbox.mjs into every sandbox folder. */
const SANDBOX_MARKER = 'dsh-plugin-creator/sandbox'

/** Explicit, user-owned override; the agent must ask before using it. */
const OVERRIDE_ENV = 'DSH_ALLOW_LOCAL_PLUGIN_INSTALL'

const DENIAL = [
  'Refusing to install a plugin under development into this environment.',
  'A local bundle (a directory target, `link:`, or `file:`) belongs in a sandbox:',
  '  node scripts/sandbox.mjs create <name> --plugin <dir>',
  '  node scripts/sandbox.mjs open <name>',
  'Installing a published version by registry spec is fine here.',
  `If the user explicitly wants it in the current environment, they can set ${OVERRIDE_ENV}=1 and restart.`,
].join('\n')

/**
 * Deny a local bundle install unless this host is itself a sandbox.
 * @param {Readonly<import('@deepseek-ai/dsh-tools').ToolExecution>} exec - pending call.
 * @returns {string | undefined} denial reason, or undefined to allow.
 */
function localInstallGuard(exec) {
  if (process.env[OVERRIDE_ENV] === '1') return undefined
  if (isSandboxHost()) return undefined

  if (exec.name === 'plugin_manager') {
    const args = asRecord(exec.arguments)
    if (args.action !== 'install_bundle') return undefined
    return isLocalTarget(args.target) ? DENIAL : undefined
  }

  if (exec.name === 'pwsh' || exec.name === 'bash' || exec.name === 'terminal') {
    const command = asRecord(exec.arguments).command
    if (typeof command !== 'string') return undefined
    if (!installsFromLocalPath(command)) return undefined
    return targetsSandbox(command) ? undefined : DENIAL
  }

  return undefined
}

/**
 * True when this Host is running from a sandbox created by `scripts/sandbox.mjs`:
 * the home's parent folder carries the marker, or the home lives under a
 * `tmp/sandboxes/` tree.
 */
function isSandboxHost() {
  const home = process.env.DSH_HOME
  if (home === undefined || home.length === 0) return false
  const markerPath = join(home, '..', 'sandbox.json')
  if (existsSync(markerPath)) {
    try {
      return JSON.parse(readFileSync(markerPath, 'utf8')).marker === SANDBOX_MARKER
    } catch {
      // Fall through to the path check.
    }
  }
  return /[\\/]tmp[\\/]sandboxes[\\/][^\\/]+[\\/]?$/.test(home.replace(/[\\/]+$/, ''))
}

function isLocalTarget(target) {
  if (typeof target !== 'string') return false
  const value = target.trim()
  if (value.length === 0) return false
  if (/^(link|file):/i.test(value)) return true
  // Recognise the shapes on any platform, not just the one we run on: a guard
  // that only understands the local path syntax is fooled by a path copied from
  // another machine, and CI (Linux) exercises the Windows shape.
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) return true
  if (isAbsolute(value)) return true
  return /^\.{1,2}[\\/]/.test(value)
}

/** `dsh plugin ... add ...` with a local spec, anywhere in a shell command. */
function installsFromLocalPath(command) {
  if (!/(?:^|[\s;&|(])dsh(?:\.cmd|\.exe)?\s+plugin\b/.test(command)) return false
  if (!/\badd\b/.test(command)) return false
  return /(?:^|\s)(?:link:|file:)/i.test(command) || /(?:^|\s)(?:\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(command)
}

/** A command aimed at a sandbox profile or sandbox home is allowed. */
function targetsSandbox(command) {
  return /--profile\s+["']?sb-[a-z0-9-]+/i.test(command) || /tmp[\\/]sandboxes[\\/]/i.test(command)
}

function asRecord(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/** The session's working directory, when the deployment provides the service. */
function sessionDirectory(ctx) {
  return (exec) => {
    const service = ctx.get('workingDirectory')
    const session = exec?.agent?.session
    if (service === undefined || session === undefined) return undefined
    try {
      return service.get(session)
    } catch {
      return undefined
    }
  }
}

/**
 * Run a project's own declared checks (`checks.json`).
 *
 * Separate from `dsh_plugin_check`, which knows what a *bundle* must look like.
 * This one knows nothing: the project states its rules — documentation links
 * resolve, locale files agree, a layered tree does not import outward — and the
 * engine runs them. Boundaries live with the project that owns them.
 */
/**
 * Normalise an existing plugin project: audit, plan, and apply only the
 * deterministic additions. A plan is the default because normalising someone's
 * project is an action, not a side effect of asking what would happen.
 */
function adoptTool(defaultDirectory) {
  return {
    name: 'dsh_plugin_adopt',
    description:
      'Bring an existing DSH plugin project up to the standard without rewriting it. Audits the bundle and the standard files, then applies only the deterministic additions: a repository field from the git remote, the tag-driven release workflow, a starter checks.json containing only rules the project already passes, .gitignore entries, and a market.json draft. Never overwrites an existing file, refuses a dirty working tree, and is idempotent. Reports the decisions it will not make (which preset a tool belongs to, a leaked home path) and the manual items (preset patch drift). Defaults to a plan; pass mode "apply" to write.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The plugin package directory. Defaults to the session working directory.' },
        mode: {
          type: 'string',
          enum: ['plan', 'apply'],
          description: 'plan (default) reports only; apply writes the safe additions.',
        },
        force: {
          type: 'boolean',
          description: 'Write even when the working tree has uncommitted changes. Only when the project is yours and the plan has been read.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          mode: { type: 'string', enum: ['plan', 'apply'] },
          bundle: {
            type: 'object',
            properties: {
              pass: { type: 'integer' },
              warn: { type: 'integer' },
              fail: { type: 'integer' },
            },
            required: ['pass', 'warn', 'fail'],
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['id', 'path', 'detail'],
            },
          },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, detail: { type: 'string' } },
              required: ['id', 'detail'],
            },
          },
          manual: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, detail: { type: 'string' } },
              required: ['id', 'detail'],
            },
          },
          applied: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          blocked: { type: 'string' },
        },
        required: ['directory', 'mode', 'bundle', 'actions', 'decisions', 'manual', 'applied', 'skipped'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAdoption(value) }],
    },
    async execute(args) {
      const directory = args.path === undefined ? defaultDirectory() : String(args.path)
      const audit = await auditProject(directory)
      const plan = await planAdoption(directory, audit)
      const mode = args.mode === 'apply' ? 'apply' : 'plan'
      let applied = []
      let skipped = []
      if (mode === 'apply') {
        const result = await applyAdoption(directory, plan, { force: args.force === true })
        applied = result.applied.map(item => `${item.id} (${item.path})`)
        skipped = result.skipped.map(item => `${item.id} (${item.path}): ${item.reason}`)
      }
      return {
        directory,
        mode,
        bundle: audit.bundle.summary,
        actions: plan.actions.map(action => ({ id: action.id, path: action.path, detail: action.detail })),
        decisions: plan.decisions,
        manual: plan.manual,
        applied,
        skipped,
        ...(plan.blocked === undefined ? {} : { blocked: plan.blocked }),
      }
    },
  }
}

function renderAdoption(value) {
  const lines = [
    `${value.directory} — bundle ${value.bundle.pass} pass, ${value.bundle.warn} warn, ${value.bundle.fail} fail`,
  ]
  if (value.blocked !== undefined) lines.push(`blocked: ${value.blocked}`)
  if (value.actions.length === 0) lines.push('nothing to add: the standard files are already there')
  else {
    lines.push(value.mode === 'apply' ? 'added:' : 'would add:')
    for (const action of value.actions) lines.push(`  auto   ${action.id.padEnd(18)} ${action.detail}`)
  }
  if (value.decisions.length > 0) {
    lines.push('needs a decision (not touched):')
    for (const item of value.decisions) lines.push(`  decide ${item.id.padEnd(18)} ${item.detail}`)
  }
  if (value.manual.length > 0) {
    lines.push('report only:')
    for (const item of value.manual) lines.push(`  manual ${item.id.padEnd(18)} ${item.detail}`)
  }
  for (const line of value.skipped) lines.push(`  = ${line}`)
  if (value.mode === 'apply' && value.applied.length > 0) {
    lines.push('', 'next: run dsh_project_check on the project, then review git diff before committing')
  }
  return lines.join('\n')
}

const projectCheck = {
  name: 'dsh_project_check',
  description:
    'Run the checks a project declares in checks.json (or dsh-checks.json). Rule types: doc-links (relative markdown links resolve), locale-parity (locale files carry the same keys), import-boundary (a layered source tree must not import outward, reach for host modules from an inner layer, or pull in packages where it should not), no-console, file-exists / file-absent / files-listed / placeholder-free / json-field / frontmatter-name. Read-only; every rule reports pass/warn/fail instead of stopping at the first problem.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project directory holding the checks file. Absolute.' },
      config: { type: 'string', description: 'An explicit checks file, instead of checks.json at the project root.' },
      only: {
        type: 'array',
        items: { type: 'string' },
        description: 'Run only these rule ids (or types). Useful while fixing one group.',
      },
      update: {
        type: 'boolean',
        description: 'Regenerate contract files (contract-drift rules) instead of only reporting drift. Writes files; pass it only when the diff is expected.',
      },
    },
    required: ['path'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        target: { type: 'string' },
        source: { type: 'string', description: 'The checks file that was used.' },
        summary: {
          type: 'object',
          properties: {
            pass: { type: 'integer' },
            warn: { type: 'integer' },
            fail: { type: 'integer' },
          },
          required: ['pass', 'warn', 'fail'],
        },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
              message: { type: 'string' },
            },
            required: ['id', 'status', 'message'],
          },
        },
      },
      required: ['ok', 'target', 'source', 'summary', 'checks'],
    },
    render: (_args, value) => [{ type: 'text', text: renderProjectChecks(value) }],
  },
  async execute(args) {
    return await runProjectChecks(String(args.path), {
      config: args.config === undefined ? undefined : String(args.config),
      only: Array.isArray(args.only) ? args.only.map(String) : undefined,
      update: args.update === true,
    })
  },
}

function renderProjectChecks(value) {
  const lines = [`${value.target} — ${value.summary.pass} pass, ${value.summary.warn} warn, ${value.summary.fail} fail`]
  lines.push(`checks: ${value.source}`)
  for (const check of value.checks) {
    if (check.status === 'pass') continue
    lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.message}`)
  }
  if (value.summary.fail === 0) lines.push('Every declared check passed.')
  return lines.join('\n')
}

/**
 * Read-only structural check of a bundle directory.
 *
 * Every finding is a line of the result instead of a thrown error, so one broken
 * bundle still reports the checks that do pass.
 */
const pluginCheck = {
  name: 'dsh_plugin_check',
  description:
    'Check a DSH bundle directory for the structural problems that make installation, activation, or display fail: manifest fields, the declared bundle patch, exported locale and icon resources, the entry module, declared detail documents, and the packaged file whitelist. Read-only; it never changes the directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the bundle package directory (the folder holding package.json).',
      },
    },
    required: ['path'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'True when no check failed.' },
        target: { type: 'string' },
        summary: {
          type: 'object',
          properties: {
            pass: { type: 'integer' },
            warn: { type: 'integer' },
            fail: { type: 'integer' },
          },
          required: ['pass', 'warn', 'fail'],
        },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
              message: { type: 'string' },
            },
            required: ['id', 'status', 'message'],
          },
        },
      },
      required: ['ok', 'target', 'summary', 'checks'],
    },
    render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
  },
  async execute(args) {
    return await inspectBundle(String(args.path))
  },
}

/**
 * Create a new bundle from the standard template.
 *
 * The work is `lib/scaffold.js`, shared with `scripts/new-bundle.mjs`, so a
 * bundle generated from the CLI and one generated here are byte-identical.
 */
function pluginNew(defaultDirectory) {
  return {
    name: 'dsh_plugin_new',
    description:
      'Create a new DSH plugin bundle from the standard template: package manifest, bundle patch, entry module, locale dictionaries, icon, README, and optionally an example tool and a skill. Deterministic — the same arguments always produce the same files. It runs dsh_plugin_check on the result and returns that report, so fix every reported failure before installing.',
    parameters: {
      type: 'object',
      properties: {
        packageName: {
          type: 'string',
          description: 'Lowercase npm package name, such as "dsh-plugin-my-thing" or "@scope/my-thing". The preset row id is derived from it when rowId is omitted.',
        },
        title: {
          type: 'string',
          description: 'The name users see in Plugin Manager. Short, sentence case.',
        },
        description: {
          type: 'string',
          description: "What the plugin does and how to trigger it, in the user's language. Plugin Manager shows it verbatim.",
        },
        dest: {
          type: 'string',
          description: 'Directory to create. Defaults to a new folder named after the package inside the session working directory. Refuses a non-empty directory unless force is true.',
        },
        titleZh: { type: 'string', description: 'Chinese title, when the user works in Chinese. Adds locale/zh.json.' },
        descriptionZh: { type: 'string', description: 'Chinese description. Adds locale/zh.json.' },
        rowId: { type: 'string', description: 'Loader row id, lowercase letters, digits, and hyphens. Defaults to the package name without the "dsh-plugin-" prefix and any scope.' },
        toolName: { type: 'string', description: 'Name of the example tool, lowercase with underscores. Defaults to rowId with hyphens turned into underscores.' },
        skillName: { type: 'string', description: 'Skill directory name, when withSkill is true. Defaults to rowId.' },
        version: { type: 'string', description: 'Package version. Defaults to 0.1.0.' },
        withTool: { type: 'boolean', description: 'Include and register an example tool (default true). Set false for a plugin that only wires services or a skill.' },
        withSkill: { type: 'boolean', description: 'Include a SKILL.md and a skill-provider row (default false). The skill is then listed in every preset, not only Creator mode.' },
        force: { type: 'boolean', description: 'Write into a directory that already has files, overwriting only the files this template generates.' },
        recipe: {
          type: 'string',
          description: 'Directory of another scheme to generate from (a folder holding recipe.json plus its templates). Defaults to the built-in bundle scheme.',
        },
        configPath: {
          type: 'string',
          description: 'Read any of the fields above from a JSON file instead of the arguments; arguments that are also given win. Use it when a plan already exists on disk.',
        },
      },
      required: ['packageName', 'title', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dest: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          checks: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              pass: { type: 'integer' },
              warn: { type: 'integer' },
              fail: { type: 'integer' },
              findings: { type: 'array', items: { type: 'string' } },
            },
            required: ['ok', 'pass', 'warn', 'fail', 'findings'],
          },
        },
        required: ['dest', 'files', 'warnings', 'checks'],
      },
      render: (_args, value) => [{ type: 'text', text: renderNew(value) }],
    },
    async execute(args, exec) {
      const fromFile = args.configPath === undefined
        ? {}
        : JSON.parse(await readFile(resolve(String(args.configPath)), 'utf8'))
      const merged = { ...fromFile, ...definedOnly(args) }
      delete merged.configPath

      if (merged.dest === undefined) {
        const base = defaultDirectory(exec)
        if (base === undefined) {
          throw new Error('dest is required: this deployment exposes no working directory for the session')
        }
        merged.dest = resolve(base, folderName(String(merged.packageName)))
      }

      const result = await scaffold(merged)
      return {
        dest: result.dest,
        files: result.files,
        warnings: result.warnings,
        checks: {
          ok: result.checks.ok,
          pass: result.checks.summary.pass,
          warn: result.checks.summary.warn,
          fail: result.checks.summary.fail,
          findings: result.checks.checks
            .filter(check => check.status !== 'pass')
            .map(check => `${check.status.toUpperCase()} ${check.id}: ${check.message}`),
        },
      }
    },
  }
}

/**
 * Release readiness: what is in the tarball, will DSH accept it, and does it
 * install and activate in a sandbox.
 *
 * Publishing is not an action here on purpose — `npm publish` is irreversible and
 * the account decision belongs to the user. The tool reports what to run.
 */
const releaseTool = {
  name: 'dsh_plugin_release',
  description:
    'Prepare a plugin package for release. `version` moves package.json\'s version and prints the commit / tag / push commands — the only action that writes to the project. `check` reports what the packer would ship, whether the running DSH satisfies the package\'s engines/peer requirement, and what blocks a registry publish. `pack` writes the tarball. `rehearse` packs, installs it into a sandbox, and reads the composed config back — the only check that proves it installs and activates, plus the rollback command. Nothing here publishes: in a project generated from this toolkit, pushing the tag is what publishes, in CI.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['version', 'check', 'pack', 'rehearse'],
        description: 'version: step 1 of the release flow, bumps package.json and prints the next commands; check readiness; pack the tarball; or rehearse installing it in a sandbox.',
      },
      path: { type: 'string', description: 'The package directory (the folder holding package.json). Absolute.' },
      part: {
        type: 'string',
        enum: ['patch', 'minor', 'major'],
        description: 'For version: which component to bump. Defaults to patch; ignored when version is given.',
      },
      version: { type: 'string', description: 'For version: an explicit target such as 1.4.0 instead of a bump part.' },
      outDir: { type: 'string', description: 'For pack: where to write the tarball. Defaults to <path>/tmp/release.' },
      sandbox: { type: 'string', description: 'For rehearse: sandbox name to install into. Defaults to "rollback".' },
      dshVersion: { type: 'string', description: 'For check: the DSH version to test compatibility against. Defaults to `dsh --version`.' },
      project: { type: 'string', description: 'For rehearse: project root holding tmp/sandboxes. Defaults to the package directory.' },
    },
    required: ['action', 'path'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
      },
      required: ['action', 'ok', 'summary', 'data'],
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const action = String(args.action)
    const path = resolve(String(args.path))

    if (action === 'check') {
      const report = await inspectRelease(path, {
        dshVersion: args.dshVersion === undefined ? undefined : String(args.dshVersion),
      })
      const lines = [`${report.target}: ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.pass} pass`]
      for (const check of report.checks) {
        if (check.status === 'pass') continue
        lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.message}`)
      }
      if (report.summary.fail === 0) {
        lines.push(report.package.name === undefined
          ? 'No blocking problem found.'
          : `${report.package.name}@${report.package.version} has no blocking problem; next: action "pack", then "rehearse".`)
      }
      return { action, ok: report.ok, summary: lines.join('\n'), data: report }
    }

    if (action === 'version') {
      const part = args.part === undefined ? { part: 'patch' } : { part: String(args.part) }
      const result = bumpVersion(path, args.version === undefined ? part : { version: String(args.version) })
      const lines = [
        `${path}`,
        `${result.previous} -> ${result.version}`,
        '',
        'Next (the CI does the publish once the tag is pushed):',
        ...result.steps.map(step => `  ${step}`),
      ]
      return { action, ok: true, summary: lines.join('\n'), data: result }
    }

    if (action === 'pack') {
      const outDir = args.outDir === undefined ? join(path, 'tmp', 'release') : resolve(String(args.outDir))
      const packed = packRelease(path, outDir)
      return { action, ok: true, summary: `Packed ${packed.tarball}\nvia: ${packed.command}`, data: packed }
    }

    if (action === 'rehearse') {
      const result = await rehearseRelease(path, {
        project: args.project === undefined ? undefined : String(args.project),
        sandbox: args.sandbox === undefined ? undefined : String(args.sandbox),
      })
      const lines = [`Rehearsal in sandbox "${result.sandbox}": ${result.ok ? 'installed and composed' : 'FAILED'}`]
      for (const step of result.steps) lines.push(`  ${step.step}: ${step.detail}`)
      lines.push(`  rollback: ${result.rollback}`)
      lines.push(`  publish:  ${result.publish}`)
      return { action, ok: result.ok, summary: lines.join('\n'), data: result }
    }

    throw new Error(`unknown action "${action}"`)
  },
}

/**
 * Put the project on GitHub, or align the repository it already points at.
 *
 * The two situations are genuinely different and mixing them is how a project
 * ends up with a stray second repository: `create` is for a directory with no
 * origin, `update` for one that already has a GitHub remote. `update` never
 * pushes — preparing a commit and publishing it are separate decisions.
 */
const repoTool = {
  name: 'dsh_repo',
  description:
    'Put a plugin project on GitHub. `plan` reads the current state and prints the exact gh commands it would run, changing nothing. `create` is for a directory with no `origin`: git init, declare `repository` in package.json, `gh repo create <owner>/<repo> --public --source . --remote origin --push`, then add the `dsh-plugin` topic — a plugin repository is public by default because that topic is how the plugin market finds it. `update` is for a directory that already points at GitHub: change the visibility only when it differs from the target, add the topic (idempotent), and align package.json\'s `repository` in its own commit — it never pushes, so publishing the commit stays your call.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['plan', 'create', 'update'],
        description: 'plan: read-only preview of the commands; create: no origin yet; update: already on GitHub.',
      },
      path: { type: 'string', description: 'The project directory. Absolute.' },
      owner: { type: 'string', description: 'For create: the GitHub account or organisation that will own the repository.' },
      repo: { type: 'string', description: 'For create: the repository name. Defaults to package.json name without its scope.' },
      visibility: {
        type: 'string',
        enum: ['public', 'private', 'internal'],
        description: 'Target visibility. Defaults to public, which is what makes a plugin discoverable.',
      },
      topic: { type: 'string', description: 'The repository topic. Defaults to dsh-plugin, the one the market discovers.' },
      description: { type: 'string', description: 'Optional repository description to set on GitHub.' },
      dryRun: { type: 'boolean', description: 'Report the steps without running them.' },
      commit: { type: 'boolean', description: 'For update: commit the package.json change. Defaults to true; the commit is never pushed.' },
    },
    required: ['action', 'path'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
      },
      required: ['action', 'ok', 'summary', 'data'],
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const action = String(args.action)
    const path = resolve(String(args.path))
    const options = {
      owner: args.owner === undefined ? undefined : String(args.owner),
      repo: args.repo === undefined ? undefined : String(args.repo),
      visibility: args.visibility === undefined ? undefined : String(args.visibility),
      topic: args.topic === undefined ? undefined : String(args.topic),
      description: args.description === undefined ? undefined : String(args.description),
      dryRun: args.dryRun === true,
      commit: args.commit !== false,
    }

    if (action === 'plan') {
      const plan = planRepository(path, options)
      const lines = [
        `${path}`,
        `${plan.action} ${plan.target ?? '(unknown target)'} — visibility ${plan.visibility}, topic ${plan.topic}`,
      ]
      if (plan.problem !== undefined) {
        lines.push('', `blocked: ${plan.problem}`)
        return { action, ok: false, summary: lines.join('\n'), data: plan }
      }
      lines.push(...(plan.steps.length === 0 ? ['', '(nothing to change)'] : ['', ...plan.steps.map(step => `  ${step}`)]))
      return { action, ok: true, summary: lines.join('\n'), data: plan }
    }

    if (action === 'create') {
      const result = createRepository(path, options)
      const lines = [`${path}`]
      for (const step of result.steps) {
        lines.push(`${step.ok === false ? 'FAIL' : 'ok  '} ${step.step}${step.detail === undefined || step.detail === '' ? '' : `  — ${step.detail}`}`)
      }
      if (result.url !== undefined) lines.push('', result.url)
      if (result.ok !== true) lines.push('', `stopped at ${result.failedAt}. Nothing after it ran.`)
      return { action, ok: result.ok === true, summary: lines.join('\n'), data: result }
    }

    if (action === 'update') {
      const result = updateRepository(path, options)
      if (result.unchanged === true) {
        return {
          action,
          ok: true,
          summary: `${path}\n${result.url ?? ''} is already aligned; nothing to change.`,
          data: result,
        }
      }
      const lines = [`${path}`]
      if (result.dryRun === true) lines.push('dry run: nothing was changed.')
      for (const step of result.steps) {
        lines.push(`${step.ok === false ? 'FAIL' : 'ok  '} ${step.step}${step.detail === undefined || step.detail === '' ? '' : `  — ${step.detail}`}`)
      }
      if (result.url !== undefined) lines.push('', result.url)
      return { action, ok: result.ok === true, summary: lines.join('\n'), data: result }
    }

    throw new Error(`unknown action "${action}"`)
  },
}

/**
 * Drive a headless browser against a sandbox page: screenshot it, assert on it,
 * or evaluate an expression in it.
 *
 * This is the integration-test half of the cycle. A sandbox supplies the URL and
 * token; this supplies the eyes — real screenshots, real assertions, real clicks —
 * so "the tab is there and shows data" stops depending on someone describing it.
 * It is not a substitute for a human on look-and-feel: a screenshot proves what
 * rendered, assertions prove what must be true.
 */
function uiTool(defaultDirectory) {
  return {
    name: 'dsh_plugin_ui',
    description:
      'Look at and assert on a running page through a headless browser (Chrome DevTools Protocol): `shot` saves a screenshot, `assert` checks selectors / text / expressions / console errors, `eval` returns a value from the page, `close` stops the browser. Point it at a sandbox (name + path) and it resolves the URL and session token for you, or give a URL directly. The browser is reused between calls; `close` is the way to stop it.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['shot', 'assert', 'eval', 'close'],
          description: 'screenshot the page; run assertions; evaluate an expression; stop the browser.',
        },
        sandbox: { type: 'string', description: 'Sandbox name to take the URL from. Requires the sandbox to be running.' },
        path: { type: 'string', description: 'For sandbox targets: the page path to open, e.g. "/" or "/settings". Defaults to "/".' },
        url: { type: 'string', description: 'A full URL to open instead of a sandbox. If it has no token, one is added when a sandbox is named.' },
        project: { type: 'string', description: 'Project root holding tmp/sandboxes. Defaults to the session working directory.' },
        out: { type: 'string', description: 'For shot: where to write the PNG. Defaults to <project>/tmp/ui/<action>-<time>.png.' },
        size: { type: 'string', description: 'Viewport, e.g. "1440x900" or "390x844" for a phone width.' },
        assertions: {
          type: 'array',
          description: 'For assert: objects with one of selector / text / expression (+ equals) / noConsoleErrors / noNetworkFailures, and an optional id.',
          items: { type: 'object', additionalProperties: true },
        },
        expression: { type: 'string', description: 'For eval: a JavaScript expression evaluated in the page.' },
        click: { type: 'string', description: 'Click this selector before the action (real mouse events, not a synthetic click).' },
        type: {
          type: 'object',
          description: 'Focus a selector and insert text, e.g. {"selector": "#input", "text": "hello"}.',
          additionalProperties: true,
        },
        settleMs: { type: 'integer', description: 'How long to wait after load before acting. Defaults to 1200.' },
        port: { type: 'integer', description: 'CDP port. Defaults to 9222; a second port lets two browsers coexist.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'ok', 'summary', 'data'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      if (action === 'close') {
        const killed = stopChrome(args.port === undefined ? undefined : Number(args.port))
        return { action, ok: true, summary: killed.length === 0 ? 'No browser was listening on the CDP port.' : `Stopped ${killed.length} browser process(es).`, data: { killed } }
      }

      const project = args.project === undefined ? defaultDirectory(exec) : resolve(String(args.project))
      const url = targetUrl(args, project)
      const options = {
        port: args.port === undefined ? undefined : Number(args.port),
        size: args.size === undefined ? undefined : String(args.size),
        settleMs: args.settleMs === undefined ? undefined : Number(args.settleMs),
      }

      const page = await openPage(url, options)
      try {
        if (args.click !== undefined) await page.click(String(args.click))
        if (args.type !== undefined) {
          const input = args.type
          if (typeof input.selector !== 'string' || typeof input.text !== 'string') {
            throw new Error('type needs { selector, text }')
          }
          await page.type(input.selector, input.text)
        }

        if (action === 'eval') {
          const value = await page.evaluate(String(args.expression ?? 'document.title'))
          return { action, ok: true, summary: `${args.expression ?? 'document.title'} → ${JSON.stringify(value)}`, data: { value } }
        }

        if (action === 'assert') {
          const assertions = Array.isArray(args.assertions) ? args.assertions : []
          if (assertions.length === 0) throw new Error('assert needs at least one assertion')
          const result = await runAssertions(page, assertions)
          const lines = [`${result.summary.pass} pass, ${result.summary.fail} fail`]
          for (const check of result.checks) {
            if (check.status === 'pass') continue
            lines.push(`FAIL ${check.id}: ${check.detail}`)
          }
          if (result.ok) lines.push('Every assertion passed.')
          return { action, ok: result.ok, summary: lines.join('\n'), data: result }
        }

        if (action === 'shot') {
          const out = args.out === undefined
            ? join(project, 'tmp', 'ui', `shot-${Date.now()}.png`)
            : resolve(String(args.out))
          const path = await page.screenshot(out)
          return { action, ok: true, summary: `Screenshot: ${path}`, data: { path, url } }
        }

        throw new Error(`unknown action "${action}"`)
      } finally {
        await page.close().catch(() => {})
      }
    },
  }
}

/**
 * The page to open: an explicit URL, or a sandbox's URL plus a path with its
 * session token carried over. The token never leaves this function except inside
 * the URL handed to the browser.
 */
function targetUrl(args, project) {
  if (args.url !== undefined && args.sandbox === undefined) return String(args.url)
  if (args.sandbox === undefined) throw new Error('give either url or sandbox')

  if (project === undefined) throw new Error('project is required: this deployment exposes no working directory for the session')
  const sandboxes = new Sandboxes(project)
  const recorded = sandboxes.recordedUrl(String(args.sandbox))
  if (recorded === undefined) {
    throw new Error(`sandbox "${args.sandbox}" has no recorded URL; start it first (dsh_sandbox action "start")`)
  }
  const base = new URL(recorded)
  const target = new URL(String(args.path ?? '/'), base.origin)
  if (!target.searchParams.has('token') && base.searchParams.has('token')) {
    target.searchParams.set('token', base.searchParams.get('token'))
  }
  return target.href
}

/**
 * Manage the project's sandboxes: create, launch, probe, stop, remove.
 *
 * The work is `lib/sandbox.js`, shared with `scripts/sandbox.mjs`. Having it as a
 * tool is what makes the automation usable in *any* project: the skill no longer
 * depends on the project shipping a script, and the launcher is resolved from the
 * Host executable instead of PATH.
 */
function sandboxTool(defaultDirectory) {
  return {
    name: 'dsh_sandbox',
    description:
      'Manage isolated dsh web sandboxes for testing a plugin: one project can hold several (daily iteration, a clean reproduction, client UI states), each with its own DSH_HOME, profile, port, and workspace copy. Sandboxes are reused across runs — the installed plugin versions and the model credentials the user adds once stay in the sandbox home. `start` launches one and returns its URL so you can probe it immediately; `open` only prints the command for the user, for when they need to add a model themselves.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'start', 'open', 'status', 'fix-workspace', 'http', 'seed', 'stop', 'remove'],
          description: 'list the sandboxes; create a new one; start it; print the command for the user; probe it; point its workspace at the sandbox copy; request a path from it; copy data into it; stop it; remove it.',
        },
        name: { type: 'string', description: 'Sandbox name, lowercase letters, digits, and hyphens. Required for every action except list.' },
        project: { type: 'string', description: 'Project root whose tmp/sandboxes holds the sandboxes. Defaults to the session working directory.' },
        plugin: { type: 'string', description: 'For create: the plugin directory to install (link:). Defaults to the project root.' },
        waitMs: { type: 'integer', description: 'For start: how long to wait for the URL before failing. Defaults to 45000.' },
        path: { type: 'string', description: 'For http: the path to request, e.g. "/api/panel/summary". The session token is added for you.' },
        method: { type: 'string', description: 'For http: HTTP method. Defaults to GET.' },
        body: { type: 'string', description: 'For http: request body, sent as JSON.' },
        entries: {
          type: 'array',
          items: { type: 'string' },
          description: 'For seed: entry names inside the source DSH_HOME to copy in, e.g. ["myteam"] or ["skills"]. The source is only read.',
        },
        from: { type: 'string', description: 'For seed: the DSH_HOME to copy from. Defaults to ~/.dsh.' },
        force: { type: 'boolean', description: 'For seed: overwrite existing entries. For stop: kill whatever listens on the sandbox port, including the desktop app or another instance — only after the user says so.' },
        confirm: { type: 'boolean', description: 'For remove: must be true. Removing deletes the model credentials added in that sandbox.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          summary: { type: 'string', description: 'What happened, in the terms the user sees.' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'ok', 'summary', 'data'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      const name = args.name === undefined ? undefined : String(args.name)
      if (action !== 'list' && name === undefined) throw new Error(`${action} needs a name`)

      const project = args.project === undefined ? defaultDirectory(exec) : resolve(String(args.project))
      if (project === undefined) {
        throw new Error('project is required: this deployment exposes no working directory for the session')
      }
      const sandboxes = new Sandboxes(project)
      const done = (summary, data) => ({ action, ok: true, summary, data })

      switch (action) {
        case 'list': {
          const state = sandboxes.list()
          if (state.sandboxes.length === 0 && state.unregistered.length === 0) {
            return done(`No sandboxes in ${state.project}. Create one with action "create".`, state)
          }
          const lines = [`Sandboxes in ${state.project}:`]
          for (const item of state.sandboxes) {
            const note = item.note.length > 0 ? `  [${item.note}]` : ''
            lines.push(`  ${item.name}  port ${item.port}  profile ${item.profile}  model: ${item.model === 'configured' ? 'yes' : 'no'}${note}`)
          }
          if (state.unregistered.length > 0) {
            lines.push('Folders not in the register:')
            for (const item of state.unregistered) lines.push(`  ${item.name} (${item.owner ?? 'no marker'})`)
          }
          if (state.missing.length > 0) lines.push(`Registered but missing on disk: ${state.missing.join(', ')}`)
          return done(lines.join('\n'), state)
        }

        case 'create': {
          const created = await sandboxes.create(name, { plugin: args.plugin })
          return done(
            `Created sandbox "${created.name}" (port ${created.port}, profile ${created.profile}).\n` +
              `Plugin: ${created.installed ? `link:${created.plugin}` : `NOT installed — ${created.plugin} is not a package directory`}.\n` +
              `Start it with action "start", then have the user add a model in Settings → Models.`,
            created,
          )
        }

        case 'start': {
          const started = await sandboxes.start(name, { timeoutMs: args.waitMs === undefined ? undefined : Number(args.waitMs) })
          const lines = [
            started.alreadyRunning
              ? `Sandbox "${name}" was already running.`
              : `Sandbox "${name}" is running (pid ${started.pid}).`,
          ]
          if (started.url !== undefined) lines.push(`URL: ${started.url}`)
          lines.push(`Log: ${started.logPath}`)
          if (started.workspace === 'patched') lines.push('workspace.json was rewritten to the sandbox workspace; reload the page.')
          if (started.model !== 'configured') {
            lines.push('No model yet: give the user that URL and ask them to add one in Settings → Models. That is the one step they must do; it is remembered by this sandbox.')
          }
          return done(lines.join('\n'), started)
        }

        case 'open': {
          const opened = sandboxes.open(name)
          const lines = [
            `Sandbox "${name}" — the user runs this in their own terminal:`,
            `  ${opened.command}`,
            `  ${opened.command2}`,
            `Then they add a model once in Settings → Models; it stays in ${opened.home}.`,
          ]
          if (opened.model === 'none') lines.push('Current state: no model, so the page will say "choose a model" and messages will not send.')
          if (opened.workspace === 'absent' || opened.workspace === 'empty') {
            lines.push(`The workspace entry is not registered yet; after the page loads once, run action "fix-workspace".`)
          }
          return done(lines.join('\n'), opened)
        }

        case 'status': {
          const status = await sandboxes.status(name)
          if (!status.running) return done(`${name}: not running (port ${status.port} is free).`, status)
          if (status.http === undefined) return done(`${name}: port ${status.port} is in use but the probe did not answer.`, status)
          return done(`${name}: listening on ${status.port}, HTTP ${status.http} (401 still means alive).`, status)
        }

        case 'fix-workspace': {
          const result = sandboxes.patchWorkspace(name)
          const messages = {
            absent: 'no storages/workspace.json yet: start the sandbox and load the page once, then run this again',
            empty: 'the workspaces table is empty: load the page once so the host registers one, then run this again',
            patched: 'pointed the sandbox workspace at the copy; reload the page',
            already: 'the sandbox workspace already points at the copy',
          }
          return done(`${name}: ${messages[result]}`, { result })
        }

        case 'http': {
          const result = await sandboxes.http(name, {
            path: args.path === undefined ? undefined : String(args.path),
            method: args.method === undefined ? undefined : String(args.method),
            body: args.body === undefined ? undefined : String(args.body),
          })
          const lines = [`${result.method} ${result.path} → HTTP ${result.status}`]
          if (result.contentType !== undefined) lines.push(`content-type: ${result.contentType}`)
          if (result.location !== undefined) lines.push(`location: ${result.location}`)
          if (result.body.length > 0) lines.push(result.body.slice(0, 1500))
          if (result.truncated) lines.push('… truncated')
          return done(lines.join('\n'), result)
        }

        case 'seed': {
          const seeded = sandboxes.seed(name, {
            from: args.from === undefined ? undefined : String(args.from),
            entries: Array.isArray(args.entries) ? args.entries.map(String) : [],
            force: args.force === true,
          })
          const lines = [`seeded "${name}" from ${seeded.source}`]
          for (const item of seeded.copied) {
            lines.push(`  ${item.entry}: ${item.status}${item.warning === undefined ? '' : ` — ${item.warning}`}`)
          }
          return done(lines.join('\n'), seeded)
        }

        case 'stop': {
          const stopped = sandboxes.stop(name, { force: args.force === true })
          if (stopped.refused) {
            return {
              action,
              ok: false,
              summary:
                `Refusing to stop pid(s) ${stopped.foreign.join(', ')} on port ${stopped.port}: that listener is not the process this sandbox recorded. ` +
                'It may be the desktop app or another instance. Report it instead of killing it; re-run with force: true only if the user says so.',
              data: stopped,
            }
          }
          return done(
            stopped.stopped.length === 0
              ? `${name}: nothing listening on port ${stopped.port}.`
              : `${name}: stopped ${stopped.stopped.length} process(es) on port ${stopped.port}.`,
            stopped,
          )
        }

        case 'remove': {
          const result = sandboxes.remove(name, { confirmed: args.confirm === true })
          if (!result.confirmed) {
            return {
              action,
              ok: false,
              summary: `Refusing to remove "${name}" without confirm: true. It deletes ${result.path} — the model credentials added there and the installed plugin versions. Ask the user first.`,
              data: result,
            }
          }
          return done(`removed sandbox "${name}".`, result)
        }

        default:
          throw new Error(`unknown action "${action}"`)
      }
    },
  }
}

function definedOnly(args) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null))
}

function folderName(packageName) {
  const base = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName
  return base.length > 0 ? base : 'dsh-plugin-new'
}

function renderCheck(value) {
  const lines = [`${value.target}: ${value.summary.fail} fail, ${value.summary.warn} warn, ${value.summary.pass} pass`]
  const findings = value.checks.filter(check => check.status !== 'pass')
  if (findings.length === 0) {
    lines.push('Every structural check passed.')
  } else {
    for (const check of findings) lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.message}`)
  }
  return lines.join('\n')
}

function renderNew(value) {
  const lines = [
    `Created ${value.dest}`,
    `Files: ${value.files.join(', ')}`,
    `Check: ${value.checks.fail} fail, ${value.checks.warn} warn, ${value.checks.pass} pass`,
  ]
  for (const finding of value.checks.findings) lines.push(`  ${finding}`)
  if (value.warnings.length > 0) {
    lines.push('Before shipping:')
    for (const warning of value.warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}
