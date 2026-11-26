/**
 * Release checks: is this package safe to hand to `dsh plugin add`?
 *
 * Three questions, in the order they bite:
 *
 * 1. **What is actually in the tarball?** Asked of the packer, not guessed from
 *    `files` — `pnpm pack --dry-run --json` applies the same rules npm does.
 * 2. **Will DSH accept it?** Installation is blocked by an unmet
 *    `engines.dsh` (else by the DSH peer dependency). The running version comes
 *    from `dsh --version`, so the answer is about *this* installation.
 * 3. **Can it be installed and rolled back?** Static checks cannot prove that;
 *    only installing it somewhere does. That is `rehearse`, which packs for real,
 *    installs into a sandbox, and reads the composed config back.
 *
 * Publishing is deliberately not automated: `npm publish` is irreversible and
 * the account decision is the user's. This module tells you whether it would be
 * safe and what to run.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { covers, walk } from './rules.js'
import { Sandboxes } from './sandbox.js'

/** Subset of semver: `^`, `~`, `>=`, `<=`, `>`, `<`, `=`, exact, and `||`. */
export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  return String(range).split('||').some((alternative) => {
    const terms = alternative.trim().split(/\s+/).filter(term => term.length > 0)
    if (terms.length === 0) return false
    return terms.every(term => satisfiesTerm(parsed, term))
  })
}

function satisfiesTerm(version, term) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/.exec(term)
  if (match === null) return false
  const [, operator = '=', raw] = match
  const target = parseVersion(raw)
  if (target === undefined) return false

  switch (operator) {
    case '=': return compare(version, target) === 0
    case '>': return compare(version, target) > 0
    case '>=': return compare(version, target) >= 0
    case '<': return compare(version, target) < 0
    case '<=': return compare(version, target) <= 0
    case '^': {
      if (compare(version, target) < 0) return false
      const upper = target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: target.patch + 1 }
      return compare(version, upper) < 0
    }
    case '~': {
      if (compare(version, target) < 0) return false
      return compare(version, { major: target.major, minor: target.minor + 1, patch: 0 }) < 0
    }
    default:
      return false
  }
}

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] }
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  const left = a.pre.split('.')
  const right = b.pre.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index]
    const two = right[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two)
    if (numeric) return Number(one) < Number(two) ? -1 : 1
    return one < two ? -1 : 1
  }
  return 0
}

