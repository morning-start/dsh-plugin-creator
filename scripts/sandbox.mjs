#!/usr/bin/env node
/**
 * Sandboxes for plugin testing: one project, many isolated instances, all reused.
 *
 * A sandbox is a directory pair plus a profile and a port:
 *
 *   <project>/tmp/sandboxes/registry.json    the register (git-ignored)
 *   <project>/tmp/sandboxes/<name>/home/     DSH_HOME for that sandbox
 *   <project>/tmp/sandboxes/<name>/workspace/ the copy sessions actually run in
 *
 * Sandboxes are long-lived. `create` is for the first time only; after that the
 * same sandbox is reopened with `open`, because the expensive and private things
 * live in its home: the pnpm install, the profile's plugin versions, and the
 * model credentials the user adds once through the page.
 *
 *   node scripts/sandbox.mjs list
 *   node scripts/sandbox.mjs create model --plugin <dir-or-spec>
 *   node scripts/sandbox.mjs open model            # print the command for the user
 *   node scripts/sandbox.mjs open model --run      # start it and print the URL
 *   node scripts/sandbox.mjs status model
 *   node scripts/sandbox.mjs stop model
 *   node scripts/sandbox.mjs remove model --yes
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const FIRST_PORT = 3100
const LAST_PORT = 3199
const URL_PATTERN = /dsh web:\s+(http:\/\/\S+)/
const START_TIMEOUT_MS = 60_000

function projectRoot() {
  const index = process.argv.indexOf('--project')
  if (index >= 0 && process.argv[index + 1] !== undefined) return resolve(process.argv[index + 1])
  return process.cwd()
}

const root = projectRoot()
const sandboxesDir = join(root, 'tmp', 'sandboxes')
const registryPath = join(sandboxesDir, 'registry.json')

function readRegistry() {
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch {
    return { version: 1, sandboxes: {} }
  }
}

function writeRegistry(registry) {
  mkdirSync(sandboxesDir, { recursive: true })
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

function paths(name) {
  const base = join(sandboxesDir, name)
  return {
    base,
    home: join(base, 'home'),
    workspace: join(base, 'workspace'),
    log: join(base, 'open.log'),
  }
}

function profileFor(name) {
  return `sb-${name}`
}

async function freePort(from = FIRST_PORT) {
  for (let port = from; port <= LAST_PORT; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port between ${FIRST_PORT} and ${LAST_PORT}`)
}

function isPortFree(port) {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => server.close(() => resolvePort(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Whether a model was added to this sandbox.
 *
 * Byte size is not the signal: a fresh sandbox already writes a ~160-byte
 * skeleton that holds only `client-connection/browser-session`. A model shows up
 * as a further record (an account, an llm route) or a `refs` entry such as an
 * API key. Read the record names; never print the values.
 */
function modelState(home) {
  const path = join(home, '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 'absent'
  }
  const { records, refs } = credentialKeys(text)
  const modelRecords = records.filter(key => key !== 'client-connection/browser-session')
  if (modelRecords.length > 0 || refs.length > 0) return 'configured'
  return 'none'
}

