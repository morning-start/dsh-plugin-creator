/**
 * Sandbox engine: one project, many isolated test environments, all reused.
 *
 * A sandbox is a folder pair plus a profile and a port:
 *
 *   <project>/tmp/sandboxes/registry.json      the register (git-ignored)
 *   <project>/tmp/sandboxes/<name>/sandbox.json ownership marker
 *   <project>/tmp/sandboxes/<name>/home/       DSH_HOME for that sandbox
 *   <project>/tmp/sandboxes/<name>/workspace/  the copy sessions run in
 *
 * Two consumers share this file: `scripts/sandbox.mjs` (a CLI) and the
 * `dsh_sandbox` tool (Creator mode). Anything that decides *what* to test lives
 * in the skill; anything that is mechanical and repeatable lives here.
 *
 * Node built-ins only: a preset row resolves its imports from the profile, so
 * nothing from `@deepseek-ai/*` is importable from this package.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const MARKER_KIND = 'dsh-plugin-creator/sandbox'
const MARKER_VERSION = 1
const FIRST_PORT = 3100
const LAST_PORT = 3199
const URL_PATTERN = /dsh web:\s+(http:\/\/\S+)/
const CREDENTIAL_SESSION = 'client-connection/browser-session'

/**
 * Locate the `dsh` launcher without trusting PATH.
 *
 * The Host process is the desktop app, whose PATH is not the user's shell PATH.
 * The launcher sits next to the executable, so derive it from `process.execPath`
 * and fall back to PATH only when that layout is not there.
 */
export function resolveLauncher({ execPath = process.execPath, platform = process.platform } = {}) {
  const bin = join(dirname(execPath), 'resources', 'runtime', 'cli', 'bin')
  for (const name of platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']) {
    const candidate = join(bin, name)
    if (existsSync(candidate)) return candidate
  }
  return 'dsh'
}

function shellQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * The launcher as it has to appear on the command line.
 *
 * `launcher` carries two different things: a path to an executable
 * (`C:\...\DeepSeek Harness\...\dsh.cmd`) and an opaque command line
 * (`"node.exe" "fake-dsh.mjs"`, which the tests use). cmd.exe truncates an
 * unquoted path at its first space, which made every sandbox action fail inside
 * the desktop app while working from a shell, where the launcher fell back to the
 * bare `dsh`. Quoting everything would break the second form instead, so the two
 * are told apart by shape: a value that already contains a quote is a command
 * line and is left alone.
 */
