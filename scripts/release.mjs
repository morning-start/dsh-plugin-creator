#!/usr/bin/env node
/**
 * CLI front over `lib/release.js` — the same engine as the `dsh_plugin_release`
 * tool.
 *
 *   node scripts/release.mjs check [dir]
 *   node scripts/release.mjs pack [dir] [--out <dir>]
 *   node scripts/release.mjs rehearse [dir] [--sandbox rollback] [--project <dir>]
 *
 * `check` asks the packer what would ship and compares the package's requirement
 * with the running DSH. `rehearse` packs, installs into a sandbox, and reads the
 * composed config back. Neither publishes: `npm publish` is the user's call.
 */

import { join, resolve } from 'node:path'
import { inspectRelease, packRelease, rehearseRelease } from '../lib/release.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function target() {
  const positional = process.argv.slice(3).filter(argument => !argument.startsWith('--'))
  const first = positional[0]
  return resolve(first === undefined ? process.cwd() : first)
}

function printCheck(report) {
  console.log(`${report.target}`)
  console.log(`${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.pass} pass\n`)
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'
    console.log(`${mark} ${check.id}: ${check.message}`)
  }
  if (report.ok) {
    console.log('\nNo blocking problem. Next: `pack`, then `rehearse`.')
  } else {
    console.log('\nBlocking problems above must be fixed before release.')
  }
}

async function main() {
  const command = process.argv[2]
  const directory = target()

  switch (command) {
    case 'check': {
      const report = await inspectRelease(directory, { dshVersion: flag('--dsh-version') })
      printCheck(report)
      if (!report.ok) process.exitCode = 1
      return
    }

    case 'pack': {
      const outDir = flag('--out') ?? join(directory, 'tmp', 'release')
      const packed = packRelease(directory, resolve(outDir))
      console.log(packed.tarball)
      return
    }

    case 'rehearse': {
      const result = await rehearseRelease(directory, {
        sandbox: flag('--sandbox'),
        project: flag('--project'),
      })
      console.log(`Rehearsal in sandbox "${result.sandbox}": ${result.ok ? 'installed and composed' : 'FAILED'}`)
      for (const step of result.steps) console.log(`  ${step.step}: ${step.detail}`)
      console.log(`\n  rollback: ${result.rollback}`)
      console.log(`  publish:  ${result.publish}`)
      if (!result.ok) process.exitCode = 1
      return
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(`Release checks for a DSH plugin package.

  node scripts/release.mjs check [dir]                  what ships, and does DSH accept it
  node scripts/release.mjs pack [dir] [--out <dir>]     write the tarball
  node scripts/release.mjs rehearse [dir] [--sandbox rollback] [--project <dir>]
                                                       install it in a sandbox and read the config back

check accepts --dsh-version <v> to test against a version other than the running one.`)
      return

    default:
      throw new Error(`unknown command "${command}"; run with --help`)
  }
}

main().catch((error) => {
  console.error(`release: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
