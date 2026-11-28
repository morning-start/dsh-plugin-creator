#!/usr/bin/env node
/**
 * Put a plugin project on GitHub — the CLI front over `lib/repo.js`.
 *
 *   node scripts/repo.mjs plan   [dir] [--owner <o>] [--repo <r>] [--visibility public] [--topic dsh-plugin] [--description <d>]
 *   node scripts/repo.mjs create [dir] --owner <o> [--repo <r>] [--visibility public] [--topic dsh-plugin] [--description <d>] [--dry-run]
 *   node scripts/repo.mjs update [dir] [--visibility public] [--topic dsh-plugin] [--description <d>] [--dry-run] [--no-commit]
 *
 * `create` is for a directory with no `origin`: git init, declare the repository,
 * `gh repo create --public --push`, then add the `dsh-plugin` topic.
 *
 * `update` is for a directory that already points at a GitHub repository: change
 * the visibility only if it differs, add the topic (idempotent), align
 * `package.json`'s `repository` in its own commit — and **never push**.
 */

import { resolve } from 'node:path'
import { createRepository, ghReady, inspectRepository, planRepository, updateRepository } from '../lib/repo.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const BOOLEAN = ['--dry-run', '--no-commit']
const TAKES_VALUE = ['--owner', '--repo', '--visibility', '--topic', '--description']

/** The first token that is neither a flag nor a flag's value. */
function directoryArgument() {
  const argv = process.argv.slice(3)
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (TAKES_VALUE.includes(token)) {
      index++
      continue
    }
    if (token.startsWith('--') || BOOLEAN.includes(token)) continue
    return resolve(token)
  }
  return resolve(process.cwd())
}

function printSteps(result) {
  for (const step of result.steps) {
    const mark = step.ok === false ? 'FAIL' : step.detail === 'dry run' ? 'plan' : 'ok  '
    console.log(`${mark} ${step.step}${step.detail === undefined || step.detail === '' ? '' : `  — ${step.detail}`}`)
  }
}

async function main() {
  const command = process.argv[2]
  const directory = directoryArgument()
  const options = {
    owner: flag('--owner'),
    repo: flag('--repo'),
    visibility: flag('--visibility'),
    topic: flag('--topic'),
    description: flag('--description'),
    dryRun: process.argv.includes('--dry-run'),
    commit: !process.argv.includes('--no-commit'),
  }

  if (command === 'help' || command === '--help' || command === undefined) {
    console.log(`Put a plugin project on GitHub.

  node scripts/repo.mjs plan   [dir] [--owner <o>] [--repo <r>] [--visibility public] [--topic ${'dsh-plugin'}]
  node scripts/repo.mjs create [dir] --owner <o> [--repo <r>] [--visibility public] [--description <d>] [--dry-run]
  node scripts/repo.mjs update [dir] [--visibility public] [--description <d>] [--dry-run] [--no-commit]

create: no origin yet -> git init, declare the repository, gh repo create --push, add the topic.
update: already on GitHub -> fix visibility only if it differs, add the topic, align
        package.json's repository in its own commit. It never pushes.`)
    return
  }

  if (command === 'plan') {
    const plan = planRepository(directory, options)
    console.log(`${directory}`)
    console.log(`${plan.action} ${plan.target ?? '(unknown target)'} — visibility ${plan.visibility}, topic ${plan.topic}`)
    if (plan.problem !== undefined) {
      console.log(`\nblocked: ${plan.problem}`)
      process.exitCode = 1
      return
    }
    console.log('')
    for (const step of plan.steps) console.log(`  ${step}`)
    if (plan.steps.length === 0) console.log('  (nothing to change)')
    return
  }

  if (command === 'create' || command === 'update') {
    const ready = ghReady()
    if (!ready.ok) {
      console.log(`${ready.message}`)
      process.exitCode = 1
      return
    }
    const result = command === 'create'
      ? createRepository(directory, options)
      : updateRepository(directory, options)
    console.log(`${directory}`)
    if (result.unchanged === true) {
      console.log(`${result.url ?? ''} is already aligned; nothing to change.`)
      return
    }
    printSteps(result)
    if (result.dryRun === true) console.log('\nDry run: nothing was changed.')
    else if (result.url !== undefined) console.log(`\n${result.url}`)
    if (result.ok !== true) {
      console.log(`\nstopped at ${result.failedAt}. Nothing after it ran.`)
      process.exitCode = 1
    }
    return
  }

  if (command === 'inspect') {
    const state = inspectRepository(directory)
    console.log(JSON.stringify(state, null, 2))
    return
  }

  throw new Error(`unknown command "${command}"; run with --help`)
}

main().catch((error) => {
  console.error(`repo: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})