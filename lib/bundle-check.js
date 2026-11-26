/**
 * Read-only structural check of a DSH bundle directory.
 *
 * Shared by the `dsh_plugin_check` tool and the scaffolder, which runs it on
 * whatever it just generated. Node built-ins only: a preset row resolves its
 * imports from the profile, so `@deepseek-ai/*` helpers are not importable here.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** Plugin Manager's per-image icon limit. */
const MAX_ICON_BYTES = 256 * 1024
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])

/**
 * Run every check against one bundle directory.
 * @param {string} root - package directory (resolved inside).
 * @returns {Promise<{ok: boolean, target: string, summary: {pass: number, warn: number, fail: number}, checks: {id: string, status: string, message: string}[]}>}
 */
export async function inspectBundle(root) {
  const target = resolve(root)
  /** @type {{id: string, status: string, message: string}[]} */
  const checks = []
  const add = (id, status, message) => { checks.push({ id, status, message }) }

  let info
  try {
    info = await stat(target)
  } catch {
    add('directory', 'fail', `no such directory: ${target}`)
    return finish(target, checks)
  }
  if (!info.isDirectory()) {
    add('directory', 'fail', `not a directory: ${target}`)
    return finish(target, checks)
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    add('manifest', 'pass', 'package.json is valid JSON')
  } catch (error) {
    add('manifest', 'fail', `package.json unreadable or invalid: ${message(error)}`)
    return finish(target, checks)
  }

  checkIdentity(manifest, add)
  checkEntry(manifest, target, add)
  const patchPath = await checkPatch(manifest, target, add)
  checkLocaleExports(manifest, add)
  const meta = await checkLocaleFiles(target, add)
  await checkIcon(manifest, target, add)
  await checkDetail(meta, target, add)
  checkFilesWhitelist(manifest, add)
  if (patchPath !== undefined) await checkPatchBody(patchPath, add)
  await checkPrivacy(target, add)
  await checkSecurity(manifest, target, add)

  return finish(target, checks)
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
async function checkPatchBody(path, add) {
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

/** Extensions worth reading as text. Everything else is treated as binary. */
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml',
  '.md', '.markdown', '.txt', '.svg', '.html', '.css', '.sh', '.ps1', '.cmd', '.bat', '.toml',
])

/** Directories that are never part of a delivered bundle. */
const SKIP_DIRS = new Set(['node_modules', 'tmp', '.tmp', '.git', '.debug', '.dsh-memory', 'dist', 'build', 'coverage'])

/** Credential shapes worth failing on. Deliberately narrow: a false alarm here is worse than a miss. */
const SECRET_PATTERNS = [
  { id: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
]

const EMAIL_ALLOWLIST = /@(?:example\.(?:com|org|net)|test\.local|localhost|users\.noreply\.github\.com)$/i

/**
 * Account names that are placeholders, not people.
 *
 * A path like `/Users/someone` in a test fixture says nothing about the author,
 * and flagging it would teach people to ignore this check.
 */
const PLACEHOLDER_ACCOUNTS = /^(?:user|username|name|you|yourname|someone|somebody|me|test|tester|example|foo|bar|bob|alice|<.*>|\{\{.*\}\}|\$.*)$/i

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'publish', 'postpublish']

