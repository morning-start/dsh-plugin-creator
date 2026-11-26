#!/usr/bin/env node
/**
 * CLI front over `lib/sandbox.js` — the same engine the `dsh_sandbox` tool uses.
 *
 *   node scripts/sandbox.mjs list
 *   node scripts/sandbox.mjs create model --plugin <dir>
 *   node scripts/sandbox.mjs start model            # launch it, print the URL
 *   node scripts/sandbox.mjs open model             # print the command for the user
 *   node scripts/sandbox.mjs status model
 *   node scripts/sandbox.mjs fix-workspace model
 *   node scripts/sandbox.mjs stop model
 *   node scripts/sandbox.mjs remove model --yes
 *
 * Sandboxes live in <project>/tmp/sandboxes/<name>/ with their own DSH_HOME,
 * profile, port, and workspace copy, and they are never recreated implicitly.
 */

import { Sandboxes } from '../lib/sandbox.js'

const FIRST_COLUMNS = { name: 12, port: 6, profile: 18 }

function projectRoot() {
  const index = process.argv.indexOf('--project')
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  return process.cwd()
}

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function row(name, port, profile, model) {
  return `${String(name).padEnd(FIRST_COLUMNS.name)} ${String(port).padEnd(FIRST_COLUMNS.port)} ${String(profile).padEnd(FIRST_COLUMNS.profile)} ${model}`
}

function modelLabel(state) {
  if (state === 'configured') return 'model: yes'
  if (state === 'none') return 'model: no'
  return 'model: no (no credentials file)'
}

function printList(sandboxes) {
  const state = sandboxes.list()
  console.log(`project ${state.project}`)
  console.log(`root    ${state.directory}\n`)
  if (state.sandboxes.length === 0) {
    console.log('No sandboxes yet. Create one with: node scripts/sandbox.mjs create <name>')
  } else {
    console.log(row('name', 'port', 'profile', 'model'))
    for (const item of state.sandboxes) {
      const note = item.note.length > 0 ? `  [${item.note}]` : ''
      console.log(`${row(item.name, item.port, item.profile, modelLabel(item.model))}${note}`)
    }
    console.log('\nReuse one with: node scripts/sandbox.mjs start <name>')
  }
  if (state.unregistered.length > 0) {
    console.log('\nFolders not in the register:')
    for (const item of state.unregistered) {
      console.log(`  ${item.name} (${item.owner === null ? 'no marker' : item.owner === state.project ? 'this project' : `project ${item.owner}`}) — delete it, or create the sandbox again`)
    }
  }
  if (state.missing.length > 0) {
    console.log('\nRegistered sandboxes whose folder is gone:')
    for (const name of state.missing) console.log(`  ${name} — remove it with: node scripts/sandbox.mjs remove ${name} --yes`)
  }
}

