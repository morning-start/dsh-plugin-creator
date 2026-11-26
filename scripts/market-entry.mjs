#!/usr/bin/env node
/**
 * Generate and check the plugin-market entry for this package.
 *
 *   node scripts/market-entry.mjs            # print the YAML entry
 *   node scripts/market-entry.mjs --check    # validate it, and ask gh what only GitHub knows
 *   node scripts/market-entry.mjs --write <file>
 *
 * The entry is derived, not written: URL and name come from the git remote, the
 * line from `market.json`. That is the point — the file a reviewer checks against
 * the code cannot drift from the code.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildEntry, checkRepository, renderEntry, validateEntry } from '../lib/market.js'

const directory = resolve(process.cwd())
const { entry, source } = buildEntry(directory)
const validation = validateEntry(entry)
const yaml = renderEntry(entry)

const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--write')) {
  const target = resolve(flag('--write') ?? `data/plugins/${validation.filename ?? 'entry.yml'}`)
  writeFileSync(target, yaml, 'utf8')
  console.log(`wrote ${target}`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  console.log(`entry for ${entry.name}`)
  console.log(source === undefined ? 'source: derived (no market.json)' : `source: ${source.replace(directory, '.')}`)
  console.log(`file:   data/plugins/${validation.filename ?? '<url is not a github repo>'}\n`)

  let failed = 0
  for (const check of validation.checks) {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'
    console.log(`${mark} ${check.id}: ${check.message}`)
    if (check.status === 'fail') failed += 1
  }

  const findings = checkRepository(entry.name)
  if (findings.length > 0) {
    console.log('')
    for (const finding of findings) {
      const mark = finding.status === 'pass' ? 'ok  ' : finding.status === 'warn' ? 'warn' : 'FAIL'
      console.log(`${mark} ${finding.id}: ${finding.message}`)
      if (finding.status === 'fail') failed += 1
    }
  }

  console.log(failed === 0 ? '\nENTRY OK' : `\n${failed} problem(s) above`)
  process.exitCode = failed === 0 ? 0 : 1
  process.exit()
}

process.stdout.write(yaml)