const DYNAMIC_CODE = [
  { id: 'eval', pattern: /\beval\s*\(/ },
  { id: 'new Function', pattern: /\bnew\s+Function\s*\(/ },
  { id: 'vm sandbox', pattern: /\bvm\s*\.\s*runIn/ },
]

const CAPABILITY_PATTERNS = {
  'runs commands': /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/,
  'opens network connections': /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(|\bhttps?\.request\s*\(|\bnet\.connect\s*\(/,
  'writes files': /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmSync|unlink|unlinkSync)\s*\(/,
  'reads the environment': /process\.env\b/,
}

/** Every readable text file in the package, with its relative path. */
async function collectTextFiles(root) {
  const found = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(directory, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const full = join(directory, entry.name)
      if (!TEXT_EXTENSIONS.has(extname(full).toLowerCase())) continue
      try {
        found.push({ path: relative(root, full).split('\\').join('/'), text: await readFile(full, 'utf8') })
      } catch {
        // Unreadable text file: nothing to scan.
      }
    }
  }
  await walk(root)
  return found
}

/**
 * Privacy: a delivered package must not carry the author's machine or credentials.
 *
 * Home paths and credentials fail; other absolute machine paths warn, because a
 * published bundle shows a reviewer where the author works even when nothing
 * secret leaks.
 */
async function checkPrivacy(root, add) {
  const files = await collectTextFiles(root)

  const homeHits = []
  const machineHits = []
  const secretHits = []
  const emailHits = []

  for (const file of files) {
    for (const match of file.text.matchAll(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g)) {
      const who = match[1]
      if (PLACEHOLDER_ACCOUNTS.test(who)) continue
      homeHits.push(`${file.path}: ${match[0].slice(0, 40)}`)
    }
    for (const match of file.text.matchAll(/\b[A-Za-z]:\\(?:Workplace|Projects|Code|Users\\[^\\]+\\[^\\]+)/g)) {
      if (/[<{]/.test(match[0])) continue
      machineHits.push(`${file.path}: ${match[0]}`)
    }
    for (const { id, pattern } of SECRET_PATTERNS) {
      if (pattern.test(file.text)) secretHits.push(`${file.path} (${id})`)
    }
    for (const match of file.text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!EMAIL_ALLOWLIST.test(match[0])) emailHits.push(`${file.path}: ${match[0]}`)
    }
  }

  add('privacy:home-paths', homeHits.length === 0 ? 'pass' : 'fail',
    homeHits.length === 0
      ? 'no user home directory path appears in the package'
      : `${homeHits.length} home directory path(s) leak the author's account: ${homeHits.slice(0, 4).join(' | ')}`)

  add('privacy:credentials', secretHits.length === 0 ? 'pass' : 'fail',
    secretHits.length === 0
      ? 'no credential shape (private key, API key, token) found'
      : `${secretHits.length} credential shape(s): ${secretHits.slice(0, 4).join(' | ')}`)

  add('privacy:machine-paths', machineHits.length === 0 ? 'pass' : 'warn',
    machineHits.length === 0
      ? 'no author-specific machine path found'
      : `${machineHits.length} absolute machine path(s) show the author's layout: ${machineHits.slice(0, 3).join(' | ')}`)

  add('privacy:emails', emailHits.length === 0 ? 'pass' : 'warn',
    emailHits.length === 0
      ? 'no personal email address found'
      : `${emailHits.length} email address(es) outside the example domains: ${emailHits.slice(0, 3).join(' | ')}`)
}

/**
 * Security: what this plugin can do when it runs, and whether any of it is a
 * pattern known to be dangerous.
 *
 * Two halves, because they answer different questions. Install hooks and dynamic
 * code are failures — they execute on the user's machine before any judgement is
 * possible. Capabilities are reported, not judged: a plugin that runs commands is
 * not automatically unsafe, but the reviewer must be able to see that it does,
 * and where.
 */
async function checkSecurity(manifest, root, add) {
  const hooks = Object.keys(manifest.scripts ?? {}).filter(name => INSTALL_HOOKS.includes(name))
  add('security:install-hooks', hooks.length === 0 ? 'pass' : 'fail',
    hooks.length === 0
      ? 'no install, prepare, or publish script runs at install time'
      : `scripts run at install time: ${hooks.join(', ')} — these execute on the user's machine before the plugin is activated`)

  const code = (await collectTextFiles(root)).filter(file => /\.(?:js|mjs|cjs|ts|tsx|jsx)$/.test(file.path)
    && (Array.isArray(manifest.files) ? covers(manifest.files, file.path) : true))
  const dynamic = []
  const shellRisk = []
  const capabilities = new Map()
  for (const file of code) {
    for (const { id, pattern } of DYNAMIC_CODE) {
      if (pattern.test(file.text)) dynamic.push(`${file.path} (${id})`)
    }
    if (/\bshell\s*:\s*true/.test(file.text) && /\$\{/.test(file.text)) shellRisk.push(file.path)
    for (const [label, pattern] of Object.entries(CAPABILITY_PATTERNS)) {
      if (!pattern.test(file.text)) continue
      if (!capabilities.has(label)) capabilities.set(label, [])
      capabilities.get(label).push(file.path)
    }
  }

  add('security:dynamic-code', dynamic.length === 0 ? 'pass' : 'fail',
    dynamic.length === 0
      ? 'no dynamic code evaluation: no eval call, no Function constructor, no vm sandbox'
      : `${dynamic.length} dynamic code evaluation(s): ${dynamic.slice(0, 4).join(' | ')}`)

  add('security:shell-interpolation', shellRisk.length === 0 ? 'pass' : 'warn',
    shellRisk.length === 0
      ? 'no shell command built from an interpolated string'
      : `shell command with interpolation in: ${shellRisk.join(', ')} — a value containing a quote can change the command`)

  const parts = [...capabilities].map(([label, paths]) => `${label} (${paths.join(', ')})`)
  add('security:capabilities', parts.length === 0 ? 'pass' : 'warn',
    parts.length === 0
      ? 'the package runs no commands, opens no connections, and writes no files'
      : `this plugin can: ${parts.join('; ')}`)
}

function resolveExport(value) {  if (typeof value === 'string') return value
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