async function main() {
  const [command, name] = process.argv.slice(2)
  const sandboxes = new Sandboxes(projectRoot())

  switch (command) {
    case 'list':
      return printList(sandboxes)

    case 'create': {
      if (name === undefined) throw new Error('create needs a sandbox name')
      const created = await sandboxes.create(name, { plugin: flag('--plugin') })
      console.log(`Created sandbox "${created.name}"`)
      console.log(`  home      ${created.home}`)
      console.log(`  workspace ${created.workspace}`)
      console.log(`  profile   ${created.profile}`)
      console.log(`  port      ${created.port}`)
      console.log(`  plugin    ${created.installed ? `link:${created.plugin}` : `not installed (${created.plugin} is not a package directory)`}`)
      console.log(`\nStart it with: node scripts/sandbox.mjs start ${created.name}`)
      return
    }

    case 'start': {
      if (name === undefined) throw new Error('start needs a sandbox name')
      const started = await sandboxes.start(name, { timeoutMs: Number(flag('--wait') ?? 45_000) })
      if (started.alreadyRunning) {
        console.log(`Sandbox "${name}" is already running on port ${started.url === undefined ? '?' : new URL(started.url).port}.`)
      } else {
        console.log(`Sandbox "${name}" is running (pid ${started.pid}).`)
      }
      if (started.url !== undefined) console.log(`  url  ${started.url}`)
      console.log(`  log  ${started.logPath}`)
      if (started.workspace === 'patched') console.log('  note workspace.json was rewritten to the sandbox workspace; reload the page')
      if (started.model !== 'configured') {
        console.log('\nNo model yet: open the URL above and add one in Settings → Models.')
      }
      return
    }

    case 'open': {
      if (name === undefined) throw new Error('open needs a sandbox name')
      const opened = sandboxes.open(name)
      console.log(`Open sandbox "${name}" in your own terminal:\n`)
      console.log(`  ${opened.command}`)
      console.log(`  ${opened.command2}`)
      console.log(`\nThen in the page: Settings → Models → add a model. The credentials land in this sandbox's home`)
      console.log(`(${opened.home}), so every later open reuses them.`)
      if (opened.model === 'none') {
        console.log('\nCurrent state: no model yet. .credentials.yaml exists, but it holds only the browser session,')
        console.log('so the page will say "choose a model" and messages will not send until one is added.')
      }
      if (opened.workspace === 'absent' || opened.workspace === 'empty') {
        console.log('\nNote: the sandbox workspace is not registered yet. After the page loads once, run:')
        console.log(`  node scripts/sandbox.mjs fix-workspace ${name}`)
      }
      console.log(`\nTo start it here instead (no browser, for probing routes):`)
      console.log(`  node scripts/sandbox.mjs start ${name}`)
      return
    }

    case 'status': {
      if (name === undefined) throw new Error('status needs a sandbox name')
      const status = await sandboxes.status(name)
      if (!status.running) {
        console.log(`${name}: not running (port ${status.port} is free)`)
      } else if (status.http === undefined) {
        console.log(`${name}: port ${status.port} is in use${status.url === undefined ? ' but no URL was recorded' : ` but the request failed: ${status.error ?? ''}`}`)
      } else {
        console.log(`${name}: listening on ${status.port}, HTTP ${status.http} (401 still means alive)`)
      }
      return
    }

    case 'fix-workspace': {
      if (name === undefined) throw new Error('fix-workspace needs a sandbox name')
      const result = sandboxes.patchWorkspace(name)
      const messages = {
        absent: 'no storages/workspace.json yet: start the sandbox and load the page once, then run this again',
        empty: 'the workspaces table is empty: load the page once so the host registers one, then run this again',
        patched: `pointed the sandbox workspace at the copy; reload the page`,
        already: 'the sandbox workspace already points at the copy',
      }
      console.log(`${name}: ${messages[result]}`)
      return
    }

    case 'stop': {
      if (name === undefined) throw new Error('stop needs a sandbox name')
      const stopped = sandboxes.stop(name)
      console.log(stopped.stopped.length === 0
        ? `${name}: nothing listening on port ${stopped.port}`
        : `${name}: stopped ${stopped.stopped.length} process(es) on port ${stopped.port}`)
      return
    }

    case 'remove': {
      if (name === undefined) throw new Error('remove needs a sandbox name')
      const result = sandboxes.remove(name, { confirmed: process.argv.includes('--yes') })
      if (!result.confirmed) {
        console.log(`Removing sandbox "${name}" deletes:`)
        console.log(`  ${result.path}`)
        console.log(`It belongs to ${result.project} and holds that sandbox's model credentials and plugin versions.`)
        console.log(`Re-run with --yes to confirm: node scripts/sandbox.mjs remove ${name} --yes`)
      } else {
        console.log(`removed sandbox "${name}"`)
      }
      return
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage()

    default:
      throw new Error(`unknown command "${command}"; run with --help`)
  }
}

function usage() {
  console.log(`Sandboxes for plugin testing: one project, many instances, reused.

  node scripts/sandbox.mjs list
  node scripts/sandbox.mjs create <name> [--plugin <dir>]
  node scripts/sandbox.mjs start <name> [--wait <ms>]     launch and print the URL
  node scripts/sandbox.mjs open <name>                    print the command for the user
  node scripts/sandbox.mjs status <name>
  node scripts/sandbox.mjs fix-workspace <name>
  node scripts/sandbox.mjs stop <name>
  node scripts/sandbox.mjs remove <name> [--yes]

Sandboxes live in <project>/tmp/sandboxes/<name>/ with their own DSH_HOME,
profile, port, and workspace copy. They are never recreated implicitly: the
model credentials a user adds once stay in the sandbox home.`)
}

main().catch((error) => {
  console.error(`sandbox: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