export function launcherHead(launcher) {
  if (/["']/.test(launcher)) return launcher
  if (!/\s/.test(launcher)) return launcher
  const looksLikePath = /[\\/]/.test(launcher) || /\.(?:cmd|exe|bat|com|sh)$/i.test(launcher)
  return looksLikePath ? shellQuote(launcher) : launcher
}

/** One shell line: `dsh` is a `.cmd` on Windows, and an args array with `shell: true` is deprecated. */
function commandLine(launcher, args) {
  return [launcherHead(launcher), ...args.map(shellQuote)].join(' ')
}

/** Kill a process by pid, on the platform we are running on. */
function killPid(pid) {
  const command = process.platform === "win32" ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`
  spawnSync(command, { shell: true, encoding: "utf8", windowsHide: true })
}

function isPortFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.once('listening', () => server.close(() => done(true)))
    server.listen(port, '127.0.0.1')
  })
}

export class Sandboxes {
  /**
   * @param {string} projectRoot - project whose `tmp/sandboxes` holds the sandboxes.
   * @param {{ launcher?: string, environment?: NodeJS.ProcessEnv }} [options]
   */
  constructor(projectRoot, options = {}) {
    this.root = resolve(projectRoot)
    this.directory = join(this.root, 'tmp', 'sandboxes')
    this.registryPath = join(this.directory, 'registry.json')
    this.launcher = options.launcher ?? resolveLauncher()
    this.environment = options.environment ?? process.env
  }

  /* ---------------------------------------------------------------- paths */

  paths(name) {
    const base = join(this.directory, name)
    return {
      base,
      home: join(base, 'home'),
      workspace: join(base, 'workspace'),
      log: join(base, 'open.log'),
      marker: join(base, 'sandbox.json'),
    }
  }

  profileFor(name) {
    return `sb-${name}`
  }

  /* ------------------------------------------------------------- register */

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'))
      return { version: 1, sandboxes: {}, ...parsed }
    } catch {
      return { version: 1, sandboxes: {} }
    }
  }

  write(registry) {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  }

  /** @returns {{name: string, port: number, profile: string, model: string}[]} */
  list() {
    const registry = this.read()
    const names = Object.keys(registry.sandboxes).sort()
    const onDisk = existsSync(this.directory)
      ? readdirSync(this.directory, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)
      : []

    return {
      project: this.root,
      directory: this.directory,
      sandboxes: names.map(name => ({
        name,
        port: registry.sandboxes[name].port,
        profile: registry.sandboxes[name].profile,
        model: this.modelState(name),
        note: this.ownershipNote(name),
      })),
      unregistered: onDisk
        .filter(name => registry.sandboxes[name] === undefined)
        .map(name => ({ name, owner: this.readMarkerQuietly(name)?.project ?? null })),
      missing: names.filter(name => !onDisk.includes(name)),
    }
  }

  /* -------------------------------------------------------------- markers */

  writeMarker(name, entry) {
    const target = this.paths(name)
    const marker = {
      marker: MARKER_KIND,
      markerVersion: MARKER_VERSION,
      sandbox: name,
      project: this.root,
      profile: entry.profile,
      port: entry.port,
      plugin: entry.plugin,
      home: target.home,
      workspace: target.workspace,
      createdAt: entry.createdAt,
      note: 'Sandbox for testing a DSH plugin. It belongs to the project named above; its DSH_HOME is ./home. Never point another project at it, and never delete it to "reset" a run — create another sandbox instead.',
    }
    writeFileSync(target.marker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    return marker
  }

  readMarkerQuietly(name) {
    try {
      const marker = JSON.parse(readFileSync(this.paths(name).marker, 'utf8'))
      return marker.marker === MARKER_KIND ? marker : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Refuse to touch a sandbox folder that is not this project's.
   *
   * The register is per project, so this only trips on a copied folder, a moved
   * checkout, or a renamed directory — exactly where silently reusing another
   * project's sandbox would corrupt both.
   */
  assertOwnership(name, entry) {
    const target = this.paths(name)
    if (!existsSync(target.marker)) {
      // Created before markers existed, or the marker was deleted. Adopt it only
      // when this project's own register points at exactly this folder.
      if (entry === undefined || resolve(entry.home) !== target.home) {
        throw new Error(`sandbox "${name}" has no sandbox.json marker (${target.base}) and the register does not vouch for it; remove the folder and create the sandbox again`)
      }
      this.writeMarker(name, entry)
    }
    const marker = JSON.parse(readFileSync(target.marker, 'utf8'))
    if (marker.marker !== MARKER_KIND) {
      throw new Error(`${target.base} is not a sandbox of this toolkit (marker: ${JSON.stringify(marker.marker)})`)
    }
    if (resolve(marker.project) !== this.root) {
      throw new Error(`sandbox "${name}" belongs to another project: ${marker.project}\nRefusing to use it from ${this.root}`)
    }
    if (marker.sandbox !== name) {
      throw new Error(`sandbox "${name}" has a marker for "${marker.sandbox}"; the folder was renamed or copied`)
    }
    return marker
  }

  ownershipNote(name) {
    const marker = this.readMarkerQuietly(name)
    if (marker === undefined) return 'no marker: run fix-workspace to adopt it'
    if (resolve(marker.project) !== this.root) return `belongs to ${marker.project}`
    if (marker.sandbox !== name) return `marker names "${marker.sandbox}"`
    return ''
  }

  /** Resolve a registered sandbox, or throw with the command that creates it. */
  require(name) {
    const entry = this.read().sandboxes[name]
    if (entry === undefined) {
      throw new Error(`no sandbox "${name}"; create one with action "create" (name: "${name}")`)
    }
    this.assertOwnership(name, entry)
    return entry
  }

  /* --------------------------------------------------------------- create */

  async create(name, options = {}) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error('sandbox name must be lowercase letters, digits, and hyphens')
    }
    const registry = this.read()
    if (registry.sandboxes[name] !== undefined) {
      throw new Error(`sandbox "${name}" already exists; reuse it (action "open" or "start") instead of creating it again`)
    }

    const target = this.paths(name)
    mkdirSync(target.home, { recursive: true })
    mkdirSync(target.workspace, { recursive: true })

    const profile = this.profileFor(name)
    const port = await this.freePort(new Set(Object.values(registry.sandboxes).map(entry => entry.port)))
    const plugin = options.plugin === undefined ? this.root : resolve(options.plugin)

    this.runDsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], target.home)

    let installed = false
    if (existsSync(join(plugin, 'package.json'))) {
      this.runDsh(['plugin', '--profile', profile, 'add', `link:${plugin}`], target.home)
      installed = true
    }

    const entry = {
      home: target.home,
      workspace: target.workspace,
      profile,
      port,
      plugin,
      createdAt: new Date().toISOString(),
    }
    registry.sandboxes[name] = entry
    this.write(registry)
    this.writeMarker(name, entry)

    return { name, ...entry, installed, model: this.modelState(name) }
  }

  /** A port free on this machine *and* unclaimed by another sandbox of this project. */
  async freePort(claimed = new Set()) {
    for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
      if (claimed.has(port)) continue
      if (await isPortFree(port)) return port
    }
    throw new Error(`no free port between ${FIRST_PORT} and ${LAST_PORT}`)
  }

  /* ---------------------------------------------------------------- start */

  /**
   * Launch the sandbox and wait for its URL.
   *
   * Returns as soon as the host prints `dsh web: http://…`, so the caller can
   * probe routes immediately. The child is detached: it outlives this call, and
   * `stop` is the way to end it.
   */
  async start(name, options = {}) {
    const entry = this.require(name)
    const timeoutMs = options.timeoutMs ?? 45_000
    const target = this.paths(name)
    const workspace = this.patchWorkspace(name)

    if (!(await isPortFree(entry.port))) {
      const url = this.recordedUrl(name)
      return { name, url, pid: undefined, logPath: target.log, workspace, model: this.modelState(name), alreadyRunning: true }
    }

    mkdirSync(target.base, { recursive: true })
    const out = openSync(target.log, 'w')
    // Not detached on purpose: on Windows `detached: true` gives the child a new
    // console, and the host's output stops reaching the inherited file handle —
    // the log stays empty and the URL never arrives. `unref()` keeps the parent
    // free to exit without waiting for the sandbox.
    const child = spawn(
      commandLine(this.launcher, ['--profile', entry.profile, '--host', '127.0.0.1', '--port', String(entry.port), '--no-open']),
      {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
        env: { ...this.environment, DSH_HOME: entry.home },
      },
    )
    child.unref()

    const url = await this.waitForUrl(name, timeoutMs)
    const after = this.patchWorkspace(name)

    // Record who actually listens. `child.pid` is the shell wrapper, not the
    // host, and a port alone is not an identity: the desktop app owns its own
    // ports, and a stale register entry could otherwise point `stop` at it.
    const listener = listenerPids(entry.port)[0]
    if (listener !== undefined) this.recordListener(name, Number(listener))

    return {
      name,
      url,
      pid: listener === undefined ? child.pid : Number(listener),
      logPath: target.log,
      workspace: after,
      model: this.modelState(name),
      alreadyRunning: false,
    }
  }

  /** Remember the pid that owns this sandbox's port, so `stop` can verify it. */
  recordListener(name, pid) {
    const registry = this.read()
    const entry = registry.sandboxes[name]
    if (entry === undefined) return
    entry.listenerPid = pid
    entry.startedAt = new Date().toISOString()
    this.write(registry)
  }

  async waitForUrl(name, timeoutMs) {
    const target = this.paths(name)
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      await new Promise(done => setTimeout(done, 300))
      const text = readLog(target.log)
      const match = URL_PATTERN.exec(text)
      if (match !== null) return match[1]
      if (/Error|EADDRINUSE|did not activate/.test(text)) {
        throw new Error(`sandbox failed to start; see ${target.log}:\n${text.slice(-2000)}`)
      }
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for the sandbox URL; see ${target.log}`)
  }

  recordedUrl(name) {
    const match = URL_PATTERN.exec(readLog(this.paths(name).log))
    return match === null ? undefined : match[1]
  }

  /** The exact command a user runs in their own terminal. */
  open(name) {
    const entry = this.require(name)
    const workspace = this.patchWorkspace(name)
    return {
      name,
      home: entry.home,
      port: entry.port,
      profile: entry.profile,
      model: this.modelState(name),
      workspace,
      command: `$env:DSH_HOME = "${entry.home}"`,
      command2: `dsh --profile ${entry.profile} --host 127.0.0.1 --port ${entry.port} --no-open`,
    }
  }

  /* --------------------------------------------------------------- status */

  async status(name) {
    const entry = this.require(name)
    const free = await isPortFree(entry.port)
    if (free) return { name, running: false, port: entry.port }
    const url = this.recordedUrl(name)
    const listeners = listenerPids(entry.port).map(Number)
    const ours = entry.listenerPid === undefined ? undefined : listeners.includes(Number(entry.listenerPid))
    if (url === undefined) return { name, running: true, port: entry.port, url: undefined, http: undefined, ours }
    try {
      const response = await fetch(url, { redirect: 'manual' })
      return { name, running: true, port: entry.port, url, http: response.status, ours }
    } catch (error) {
      return { name, running: true, port: entry.port, url, http: undefined, error: error.message, ours }
    }
  }

  /**
   * Request a path from the running sandbox, carrying the session token.
   *
   * Route contracts are where most "the plugin is broken" reports turn out to be
   * a 401 or a 405. Doing it here means nobody has to hunt the token out of the
   * page URL — the sandbox already parsed it from its own log.
   */
  async http(name, options = {}) {
    const entry = this.require(name)
    const url = this.recordedUrl(name)
    if (url === undefined) throw new Error(`sandbox "${name}" has no recorded URL; start it first`)

    const base = new URL(url)
    const path = typeof options.path === 'string' && options.path.length > 0 ? options.path : '/'
    const target = new URL(path, base.origin)
    if (!target.searchParams.has('token') && base.searchParams.has('token')) {
      target.searchParams.set('token', base.searchParams.get('token'))
    }
    const method = String(options.method ?? 'GET').toUpperCase()
    const headers = options.body === undefined ? undefined : { 'content-type': 'application/json' }

    const response = await fetch(target, {
      method,
      redirect: 'manual',
      headers,
      body: options.body === undefined ? undefined : String(options.body),
    })
    const text = await response.text()
    const limit = options.limit ?? 4000
    const token = base.searchParams.get('token')
    return {
      name,
      method,
      // Never echo the token back: it is a session credential.
      path: target.pathname,
      status: response.status,
      location: response.headers.get('location') ?? undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      body: token === null ? text.slice(0, limit) : text.split(token).join('{{token}}').slice(0, limit),
      truncated: text.length > limit,
    }
  }

  /**
   * Copy entries from the real DSH_HOME into the sandbox, read-only on the source.
   *
   * An isolated home starts empty, so every panel shows an empty state and the
   * interesting rendering is never exercised. Seeding `myteam` (or `skills`, or a
   * data directory) gives the sandbox realistic content without touching the
   * user's state. `.credentials.yaml` is allowed only on purpose: the model is
   * meant to be added by the user inside the sandbox.
   */
  seed(name, options = {}) {
    const entry = this.require(name)
    const source = resolve(options.from ?? join(homedir(), '.dsh'))
    if (source === resolve(entry.home)) throw new Error('refusing to seed a sandbox from its own home')
    if (!existsSync(source)) throw new Error(`seed source does not exist: ${source}`)

    const names = Array.isArray(options.entries) ? options.entries : []
    if (names.length === 0) {
      throw new Error('seed needs at least one entry name, for example ["myteam"]')
    }

    const copied = []
    for (const item of names) {
      const from = join(source, item)
      if (!existsSync(from)) {
        copied.push({ entry: item, status: 'missing' })
        continue
      }
      const to = join(entry.home, item)
      cpSync(from, to, { recursive: true, force: options.force === true })
      copied.push({
        entry: item,
        status: 'copied',
        warning: item === '.credentials.yaml'
          ? 'the model credentials were copied in; the user did not add them in this sandbox, so treat the model as borrowed, not verified'
          : undefined,
      })
    }
    return { name, source, copied }
  }

  /**
   * Stop the sandbox, and only the sandbox.
   *
   * A port is not an identity: the desktop app owns ports of its own, and a
   * register entry that outlived its process can point at someone else. Kill only
   * the pid recorded at start, or a listener that still matches it; otherwise
   * refuse and say who is there.
   */
  stop(name, options = {}) {
    const entry = this.require(name)
    const listeners = listenerPids(entry.port).map(Number)
    if (listeners.length === 0) return { name, port: entry.port, stopped: [], foreign: [] }

    if (options.force !== true && entry.listenerPid !== undefined) {
      const ours = listeners.filter(pid => pid === Number(entry.listenerPid))
      if (ours.length === 0) {
        return { name, port: entry.port, stopped: [], foreign: listeners, refused: true }
      }
      for (const pid of ours) killPid(pid)
      return { name, port: entry.port, stopped: ours, foreign: [] }
    }

    for (const pid of listeners) killPid(pid)
    return { name, port: entry.port, stopped: listeners, foreign: [] }
  }

  /**
   * Remove a sandbox and its register entry.
   *
   * The folder may already be gone — a renamed package, a manual delete, a
   * half-finished create — and that is precisely when someone needs this command
   * to work. A *foreign* folder is still refused, because deleting another
   * project's sandbox is the one outcome worth failing on.
   */
  remove(name, options = {}) {
    const registry = this.read()
    const entry = registry.sandboxes[name]
    if (entry === undefined) {
      throw new Error(`no sandbox "${name}"; nothing to remove`)
    }
    const target = this.paths(name)
    if (options.confirmed !== true) {
      return { name, confirmed: false, path: target.base, project: this.root }
    }

    const marker = this.readMarkerQuietly(name)
    const stale = marker === undefined
    if (!stale) this.assertOwnership(name, entry)
    else if (listenerPids(entry.port).length > 0) {
      for (const pid of listenerPids(entry.port).map(Number)) {
        killPid(pid)
      }
    }
    if (!stale && listenerPids(entry.port).length > 0) this.stop(name, { force: true })

    rmSync(target.base, { recursive: true, force: true })
    const fresh = this.read()
    delete fresh.sandboxes[name]
    this.write(fresh)
    return { name, confirmed: true, path: target.base, stale }
  }

  /* ------------------------------------------------------------ workspace */

  /**
   * Point the sandbox's workspace entry at the sandbox copy, and label it with
   * the sandbox identity. Without this the sessions run in the user's real
   * Documents project.
   *
   * The entry only exists after the page has connected once, so this is expected
   * to return `absent` or `empty` on a brand-new sandbox.
   */
  patchWorkspace(name) {
    const entry = this.read().sandboxes[name]
    const target = this.paths(name)
    const path = join(target.home, 'storages', 'workspace.json')
    if (entry === undefined || !existsSync(path)) return 'absent'
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const entries = Object.values(parsed.tables?.workspaces ?? {})
    if (entries.length === 0) return 'empty'
    const title = `sandbox ${basename(this.root)}/${name}`
    let changed = false
    for (const item of entries) {
      if (item.path === entry.workspace && item.title === title) continue
      item.path = entry.workspace
      item.title = title
      changed = true
    }
    if (changed) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    return changed ? 'patched' : 'already'
  }

  /* --------------------------------------------------------- credentials */

  /**
   * Whether a model was added: read the record names, never the values, and
   * never the byte size — a fresh sandbox already writes a ~160-byte skeleton
   * holding only the browser session.
   */
  modelState(name) {
    const entry = this.read().sandboxes[name]
    if (entry === undefined) return 'absent'
    let text
    try {
      text = readFileSync(join(entry.home, '.credentials.yaml'), 'utf8')
    } catch {
      return 'absent'
    }
    const { records, refs } = credentialKeys(text)
    const model = records.filter(key => key !== CREDENTIAL_SESSION)
    return model.length > 0 || refs.length > 0 ? 'configured' : 'none'
  }

  /* ---------------------------------------------------------------- shell */

  runDsh(args, home) {
    const result = spawnSync(commandLine(this.launcher, args), {
      encoding: 'utf8',
      shell: true,
      env: { ...this.environment, DSH_HOME: home },
    })
    if (result.error !== undefined) throw new Error(`cannot run ${this.launcher}: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`${this.launcher} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
    }
    return result.stdout
  }
}

function readLog(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return ''
  }
  return decodeText(buffer)
}

/**
 * Decode a Host log.
 *
 * `dsh` writes UTF-8 here, but a Windows console redirect can produce UTF-16LE,
 * and then `dsh web:` never matches — the symptom is a start that waits forever
 * with a log that looks non-empty in an editor. Detect instead of assuming.
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2)
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  // No BOM: a UTF-16LE ASCII log is half NUL bytes.
  const head = buffer.subarray(0, Math.min(buffer.length, 512))
  let zeros = 0
  for (const byte of head) if (byte === 0) zeros += 1
  if (head.length > 0 && zeros > head.length / 3) return buffer.toString('utf16le')
  return buffer.toString('utf8')
}

/** Collect the 2-space-indented keys under the top-level `records:` and `refs:` blocks. */
export function credentialKeys(text) {
  const records = []
  const refs = []
  let section
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = /^([^:]+):/.exec(line.trimStart())
    if (match === null) continue
    const key = match[1].trim()
    if (indent === 0) {
      section = key === 'records' || key === 'refs' ? key : undefined
      continue
    }
    if (indent !== 2 || section === undefined) continue
    if (section === 'records') records.push(key)
    else refs.push(key)
  }
  return { records, refs }
}

function listenerPids(port) {
  if (process.platform === 'win32') {
    const output = spawnSync('netstat -ano', { encoding: 'utf8', shell: true }).stdout ?? ''
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
      const columns = line.trim().split(/\s+/)
      const pid = columns[columns.length - 1]
      if (/^\d+$/.test(pid)) pids.add(pid)
    }
    return [...pids]
  }
  const output = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout ?? ''
  return output.split(/\s+/).filter(value => /^\d+$/.test(value))
}
