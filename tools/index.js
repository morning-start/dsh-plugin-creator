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

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'

export const name = 'powerful-tools'
export const inject = ['tools']

/** Plugin Manager's per-image icon limit. */
const MAX_ICON_BYTES = 256 * 1024
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const STATUS = ['pass', 'warn', 'fail']

/**
 * Register every Creator-mode tool this bundle adds.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(pluginCheck), 'dsh-plugin-powerful/dsh_plugin_check')
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
              status: { type: 'string', enum: STATUS },
              message: { type: 'string' },
            },
            required: ['id', 'status', 'message'],
          },
        },
      },
      required: ['ok', 'target', 'summary', 'checks'],
    },
    render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
  },
  async execute(args) {
    const root = resolve(String(args.path))
    const report = await inspectBundle(root)
    return report
  },
}

/**
 * Run every check against one bundle directory.
 * @param {string} root - resolved package directory.
 */
async function inspectBundle(root) {
  /** @type {{id: string, status: string, message: string}[]} */
  const checks = []
  const add = (id, status, message) => { checks.push({ id, status, message }) }

  let info
  try {
    info = await stat(root)
  } catch {
    add('directory', 'fail', `no such directory: ${root}`)
    return finish(root, checks)
  }
  if (!info.isDirectory()) {
    add('directory', 'fail', `not a directory: ${root}`)
    return finish(root, checks)
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    add('manifest', 'pass', 'package.json is valid JSON')
  } catch (error) {
    add('manifest', 'fail', `package.json unreadable or invalid: ${message(error)}`)
    return finish(root, checks)
  }

  checkIdentity(manifest, add)
  checkEntry(manifest, root, add)
  const patchPath = await checkPatch(manifest, root, add)
  checkLocaleExports(manifest, add)
  const locale = await checkLocaleFiles(root, add)
  await checkIcon(manifest, root, add)
  await checkDetail(locale, root, add)
  checkFilesWhitelist(manifest, add)
  if (patchPath !== undefined) await checkPatchBody(patchPath, root, add)

  return finish(root, checks)
}

function finish(target, checks) {
  const count = (status) => checks.filter(check => check.status === status).length
  const summary = { pass: count('pass'), warn: count('warn'), fail: count('fail') }
  return { ok: summary.fail === 0, target, summary, checks }
}

function checkIdentity(manifest, add) {
  if (typeof manifest.name === 'string' && manifest.name.length > 0) {
    add('name', 'pass', `name: ${manifest.name}`)
  } else {
    add('name', 'fail', 'package.json declares no name')
  }
  if (typeof manifest.version === 'string' && manifest.version.length > 0) {
    add('version', 'pass', `version: ${manifest.version}`)
  } else {
    add('version', 'fail', 'package.json declares no version; Plugin Manager cannot update or compare it')
  }
}

function checkEntry(manifest, root, add) {
  const entry = resolveExport(manifest.exports?.['.'] ?? manifest.main)
  if (entry === undefined) {
    add('entry', 'fail', 'package.json exports no entry module ("." export or main)')
    return
  }
  const path = resolve(root, entry)
  if (!inside(root, path)) {
    add('entry', 'fail', `entry module escapes the package: ${entry}`)
    return
  }
  add('entry', 'pass', `entry module: ${entry}`)
}

async function checkPatch(manifest, root, add) {
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared !== 'string' || declared.length === 0) {
    add('patch-declared', 'fail', 'package.json declares no dsh.bundle.patch, so this package is not a bundle')
    return undefined
  }
  const path = resolve(root, declared)
  if (!inside(root, path)) {
    add('patch-declared', 'fail', `bundle patch escapes the package: ${declared}`)
    return undefined
  }
  try {
    await stat(path)
  } catch {
    add('patch-declared', 'fail', `dsh.bundle.patch names a missing file: ${declared}`)
    return undefined
  }
  add('patch-declared', 'pass', `bundle patch: ${declared}`)
  return path
}

function checkLocaleExports(manifest, add) {
  const exports = manifest.exports ?? {}
  if (typeof exports['./locale/*.json'] === 'string') {
    add('locale-export', 'pass', 'exports ./locale/*.json')
  } else {
    add('locale-export', 'warn', 'no "./locale/*.json" export: Plugin Manager cannot show a localized title or description')
  }
}

async function checkLocaleFiles(root, add) {
  const directory = join(root, 'locale')
  let names
  try {
    names = await readdir(directory)
  } catch {
    add('locale-en', 'warn', 'no locale/ directory: the bundle falls back to package.json name and description')
    return undefined
  }
  const files = names.filter(file => file.endsWith('.json'))
  if (files.length === 0) {
    add('locale-en', 'warn', 'locale/ holds no .json dictionary')
    return undefined
  }
  add('locale-files', 'pass', `locale dictionaries: ${files.join(', ')}`)

  const english = files.includes('en.json') ? 'en.json' : files[0]
  if (english !== 'en.json') {
    add('locale-en', 'warn', 'no locale/en.json: English falls back to package.json name and description')
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(directory, english), 'utf8'))
  } catch (error) {
    add('locale-en', 'fail', `${english} is not valid JSON: ${message(error)}`)
    return undefined
  }
  const meta = parsed?.meta ?? {}
  const problems = []
  if (typeof meta.title !== 'string' || meta.title.length === 0) problems.push('meta.title')
  if (typeof meta.description !== 'string' || meta.description.length === 0) problems.push('meta.description')
  if (problems.length > 0) {
    add('locale-meta', 'warn', `${english} is missing ${problems.join(' and ')}`)
  } else {
    add('locale-meta', 'pass', `${english} declares meta.title and meta.description`)
  }
  return meta
}

