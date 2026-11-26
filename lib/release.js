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
import { homedir } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

  // A tag is a claim that this commit is that version. CI refuses the mismatch;
  // catching it here means the answer arrives before the tag is pushed.
  //
  // Only meaningful when the package *is* the repository root: a fixture nested
  // inside some other repository would otherwise be judged by that repository's
  // tag, which is how a test package at 1.0.0 got failed by the host's v0.1.3.
  const top = spawnSync('git rev-parse --show-toplevel', {
    cwd: target,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  })
  const atRoot = top.status === 0 && resolve((top.stdout ?? '').trim()) === resolve(target)
  const exactTag = atRoot
    ? spawnSync('git describe --tags --exact-match HEAD', { cwd: target, encoding: 'utf8', shell: true, windowsHide: true })
    : { status: 1, stdout: '' }
  const tag = exactTag.status === 0 ? (exactTag.stdout ?? '').trim() : ''
  if (/^v\d/.test(tag)) {
    const tagged = tag.replace(/^v/, '')
    add('release:tag', tagged === manifest.version,
      tagged === manifest.version
        ? `tag ${tag} matches the version`
        : `tag ${tag} does not match version ${manifest.version}: the release job would refuse this`)
  } else {
    add('release:tag', true, atRoot
      ? 'HEAD is not on a version tag, so there is nothing to compare'
      : 'the package is not the repository root, so no tag applies to it')
  }

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

/**
 * The tool that can publish this machine: npm when it is installed, otherwise the
 * pnpm that ships inside the DSH runtime.
 *
 * `npm` is absent from many DSH installs — the runtime carries pnpm instead — so a
 * release CLI that assumes npm works on the author's machine and fails on the
 * user's.
 */
export function resolvePublisher({ env = process.env } = {}) {
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd --version' : 'npm --version', {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  })
  if (npm.status === 0) return { kind: 'npm', command: 'npm publish' }

  const roots = [env.DSH_PRIMARY_RUNTIME, join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime')]
    .filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  for (const root of roots) {
    const pnpm = join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    if (!existsSync(pnpm)) continue
    const probe = spawnSync(`"${process.execPath}" "${pnpm}" --version`, { encoding: 'utf8', shell: true, windowsHide: true })
    if (probe.status !== 0) continue
    return { kind: 'pnpm', command: `"${process.execPath}" "${pnpm}" publish`, version: (probe.stdout ?? '').trim() }
  }
  return undefined
}

/**
 * Publish the package. Destructive and irreversible, so the caller has to say so.
 * @returns {{ok: boolean, kind: string, version: string, tag: string, output: string, dryRun: boolean}}
 */
export function publishRelease(directory, options = {}) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.private === true) {
    throw new Error('private: true blocks publishing; remove it for a registry release, or distribute the tarball instead')
  }
  const publisher = options.publisher ?? resolvePublisher()
  if (publisher === undefined) {
    throw new Error('no publisher found: neither npm nor the pnpm inside the DSH runtime is available')
  }
  const dryRun = options.dryRun === true
  if (!dryRun && options.confirmed !== true) {
    throw new Error('publishing is irreversible: pass confirmed (CLI: --yes) once you have read what will be published')
  }

  const tag = options.tag ?? 'latest'
  // pnpm refuses to publish from a dirty or untagged branch unless told to skip the
  // check; npm has no such flag.
  const flags = publisher.kind === 'pnpm'
    ? ['--tag', tag, '--no-git-checks']
    : ['--tag', tag]
  if (dryRun) flags.push('--dry-run')
  if (typeof options.access === 'string') flags.push('--access', options.access)
  if (typeof options.otp === 'string') flags.push('--otp', options.otp)

  const run = spawnSync(`${publisher.command} ${flags.join(' ')}`, {
    cwd: directory,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
  return {
    ok: run.status === 0,
    kind: publisher.kind,
    version: manifest.version,
    tag,
    dryRun,
    output,
    status: run.status,
  }
}

/**
 * Wait for the registry to actually serve the version.
 *
 * `npm publish` prints `+ name@version` and returns before the package is
 * installable: sometimes only a `0.0.0-stage` placeholder lands, sometimes the
 * tarball answers 404 for a few minutes. Judge by the artifact.
 */
export async function verifyPublished(name, version, options = {}) {
  // A fresh publish is not visible immediately: the registry accepts the tarball,
  // then takes minutes to serve it. Polling is the difference between "the release
  // worked" and "we asked 300ms too early".
  const attempts = Math.max(1, options.attempts ?? 1)
  const intervalMs = options.intervalMs ?? 15_000
  let last
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await verifyOnce(name, version, options)
    if (last.ok || attempt === attempts) break
    await new Promise(done => setTimeout(done, intervalMs))
  }
  return last
}

