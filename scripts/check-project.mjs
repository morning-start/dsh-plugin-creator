#!/usr/bin/env node
/**
 * CLI front over `lib/checks.js` — the same engine as the `dsh_project_check`
 * tool.
 *
 *   node scripts/check-project.mjs [dir] [--config <file>] [--only id,id]
 *
 * The project declares its rules in `checks.json`; this runs them and exits 1 on
 * any failure. Rule types are documented in docs/CHECKS.md.
 */

import { resolve } from 'node:path'
import { runProjectChecks } from '../lib/checks.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'))
  const only = flag('--only')
  const directory = resolve(positional[0] ?? process.cwd())

  const result = await runProjectChecks(directory, {
    config: flag('--config'),
    only: only === undefined ? undefined : only.split(',').map(item => item.trim()).filter(item => item.length > 0),
  })

  console.log(`${result.target}`)
  console.log(`${result.source} — ${result.ran}/${result.declared} rule(s)\n`)
  for (const check of result.checks) {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'
    console.log(`${mark} ${check.id}: ${check.message}`)
  }
  console.log(`\n${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`)
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`check-project: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