/** Collect the 2-space-indented keys under the top-level `records:` and `refs:` blocks. */
function credentialKeys(text) {
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

/**
 * Point the sandbox's recorded workspace at the sandbox copy. Without this the
 * sessions run in the user's real Documents project.
 */
function patchWorkspace(home, workspace) {
  const path = join(home, 'storages', 'workspace.json')
  if (!existsSync(path)) return 'absent'
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const entries = Object.values(parsed.tables?.workspaces ?? {})
  if (entries.length === 0) return 'empty'
  let changed = false
  for (const entry of entries) {
    if (entry.path === workspace) continue
    entry.path = workspace
    entry.title = 'sandbox-workspace'
    changed = true
  }
  if (changed) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return changed ? 'patched' : 'already'
}

/**
 * `dsh` is a `.cmd` shim on Windows, so it needs a shell; passing an argument
 * array with `shell: true` is deprecated and unescaped, so build one line.
 */
const DSH_BIN = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

function commandLine(args) {
  return [DSH_BIN, ...args.map(shellQuote)].join(' ')
}

function shellQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function runDsh(args, home) {
  assertDsh()
  const result = spawnSync(commandLine(args), {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, DSH_HOME: home },
  })
  if (result.error !== undefined) throw new Error(`cannot run dsh: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`dsh ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** `dsh` on PATH is a prerequisite for everything here; fail with a clear line. */
function assertDsh() {
  const probe = spawnSync(`${DSH_BIN} --help`, { encoding: 'utf8', shell: true })
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error('`dsh` is not runnable from this shell; put it on PATH (or use the launcher that provides it)')
  }
}

function formatRow(name, port, profile, model) {
  return `${String(name).padEnd(12)} ${String(port).padEnd(6)} ${String(profile).padEnd(18)} ${model}`
}

function formatSandbox(name, entry) {
  const state = modelState(entry.home)
  const model = state === 'configured' ? 'model: yes' : state === 'none' ? 'model: no' : 'model: no (no credentials file)'
  return formatRow(name, entry.port, entry.profile, model)
}

function commandFor(entry) {
  return [
    `$env:DSH_HOME = "${entry.home}"`,
    `dsh --profile ${entry.profile} --host 127.0.0.1 --port ${entry.port} --no-open`,
  ]
}

async function commandCreate(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('sandbox name must be lowercase letters, digits, and hyphens')
  const registry = readRegistry()
  if (registry.sandboxes[name] !== undefined) {
    throw new Error(`sandbox "${name}" already exists; reuse it with: node scripts/sandbox.mjs open ${name}`)
  }

  const target = paths(name)
  mkdirSync(target.home, { recursive: true })
  mkdirSync(target.workspace, { recursive: true })

  const plugin = flag('--plugin') ?? root
  const profile = profileFor(name)
  const port = await freePort()

  console.log(`Creating sandbox "${name}"`)
  console.log(`  home      ${target.home}`)
  console.log(`  workspace ${target.workspace}`)

  runDsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], target.home)
  console.log(`  profile   ${profile} (copied from the shipped web template)`)

  if (existsSync(join(plugin, 'package.json'))) {
    runDsh(['plugin', '--profile', profile, 'add', `link:${resolve(plugin)}`], target.home)
    console.log(`  plugin    link:${resolve(plugin)}`)
  } else {
    console.log(`  plugin    not installed (${plugin} is not a package directory); add it with:`)
    console.log(`            $env:DSH_HOME = "${target.home}"; dsh plugin --profile ${profile} add <spec>`)
  }

  registry.sandboxes[name] = {
    home: target.home,
    workspace: target.workspace,
    profile,
    port,
    plugin: resolve(plugin),
    createdAt: new Date().toISOString(),
  }
  writeRegistry(registry)

  console.log(`\nSandbox ready. Open it (the user adds a model once, then this sandbox is reused):`)
  console.log(`  node scripts/sandbox.mjs open ${name}`)
}