async function verifyOnce(name, version, options = {}) {
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  const findings = []
  const timeout = options.timeoutMs ?? 10_000

  let meta
  try {
    const response = await fetch(`${registry}/${encoded}`, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    meta = await response.json()
  } catch (error) {
    findings.push({ id: 'npm:reachable', status: 'fail', message: `cannot read ${name} from ${registry}: ${error.message}` })
    return { ok: false, findings }
  }

  const latest = meta?.['dist-tags']?.[options.tag ?? 'latest']
  findings.push(latest === version
    ? { id: 'npm:dist-tag', status: 'pass', message: `${options.tag ?? 'latest'} points at ${version}` }
    : { id: 'npm:dist-tag', status: 'fail', message: `${options.tag ?? 'latest'} points at ${latest ?? '<none>'}, expected ${version} (a fresh name can land as 0.0.0-stage; publishing the same version again attaches the real one)` })

  const tarball = meta?.versions?.[version]?.dist?.tarball
  if (typeof tarball !== 'string') {
    findings.push({ id: 'npm:tarball', status: 'fail', message: `${version} is not in the registry metadata yet` })
    return { ok: findings.every(item => item.status === 'pass'), findings }
  }
  try {
    const head = await fetch(tarball, { method: 'HEAD', signal: AbortSignal.timeout(timeout) })
    findings.push(head.ok
      ? { id: 'npm:tarball', status: 'pass', message: `the tarball downloads (${head.status})` }
      : { id: 'npm:tarball', status: 'fail', message: `the tarball answers ${head.status}; the package is not installable yet` })
  } catch (error) {
    findings.push({ id: 'npm:tarball', status: 'fail', message: `the tarball is unreachable: ${error.message}` })
  }
  return { ok: findings.every(item => item.status === 'pass'), findings }
}

/**
 * Create the GitHub Release and attach the tarball, so a marketplace `tarball:`
 * field has something stable to point at.
 *
 * The asset name is deliberately version-free: under `latest/download/` the tag
 * resolves at request time but the filename is taken literally, so a version in
 * the name 404s at the next release.
 */
export function createGithubRelease(directory, options = {}) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const tag = options.tag ?? `v${manifest.version}`
  const tarball = options.tarball
  if (typeof tarball !== 'string' || !existsSync(tarball)) {
    throw new Error(`gh-release needs a packed tarball; run "pack" first (got ${JSON.stringify(tarball)})`)
  }
  const asset = join(options.assetDir ?? dirname(tarball), `${manifest.name.replace(/^@[^/]+\//, '')}.tgz`)
  if (resolve(tarball) !== resolve(asset)) copyFileSync(tarball, asset)

  const flags = ['--title', `'${options.title ?? `${manifest.name} ${tag}`}'`]
  if (options.draft === true) flags.push('--draft')
  if (typeof options.notesFile === 'string') flags.push('--notes-file', `'${options.notesFile}'`)
  else flags.push('--generate-notes')

  const command = `gh release create ${tag} "${asset}" ${flags.join(' ')}`
  if (options.dryRun === true) return { ok: true, dryRun: true, command, tag, asset }
  const run = spawnSync(command, {
    cwd: directory,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
  const url = /https:\/\/github\.com\/\S+\/releases\/tag\/\S+/.exec(output)?.[0]
  return { ok: run.status === 0, command, tag, asset, url, output, status: run.status }
}
/** Write the tarball to `outDir`. Publishing is the caller's decision, not ours. */
export function packRelease(directory, outDir) {
  // The packer runs through a shell, so a quote in the path would change the
  // command rather than name a directory; `%` would be expanded as pnpm's own
  // `%s`/`%v` placeholders.
  if (/["%\r\n]/.test(outDir)) {
    throw new Error(`packRelease: refusing an output directory containing a quote, percent sign, or newline: ${JSON.stringify(outDir)}`)
  }
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
  const sandboxes = new Sandboxes(projectRoot)
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
