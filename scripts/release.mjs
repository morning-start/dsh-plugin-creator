#!/usr/bin/env node
/**
 * CLI front over `lib/release.js` — the same engine as the `dsh_plugin_release`
 * tool.
 *
 * The fixed way to release is a tag push; CI does the rest:
 *
 *   bump package.json → commit → git tag vX.Y.Z → git push origin vX.Y.Z
 *
 * The commands below are the **pre-flight** and the **recovery** path:
 *
 *   node scripts/release.mjs check [dir]
 *   node scripts/release.mjs pack [dir] [--out <dir>]
 *   node scripts/release.mjs rehearse [dir] [--sandbox rollback] [--project <dir>]
 *   node scripts/release.mjs ship [dir] --dry-run|--yes
 *
 * `check` asks the packer what would ship and compares the package's requirement
 * with the running DSH — run it *before* tagging. `rehearse` packs, installs into
 * a sandbox, and reads the composed config back. `ship` publishes from this
 * machine, which is what loses provenance: use it only when CI is unavailable.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bumpVersion, createGithubRelease, inspectRelease, packRelease, publishRelease, rehearseRelease, verifyPublished } from '../lib/release.js'
import { shipRelease } from '../lib/ship.js'

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
    case 'version': {
      // `version [dir] [patch|minor|major|X.Y.Z]` — both are optional and in
      // either order, so find the bump by shape rather than by position.
      const positional = process.argv.slice(3).filter(argument => !argument.startsWith('--'))
      const bump = positional.find(argument => /^(patch|minor|major|\d+\.\d+\.\d+)$/.test(argument))
      const dirArg = positional.find(argument => argument !== bump)
      const where = resolve(dirArg === undefined ? process.cwd() : dirArg)
      const result = bumpVersion(where, /^(patch|minor|major)$/.test(bump ?? '')
        ? { part: bump }
        : bump === undefined ? {} : { version: bump })
      console.log(`${where}`)
      console.log(`${result.previous} -> ${result.version}`)
      console.log('\nNext:')
      for (const step of result.steps) console.log(`  ${step}`)
      return
    }

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

    case 'ship': {
      const result = await shipRelease(directory, {
        dryRun: process.argv.includes('--dry-run'),
        confirmed: process.argv.includes('--yes'),
        skipNpm: process.argv.includes('--skip-npm'),
        draft: process.argv.includes('--draft'),
        tag: flag('--tag'),
        gitTag: flag('--git-tag'),
        waitSeconds: flag('--wait') === undefined ? 300 : Number(flag('--wait')),
      })
      for (const step of result.steps) {
        const mark = step.ok ? (step.advisory ? 'ok* ' : 'ok  ') : 'FAIL'
        console.log(`${mark} ${step.step.padEnd(8)} ${step.detail}`)
      }
      console.log('')
      if (!result.ok) {
        console.log(`stopped at ${result.failedAt}. Nothing after it ran.`)
        process.exitCode = 1
      } else {
        console.log(`shipped ${result.version} as ${result.gitTag}`)
        if (result.url !== undefined) console.log(`  release: ${result.url}`)
        if (result.installable !== true) console.log('  registry: not visible yet (advisory, the release is already cut)')
        console.log('  * advisory: a slow registry cache does not undo a release')
      }
      return
    }

    case 'publish': {
      const result = publishRelease(directory, {
        tag: flag('--tag'),
        access: flag('--access'),
        otp: flag('--otp'),
        dryRun: process.argv.includes('--dry-run'),
        confirmed: process.argv.includes('--yes'),
      })
      console.log(`${result.dryRun ? 'Dry run' : 'Published'} with ${result.kind}: ${result.output.split('\n').slice(-4).join('\n')}`)
      if (!result.ok) process.exitCode = 1
      else if (!result.dryRun) {
        console.log(`\nNext: node scripts/release.mjs verify . --version ${result.version}`)
        console.log('      node scripts/release.mjs gh-release . --tarball tmp/release/<name>.tgz')
        console.log('\nIf this was a brand-new package, it is now bootstrapped: configure')
        console.log('npmjs.com -> the package -> Settings -> Trusted Publisher (GitHub Actions,')
        console.log('workflow release.yml), delete the local token, and release by tag from now on.')
      }
      return
    }

    case 'verify': {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      const version = flag('--version') ?? manifest.version
      const wait = flag('--wait')
      const result = await verifyPublished(manifest.name, version, {
        tag: flag('--tag'),
        registry: flag('--registry'),
        attempts: wait === undefined ? 1 : Math.max(1, Math.ceil(Number(wait) / 15)),
        intervalMs: 15_000,
      })
      for (const finding of result.findings) {
        console.log(`${finding.status === 'pass' ? 'ok  ' : 'FAIL'} ${finding.id}: ${finding.message}`)
      }
      if (!result.ok) {
        console.log('\nNot installable yet. A fresh name can land as a placeholder and attach the real version later; re-run in a few minutes.')
        process.exitCode = 1
      }
      return
    }

    case 'gh-release': {
      const result = createGithubRelease(directory, {
        tag: flag('--tag'),
        tarball: flag('--tarball'),
        notesFile: flag('--notes'),
        draft: process.argv.includes('--draft'),
        dryRun: process.argv.includes('--dry-run'),
      })
      if (result.dryRun) console.log(result.command)
      else {
        console.log(`${result.ok ? 'Created' : 'FAILED'}: ${result.url ?? result.command}`)
        if (!result.ok) console.log(result.output)
      }
      if (!result.ok) process.exitCode = 1
      return
    }

    case 'market': {
      const { buildEntry, renderEntry, validateEntry } = await import('../lib/market.js')
      const { entry, source } = buildEntry(directory)
      const validation = validateEntry(entry)
      const yaml = renderEntry(entry)
      const target = flag('--write')
      if (target === undefined) {
        process.stdout.write(yaml)
        return
      }
      const path = resolve(target)
      writeFileSync(path, yaml, 'utf8')
      console.log(`wrote ${path}`)
      console.log(`source: ${source === undefined ? 'derived' : source.replace(directory, '.')}`)
      if (!validation.ok) {
        for (const check of validation.checks.filter(item => item.status !== 'pass')) {
          console.log(`${check.status === 'warn' ? 'warn' : 'FAIL'} ${check.id}: ${check.message}`)
        }
        process.exitCode = 1
      }
      return
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(`Release checks for a DSH plugin package.

  node scripts/release.mjs ship [dir] [--yes] [--dry-run] [--skip-npm] [--draft] [--wait 300]
                                                       check -> pack -> publish -> release -> verify (advisory)
  node scripts/release.mjs version [dir] [patch|minor|major|X.Y.Z]
                                                       step 1 of the fixed flow: move package.json's version,
                                                       then print the commit / tag / push commands
  node scripts/release.mjs check [dir]                  what ships, and does DSH accept it
  node scripts/release.mjs pack [dir] [--out <dir>]     write the tarball
  node scripts/release.mjs rehearse [dir] [--sandbox rollback] [--project <dir>]
                                                       install it in a sandbox and read the config back
  node scripts/release.mjs publish [dir] [--tag latest] [--dry-run] [--yes]
                                                       publish from this machine — the **bootstrap** for a
                                                       brand-new package name only; no provenance
                                                       (everyday releases are a tag push, which CI publishes)
  node scripts/release.mjs verify [dir] [--version <v>] [--tag latest] [--registry <url>]
                                                       is the published version actually installable yet
  node scripts/release.mjs gh-release [dir] [--tag v<v>] [--tarball <file>] [--draft] [--notes <file>] [--dry-run]
                                                       create the GitHub Release and attach the tarball
  node scripts/release.mjs market [--write <file>]      print or write the plugin-market entry

check accepts --dsh-version <v> to test against a version other than the running one.
publish requires --yes: it is irreversible. Everything else is safe to re-run.`)
      return

    default:
      throw new Error(`unknown command "${command}"; run with --help`)
  }
}

main().catch((error) => {
  console.error(`release: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