async function commandOpen(name, run) {
  const registry = readRegistry()
  const entry = registry.sandboxes[name]
  if (entry === undefined) throw new Error(`no sandbox "${name}"; create one with: node scripts/sandbox.mjs create ${name}`)

  const workspace = patchWorkspace(entry.home, entry.workspace)
  if (workspace === 'absent' || workspace === 'empty') {
    const why = workspace === 'absent' ? 'no storages/workspace.json yet' : 'the workspaces table is still empty'
    console.log(`Note: the sandbox workspace is not registered yet (${why}).`)
    console.log('The host writes that entry when the page first connects. After it loads, run:')
    console.log(`  node scripts/sandbox.mjs fix-workspace ${name}`)
    console.log('so sessions run in the sandbox copy instead of Documents\\deepseek-harness.\n')
  }

  if (!run) {
    console.log(`Open sandbox "${name}" in your own terminal:\n`)
    for (const line of commandFor(entry)) console.log(`  ${line}`)
    console.log(`\nThen in the page: Settings → Models → add a model. The credentials land in this sandbox's home`)
    console.log(`(${entry.home}), so every later \`open ${name}\` reuses them.`)
    if (modelState(entry.home) === 'none') {
      console.log(`\nCurrent state: no model yet. .credentials.yaml exists, but it holds only the browser session,`)
      console.log(`so the page will say "choose a model" and messages will not send until one is added.`)
    }
    console.log(`\nTo start it here instead (no browser, for probing routes):`)
    console.log(`  node scripts/sandbox.mjs open ${name} --run`)
    return
  }

  assertDsh()
  const target = paths(name)
  mkdirSync(target.base, { recursive: true })
  const logPath = target.log
  const out = openSync(logPath, 'w')
  const child = spawn(commandLine(['--profile', entry.profile, '--host', '127.0.0.1', '--port', String(entry.port), '--no-open']), {
    shell: true,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DSH_HOME: entry.home },
  })
  child.unref()

  const url = await waitForUrl(logPath, child.pid)
  const after = patchWorkspace(entry.home, entry.workspace)
  console.log(`Sandbox "${name}" is running (pid ${child.pid}).`)
  console.log(`  url    ${url}`)
  console.log(`  log    ${logPath}`)
  if (after === 'patched') console.log('  note   workspace.json was rewritten to the sandbox workspace; reload the page')
  if (modelState(entry.home) !== 'configured') {
    console.log('\nNo model yet: open the URL above and add one in Settings → Models.')
  }
  console.log(`\nStop it with: node scripts/sandbox.mjs stop ${name}`)
}

async function waitForUrl(logPath, pid) {
  const started = Date.now()
  while (Date.now() - started < START_TIMEOUT_MS) {
    await new Promise(done => setTimeout(done, 300))
    let text = ''
    try {
      text = readFileSync(logPath, 'utf8')
    } catch {
      continue
    }
    const match = URL_PATTERN.exec(text)
    if (match !== null) return match[1]
    if (/Error|EADDRINUSE|did not activate/.test(text)) {
      throw new Error(`sandbox failed to start (pid ${pid}); see ${logPath}:\n${text.slice(-2000)}`)
    }
  }
  throw new Error(`timed out waiting for the sandbox URL (pid ${pid}); see ${logPath}`)
}

function commandList() {
  const registry = readRegistry()
  const names = Object.keys(registry.sandboxes)
  if (names.length === 0) {
    console.log('No sandboxes yet. Create one with: node scripts/sandbox.mjs create <name>')
    return
  }
  console.log(formatRow('name', 'port', 'profile', 'model'))
  for (const name of names) console.log(formatSandbox(name, registry.sandboxes[name]))
  console.log('\nReuse one with: node scripts/sandbox.mjs open <name>')
}

async function commandStatus(name) {
  const registry = readRegistry()
  const entry = registry.sandboxes[name]
  if (entry === undefined) throw new Error(`no sandbox "${name}"`)

  const free = await isPortFree(entry.port)
  if (free) {
    console.log(`${name}: not running (port ${entry.port} is free)`)
    return
  }
  let text = ''
  try {
    text = readFileSync(paths(name).log, 'utf8')
  } catch {
    // No log: the instance was started elsewhere.
  }
  const match = URL_PATTERN.exec(text)
  if (match === null) {
    console.log(`${name}: port ${entry.port} is in use, but no URL was recorded in ${paths(name).log}`)
    return
  }
  try {
    const response = await fetch(match[1], { redirect: 'manual' })
    console.log(`${name}: listening on ${entry.port}, HTTP ${response.status} (401 still means alive)`)
  } catch (error) {
    console.log(`${name}: port ${entry.port} is in use but the request failed: ${error.message}`)
  }
}