async function checkIcon(manifest, root, add) {
  const declared = manifest.icon ?? resolveExport(manifest.exports?.['./icon'])
  if (typeof declared !== 'string' || declared.length === 0) {
    add('icon', 'warn', 'no icon declared (package.json "icon" or "./icon" export): the panel draws default artwork')
    return
  }
  const path = resolve(root, declared)
  if (!inside(root, path)) {
    add('icon', 'fail', `icon escapes the package: ${declared}`)
    return
  }
  if (!ICON_EXTENSIONS.has(extname(path).toLowerCase())) {
    add('icon', 'fail', `icon must be SVG, PNG, JPEG, or WebP: ${declared}`)
    return
  }
  let info
  try {
    info = await stat(path)
  } catch {
    add('icon', 'fail', `declared icon does not exist: ${declared}`)
    return
  }
  if (info.size === 0) {
    add('icon', 'fail', `icon is empty: ${declared}`)
    return
  }
  if (info.size > MAX_ICON_BYTES) {
    add('icon', 'fail', `icon is ${info.size} bytes, above the ${MAX_ICON_BYTES}-byte limit: ${declared}`)
    return
  }
  add('icon', 'pass', `icon: ${declared} (${info.size} bytes)`)
}

async function checkDetail(meta, root, add) {
  const declared = meta?.detail
  if (declared === undefined) return
  if (typeof declared !== 'string' || declared.length === 0) {
    add('detail', 'fail', 'meta.detail is not a path string')
    return
  }
  if (!/\.(md|markdown)$/i.test(declared)) {
    add('detail', 'fail', `meta.detail must end in .md or .markdown: ${declared}`)
    return
  }
  const path = resolve(root, declared)
  if (!inside(root, path)) {
    add('detail', 'fail', `meta.detail escapes the package: ${declared}`)
    return
  }
  try {
    await stat(path)
  } catch {
    add('detail', 'fail', `meta.detail names a missing document: ${declared}`)
    return
  }
  add('detail', 'pass', `detail document: ${declared}`)
}

function checkFilesWhitelist(manifest, add) {
  const files = manifest.files
  if (!Array.isArray(files)) {
    add('files', 'warn', 'no "files" whitelist: a published package would include test output, tmp/, and other artifacts')
    return
  }
  const patch = manifest.dsh?.bundle?.patch
  const missing = []
  if (typeof patch === 'string' && !covers(files, patch)) missing.push(patch)
  if (!files.some(entry => entry === 'locale' || entry === 'locale/*' || entry.startsWith('locale/'))) {
    missing.push('locale')
  }
  if (missing.length > 0) {
    add('files', 'warn', `"files" omits ${missing.join(', ')}: the packed package would not contain it`)
    return
  }
  add('files', 'pass', `"files" lists ${files.length} entries including the patch and locale`)
}

/**
 * Line-level sanity check of the patch file. This is not a YAML parse: it only
 * catches the two mistakes that fail silently at install time — a patch that
 * carries no rows, and a row naming a relative module that does not exist.
 */
async function checkPatchBody(path, root, add) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    add('patch-body', 'fail', `patch unreadable: ${message(error)}`)
    return
  }
  if (!/^\s*-\s*(insert:|id:)/m.test(text)) {
    add('patch-body', 'fail', 'patch declares no "insert:" block and no id-targeted row')
    return
  }
  add('patch-body', 'pass', 'patch declares at least one row')

  const relativeNames = [...text.matchAll(/^\s*-?\s*name:\s*['"]?(\.[^'"\s]*)['"]?\s*$/gm)].map(match => match[1])
  if (relativeNames.length === 0) return
  const missing = []
  for (const specifier of relativeNames) {
    try {
      await stat(resolve(dirname(path), specifier))
    } catch {
      missing.push(specifier)
    }
  }
  if (missing.length > 0) {
    add('patch-relative', 'fail', `patch names missing relative modules: ${missing.join(', ')}`)
  } else {
    add('patch-relative', 'pass', `patch names ${relativeNames.length} relative module(s), all present`)
  }
}

function resolveExport(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    for (const key of ['default', 'import']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return undefined
}

function covers(files, target) {
  const normalized = target.replace(/^\.\//, '')
  return files.some(entry => {
    const pattern = entry.replace(/^\.\//, '')
    if (pattern === normalized) return true
    if (!pattern.includes('*')) return normalized === pattern || normalized.startsWith(`${pattern}/`)
    const prefix = pattern.slice(0, pattern.indexOf('*'))
    return normalized.startsWith(prefix)
  })
}

function inside(root, path) {
  const child = relative(root, path)
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function renderSummary(value) {
  const lines = [`${value.target}: ${value.summary.fail} fail, ${value.summary.warn} warn, ${value.summary.pass} pass`]
  const findings = value.checks.filter(check => check.status !== 'pass')
  if (findings.length === 0) {
    lines.push('Every structural check passed.')
  } else {
    for (const check of findings) lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.message}`)
  }
  return lines.join('\n')
}
