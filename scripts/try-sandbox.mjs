// Regression test for lib/sandbox.js, with a fake `dsh` launcher so nothing real
// is installed, no profile is bootstrapped, and no port is taken from a real run.
//
//   node scripts/try-sandbox.mjs
//
// The fake launcher answers `--dump-config` and `plugin … add` immediately, and
// for a real `--port` it listens on that port and prints the URL line the engine
// parses — so create / start / status / stop are exercised end to end.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandboxes, credentialKeys, resolveLauncher } from '../lib/sandbox.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const project = join(repo, 'tmp', 'test-sandbox-project')
const fakeLauncher = join(project, 'fake-dsh.mjs')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

async function expectError(label, body, pattern) {
  try {
    await body()
    failures.push(`${label}: expected an error, got none`)
    console.log(`  FAIL ${label} — expected an error`)
  } catch (error) {
    const matched = pattern.test(error.message)
    check(label, matched, matched ? undefined : `message was: ${error.message}`)
  }
}

rmSync(project, { recursive: true, force: true })
mkdirSync(join(project, 'plugin'), { recursive: true })
writeFileSync(join(project, 'plugin', 'package.json'), JSON.stringify({ name: 'fake-plugin', version: '0.0.0' }))
writeFileSync(fakeLauncher, `
import { createServer } from 'node:http'
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
if (portIndex === -1) process.exit(0)
const port = Number(args[portIndex + 1])
const server = createServer((request, response) => { response.writeHead(200); response.end('ok') })
server.listen(port, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake')
})
`)

const sandboxes = new Sandboxes(project, { launcher: `${process.execPath} "${fakeLauncher}"` })
const created = []

