/**
 * Preset-scoped half of `dsh-plugin-powerful`.
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
import { scaffold } from '../lib/scaffold.js'
import { Sandboxes } from '../lib/sandbox.js'

export const name = 'powerful-tools'
export const inject = ['tools']

/**
 * Register every Creator-mode tool this bundle adds.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(pluginCheck), 'dsh-plugin-powerful/dsh_plugin_check')
  ctx.effect(() => ctx.tools.register(pluginNew(() => sessionDirectory(ctx))), 'dsh-plugin-powerful/dsh_plugin_new')
  ctx.effect(() => ctx.tools.register(sandboxTool(() => sessionDirectory(ctx))), 'dsh-plugin-powerful/dsh_sandbox')
  ctx.effect(() => ctx.tools.guard(localInstallGuard), 'dsh-plugin-powerful/no-local-install')
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
const SANDBOX_MARKER = 'dsh-plugin-powerful/sandbox'

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
        force: { type: 'boolean', description: 'For seed: overwrite existing entries. For stop: kill a listener that is not the recorded process.' },
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
