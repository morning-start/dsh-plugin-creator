#!/usr/bin/env node
/**
 * Bring an existing plugin project up to the standard, without rewriting it.
 *
 *   node scripts/adopt.mjs <dir>                 # plan only (the default)
 *   node scripts/adopt.mjs <dir> --dry-run       # show the writes, write nothing
 *   node scripts/adopt.mjs <dir> --apply         # write the safe ones
 *   node scripts/adopt.mjs <dir> --json          # the plan as JSON
 *
 * Plan-only is the default on purpose: normalising someone else's project is an
 * action, not a side effect of asking what would happen.
 */

import { resolve } from 'node:path'
import { applyAdoption, auditProject, planAdoption } from '../lib/adopt.js'

const args = process.argv.slice(2)
const has = name => args.includes(name)
const value = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--')))

const directory = resolve(positional[0] ?? '.')
let audit
try {
  audit = await auditProject(directory)
} catch (error) {
  console.error(`adopt: ${error.message}`)
  process.exit(1)
}
const plan = await planAdoption(directory, audit)

if (has('--json')) {
  process.stdout.write(`${JSON.stringify({ audit: { summary: audit.bundle.summary, missing: audit.missing.map(item => item.path), tree: audit.tree }, plan }, null, 2)}\n`)
  process.exit(0)
}

const mark = kind => kind === 'auto' ? 'auto  ' : kind === 'decide' ? 'decide' : 'manual'
console.log(`adopt ${directory}`)
console.log(`  bundle: ${audit.bundle.summary.pass} pass, ${audit.bundle.summary.warn} warn, ${audit.bundle.summary.fail} fail`)
console.log(`  git:    ${audit.tree.git ? audit.tree.detail : 'not a git work tree'}\n`)

if (plan.actions.length === 0) {
  console.log('nothing to add: the standard files are already there')
} else {
  console.log('would add:')
  for (const action of plan.actions) console.log(`  ${mark('auto')} ${action.id.padEnd(18)} ${action.detail}`)
}

if (plan.decisions.length > 0) {
  console.log('\nneeds a decision (not touched):')
  for (const decision of plan.decisions) console.log(`  ${mark('decide')} ${decision.id.padEnd(18)} ${decision.detail}`)
}

if (plan.manual.length > 0) {
  console.log('\nreport only:')
  for (const item of plan.manual) console.log(`  ${mark('manual')} ${item.id.padEnd(18)} ${item.detail}`)
}

if (plan.blocked !== undefined) {
  console.log(`\nrefusing to write: ${plan.blocked}`)
  if (!has('--force')) process.exit(1)
}

if (has('--apply') || has('--dry-run')) {
  const result = await applyAdoption(directory, plan, { dryRun: has('--dry-run'), force: has('--force') })
  console.log(`\n${result.dryRun ? 'dry run' : 'applied'}: ${result.applied.length} change(s), ${result.skipped.length} skipped`)
  for (const item of result.applied) console.log(`  + ${item.id} (${item.path})`)
  for (const item of result.skipped) console.log(`  = ${item.id} (${item.path}): ${item.reason}`)
  if (!result.dryRun && result.applied.length > 0) {
    console.log('\nnext: node scripts/check-project.mjs .   (if the project now has checks.json)')
    console.log('      git diff                            (review before committing)')
  }
}