try {
  console.log('\ncredential parsing')
  check('browser session only reads as no model',
    credentialKeys('version: 1\nrecords:\n  client-connection/browser-session:\n    kind: x\n').records.join(',') === 'client-connection/browser-session')
  check('refs are counted',
    credentialKeys('version: 1\nrefs:\n  SOME_KEY: abc\n').refs.join(',') === 'SOME_KEY')

  console.log('\ncreate')
  const first = await sandboxes.create('dev', { plugin: join(project, 'plugin') })
  created.push('dev')
  check('port allocated from the range', first.port === 3100, `got ${first.port}`)
  check('plugin installed', first.installed === true)
  check('home created', existsSync(join(project, 'tmp', 'sandboxes', 'dev', 'home')))
  check('workspace created', existsSync(join(project, 'tmp', 'sandboxes', 'dev', 'workspace')))

  const marker = JSON.parse(readFileSync(join(project, 'tmp', 'sandboxes', 'dev', 'sandbox.json'), 'utf8'))
  check('marker names this project', marker.project === project, `got ${marker.project}`)
  check('marker names the sandbox', marker.sandbox === 'dev')
  check('marker carries the port', marker.port === first.port)

  await expectError('creating the same name twice is refused',
    () => sandboxes.create('dev'), /already exists/)
  await expectError('an invalid name is refused',
    () => sandboxes.create('Bad Name'), /lowercase/)

  const second = await sandboxes.create('clean', { plugin: join(project, 'plugin') })
  created.push('clean')
  check('second sandbox gets a different port', second.port !== first.port, `${first.port} vs ${second.port}`)

  console.log('\nlist')
  const listed = sandboxes.list()
  check('both sandboxes listed', listed.sandboxes.length === 2)
  check('no ownership notes', listed.sandboxes.every(item => item.note === ''), JSON.stringify(listed.sandboxes.map(item => item.note)))
  check('nothing unregistered', listed.unregistered.length === 0)

  console.log('\nstart / status / stop')
  const started = await sandboxes.start('dev', { timeoutMs: 20_000 })
  check('start returns a URL', typeof started.url === 'string' && started.url.includes('token=fake'), String(started.url))
  check('start reports the pid', typeof started.pid === 'number')

  const running = await sandboxes.status('dev')
  check('status sees it running', running.running === true)
  check('status probes HTTP', running.http === 200, `got ${running.http}`)

  const again = await sandboxes.start('dev', { timeoutMs: 5_000 })
  check('starting twice is a no-op', again.alreadyRunning === true)

  const stopped = sandboxes.stop('dev')
  check('stop killed a process', stopped.stopped.length > 0)
  const afterStop = await sandboxes.status('dev')
  check('status sees it stopped', afterStop.running === false)

  console.log('\nownership')
  const markerPath = join(project, 'tmp', 'sandboxes', 'dev', 'sandbox.json')
  const original = JSON.parse(readFileSync(markerPath, 'utf8'))
  writeFileSync(markerPath, JSON.stringify({ ...original, project: 'E:/some/other/project' }))
  await expectError('a marker from another project is refused',
    async () => sandboxes.open('dev'), /belongs to another project/)
  writeFileSync(markerPath, JSON.stringify(original))
  check('restoring the marker restores access', sandboxes.open('dev').name === 'dev')

  rmSync(markerPath)
  check('a missing marker is adopted when the register vouches for it',
    sandboxes.open('dev').name === 'dev' && existsSync(markerPath))

  console.log('\nworkspace')
  const home = join(project, 'tmp', 'sandboxes', 'dev', 'home')
  mkdirSync(join(home, 'storages'), { recursive: true })
  const workspacePath = join(home, 'storages', 'workspace.json')
  check('absent before the host writes one', sandboxes.patchWorkspace('dev') === 'absent')
  writeFileSync(workspacePath, JSON.stringify({ tables: { workspaces: {} } }))
  check('empty table reported as empty', sandboxes.patchWorkspace('dev') === 'empty')
  writeFileSync(workspacePath, JSON.stringify({ tables: { workspaces: { w1: { path: 'C:/Users/someone/Documents/deepseek-harness/default-workspace', title: 'default-workspace' } } } }))
  check('entry patched', sandboxes.patchWorkspace('dev') === 'patched')
  const patched = JSON.parse(readFileSync(workspacePath, 'utf8'))
  check('path points at the sandbox copy', patched.tables.workspaces.w1.path === join(project, 'tmp', 'sandboxes', 'dev', 'workspace'))
  check('title names the sandbox', patched.tables.workspaces.w1.title === `sandbox ${project.split(/[\\/]/).pop()}/dev`, patched.tables.workspaces.w1.title)
  check('patching twice is a no-op', sandboxes.patchWorkspace('dev') === 'already')

  console.log('\ncredentials')
  const credentials = join(home, '.credentials.yaml')
  writeFileSync(credentials, 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: secret\n')
  check('browser session only is not a model', sandboxes.modelState('dev') === 'none')
  writeFileSync(credentials, 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: secret\n  deepseek-account-platform/default:\n    kind: token\n')
  check('an account record counts as a model', sandboxes.modelState('dev') === 'configured')

  console.log('\nremove')
  const refused = sandboxes.remove('clean', {})
  check('remove needs confirmation', refused.confirmed === false)
  check('folder survives an unconfirmed remove', existsSync(join(project, 'tmp', 'sandboxes', 'clean')))
  const removed = sandboxes.remove('clean', { confirmed: true })
  check('confirmed remove deletes the folder', removed.confirmed === true && !existsSync(join(project, 'tmp', 'sandboxes', 'clean')))
  check('register drops the entry', sandboxes.list().sandboxes.every(item => item.name !== 'clean'))
  created.length = 0

  console.log('\nlauncher resolution')
  const launcher = resolveLauncher()
  check('resolves to an absolute path or the bare command', launcher === 'dsh' || launcher.length > 0, launcher)
} finally {
  for (const name of created) {
    try {
      sandboxes.stop(name)
      sandboxes.remove(name, { confirmed: true })
    } catch {
      // Best effort cleanup.
    }
  }
  rmSync(project, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nSANDBOX TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nsandbox ok')
}