/** The running DSH version, or undefined when it cannot be determined. */
export function dshVersion(launcher = process.platform === 'win32' ? 'dsh.cmd' : 'dsh') {
  const result = spawnSync(`${launcher} --version`, { encoding: 'utf8', shell: true, windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  const line = result.stdout.trim().split(/\r?\n/)[0].trim()
  return parseVersion(line) === undefined ? undefined : line
}

/**
 * What the packer would put in the tarball.
 *
 * Prefers the real packer; falls back to applying `files` ourselves and says so,
 * because an approximation must never be reported as the package surface.
 */
export function packSurface(directory, options = {}) {
  for (const command of [`pnpm pack --dry-run --json`, `npm pack --dry-run --json`]) {
    const result = spawnSync(command, {
      cwd: directory,
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') continue
    const parsed = parsePackJson(result.stdout)
    if (parsed !== undefined) return { ...parsed, source: command.split(' ')[0] }
  }
  return { ...approximateSurface(directory, options), source: 'files-field' }
}

function parsePackJson(text) {
  const start = text.indexOf('[')
  const objectStart = text.indexOf('{')
  const from = start >= 0 && (objectStart < 0 || start < objectStart) ? start : objectStart
  if (from < 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(text.slice(from))
  } catch {
    return undefined
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  const files = entry?.files
  if (!Array.isArray(files)) return undefined
  const normalised = files
    .map(file => (typeof file === 'string' ? { path: file, size: 0 } : { path: file.path ?? '', size: Number(file.size ?? 0) }))
    .filter(file => file.path.length > 0)
  return {
    files: normalised.map(file => file.path),
    totalSize: normalised.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0),
  }
}

function approximateSurface(directory, options) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const listed = Array.isArray(manifest.files) ? manifest.files : []
  const files = (options.files ?? []).filter(file => listed.some(pattern => covers(pattern, file)))
  return { files, totalSize: 0, approximate: true }
}

/**
 * Release readiness for a package directory.
 * @returns {Promise<{ok: boolean, target: string, summary: object, checks: object[], package: object}>}
 */
export async function inspectRelease(directory, options = {}) {
  const target = resolve(directory)
  const checks = []
  const add = (id, passed, message, level = 'fail') => {
    checks.push({ id, status: passed ? 'pass' : level, message })
    return passed
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  } catch (error) {
    add('release:manifest', false, `package.json is unreadable: ${error.message}`)
    return finish(target, checks, {})
  }

  add('release:manifest', true, 'package.json parses')
  add('release:name', typeof manifest.name === 'string' && manifest.name.length > 0, 'the package has a name')
  add('release:description', typeof manifest.description === 'string' && manifest.description.length >= 20,
    'the package has a description of at least 20 characters')
  add('release:version', parseVersion(manifest.version) !== undefined, `version ${JSON.stringify(manifest.version)} is semver`)

  const entry = manifest.exports?.['.']
  const entryFile = typeof entry === 'string' ? entry : entry?.import ?? entry?.default
  add('release:entry', typeof entryFile === 'string' && existsSync(join(target, entryFile)),
    `exports["."] points at an existing file${typeof entryFile === 'string' ? ` (${entryFile})` : ''}`)

  const patch = manifest.dsh?.bundle?.patch
  add('release:patch', typeof patch === 'string' && existsSync(join(target, patch)),
    `dsh.bundle.patch points at an existing file${typeof patch === 'string' ? ` (${patch})` : ''}`)

  add('release:private', manifest.private !== true,
    manifest.private === true
      ? 'private: true blocks `npm publish` — remove it for a registry release, keep it for a tarball or link release'
      : 'not marked private, so a registry release is possible',
    'warn')

  const engine = manifest.engines?.dsh
  const peer = manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? manifest.dependencies?.['@deepseek-ai/dsh']
  const running = options.dshVersion ?? dshVersion(options.launcher)
  const requirement = engine ?? peer
  if (requirement === undefined) {
    add('release:compatibility', false,
      'no engines.dsh and no @deepseek-ai/dsh dependency: DSH cannot check compatibility, so a version mismatch will only show up at install time',
      'warn')
  } else if (running === undefined) {
    add('release:compatibility', false, `requires ${requirement}, but the running DSH version is unknown (run \`dsh --version\`)`, 'warn')
  } else {
    add('release:compatibility', satisfies(running, requirement),
      `requires ${requirement}; running ${running}`)
  }

  const surface = options.surface ?? packSurface(target, { files: await walk(target) })
  const junk = surface.files.filter(file => /(^|\/)(node_modules|tmp|\.debug|\.git)\//.test(file) || file.endsWith('.tgz'))
  add('release:surface', junk.length === 0,
    junk.length === 0
      ? `the tarball holds ${surface.files.length} files${surface.approximate === true ? ' (approximated from "files")' : ` (${surface.source})`}`
      : `the tarball would include build leftovers: ${junk.slice(0, 5).join(', ')}${junk.length > 5 ? ` and ${junk.length - 5} more` : ''}`)

  if (surface.totalSize > 0) {
    add('release:size', surface.totalSize < 5 * 1024 * 1024,
      `the tarball is ${(surface.totalSize / 1024).toFixed(1)} kB unpacked`,
      'warn')
  }

  const missing = ['package.json', 'README.md', 'icon.svg'].filter(file => !surface.files.includes(file) && !surface.approximate)
  add('release:contents', missing.length === 0,
    missing.length === 0 ? 'the tarball carries the manifest, README, and icon' : `the tarball is missing ${missing.join(', ')}`)

  return finish(target, checks, manifest)
}

function finish(target, checks, manifest) {
  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return { ok: summary.fail === 0, target, summary, checks, package: { name: manifest.name, version: manifest.version } }
}

/** Write the tarball to `outDir`. Publishing is the caller's decision, not ours. */
export function packRelease(directory, outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const command of [`pnpm pack --out "${join(outDir, '%s-%v.tgz')}"`, `npm pack --pack-destination "${outDir}"`]) {
    const result = spawnSync(command, { cwd: directory, encoding: 'utf8', shell: true, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (result.status !== 0) continue
    const match = /([^\r\n]+\.tgz)\s*$/m.exec(result.stdout.trim())
    if (match !== null) return { tarball: resolve(directory, match[1].trim()), command }
  }
  throw new Error('packRelease: neither pnpm nor npm produced a tarball')
}

/**
 * Install the packed tarball into a sandbox and read the composed config back.
 *
 * This is the only check that answers "will it actually install and activate".
 * The sandbox is reused, so a second rehearsal is cheap.
 */
export async function rehearseRelease(directory, options = {}) {
  const projectRoot = resolve(options.project ?? directory)
  const name = options.sandbox ?? 'rollback'
  const sandboxes = new Sandboxes(projectRoot, options.launcher === undefined ? {} : { launcher: options.launcher })
  const steps = []

  const registry = sandboxes.read()
  if (registry.sandboxes[name] === undefined) {
    const created = await sandboxes.create(name, { plugin: directory })
    steps.push({ step: 'sandbox', detail: `created ${name} (port ${created.port}, profile ${created.profile})` })
  } else {
    steps.push({ step: 'sandbox', detail: `reusing ${name}` })
  }
  const entry = sandboxes.read().sandboxes[name]

  const packed = packRelease(directory, join(projectRoot, 'tmp', 'release'))
  steps.push({ step: 'pack', detail: packed.tarball })

  sandboxes.runDsh(['plugin', '--profile', entry.profile, 'add', packed.tarball], entry.home)
  steps.push({ step: 'install', detail: `dsh plugin add ${packed.tarball}` })

  const config = sandboxes.runDsh(['--profile', entry.profile, '--dump-config'], entry.home)
  const name_ = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name
  const present = config.includes(name_)
  const broken = /did not activate/.exec(config)
  steps.push({ step: 'verify', detail: present ? `${name_} appears in the composed config` : `${name_} is absent from the composed config` })
  if (broken !== null) steps.push({ step: 'verify', detail: `activation failed: ${broken[0]}` })

  return {
    ok: present && broken === null,
    sandbox: name,
    tarball: packed.tarball,
    steps,
    rollback: `dsh plugin --profile ${entry.profile} remove ${name_}`,
    publish: `npm publish ${packed.tarball}`,
  }
}