function commandFixWorkspace(name) {
  const registry = readRegistry()
  const entry = registry.sandboxes[name]
  if (entry === undefined) throw new Error(`no sandbox "${name}"`)
  const result = patchWorkspace(entry.home, entry.workspace)
  const messages = {
    absent: 'no storages/workspace.json yet: start the sandbox and load the page once, then run this again',
    empty: 'the workspaces table is empty: load the page once so the host registers one, then run this again',
    patched: `pointed the sandbox workspace at ${entry.workspace}; reload the page`,
    already: `the sandbox workspace already points at ${entry.workspace}`,
  }
  console.log(`${name}: ${messages[result]}`)
}

function commandStop(name) {
  const registry = readRegistry()
  const entry = registry.sandboxes[name]
  if (entry === undefined) throw new Error(`no sandbox "${name}"`)
  const pids = listenerPids(entry.port)
  if (pids.length === 0) {
    console.log(`${name}: nothing listening on port ${entry.port}`)
    return
  }
  for (const pid of pids) {
    spawnSync(`taskkill /PID ${pid} /F`, { shell: true, encoding: 'utf8' })
    console.log(`${name}: stopped pid ${pid} (port ${entry.port})`)
  }
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

function commandRemove(name, confirmed) {
  const registry = readRegistry()
  const entry = registry.sandboxes[name]
  if (entry === undefined) throw new Error(`no sandbox "${name}"`)
  if (!confirmed) {
    console.log(`Removing sandbox "${name}" deletes:`)
    console.log(`  ${paths(name).base}`)
    console.log('It also deletes the model credentials added in it and the installed plugin versions.')
    console.log(`Re-run with --yes to confirm: node scripts/sandbox.mjs remove ${name} --yes`)
    return
  }
  if (listenerPids(entry.port).length > 0) commandStop(name)
  rmSync(paths(name).base, { recursive: true, force: true })
  delete registry.sandboxes[name]
  writeRegistry(registry)
  console.log(`removed sandbox "${name}"`)
}

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage() {
  console.log(`Sandboxes for plugin testing: one project, many instances, reused.

  node scripts/sandbox.mjs list
  node scripts/sandbox.mjs create <name> [--plugin <dir>] [--project <dir>]
  node scripts/sandbox.mjs open <name> [--run]
  node scripts/sandbox.mjs status <name>
  node scripts/sandbox.mjs fix-workspace <name>
  node scripts/sandbox.mjs stop <name>
  node scripts/sandbox.mjs remove <name> [--yes]

Sandboxes live in <project>/tmp/sandboxes/<name>/ with their own DSH_HOME,
profile, port, and workspace copy. They are never recreated implicitly: the
model credentials a user adds once stay in the sandbox home.`)
}

async function main() {
  const [command, name] = process.argv.slice(2)
  switch (command) {
    case 'list': return commandList()
    case 'create':
      if (name === undefined) throw new Error('create needs a sandbox name')
      return await commandCreate(name)
    case 'open':
      if (name === undefined) throw new Error('open needs a sandbox name')
      return await commandOpen(name, process.argv.includes('--run'))
    case 'status':
      if (name === undefined) throw new Error('status needs a sandbox name')
      return await commandStatus(name)
    case 'stop':
      if (name === undefined) throw new Error('stop needs a sandbox name')
      return commandStop(name)
    case 'fix-workspace':
      if (name === undefined) throw new Error('fix-workspace needs a sandbox name')
      return commandFixWorkspace(name)
    case 'remove':
      if (name === undefined) throw new Error('remove needs a sandbox name')
      return commandRemove(name, process.argv.includes('--yes'))
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage()
    default:
      throw new Error(`unknown command "${command}"; run with --help`)
  }
}

main().catch((error) => {
  console.error(`sandbox: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
