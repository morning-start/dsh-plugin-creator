// Tests for lib/adopt.js: what it may decide, what it must leave alone.
//
//   node scripts/try-adopt.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { applyAdoption, auditProject, planAdoption, workingTreeState } from '../lib/adopt.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-adopt')

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
const ids = plan => plan.actions.map(action => action.id).sort()

/** A project that already meets the standard. */
function makeComplete(root, options = {}) {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, 'locale'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-complete',
    version: '1.0.0',
    description: 'A fixture that already meets the standard.',
    repository: { type: 'git', url: 'git+https://github.com/owner/dsh-plugin-complete.git' },
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(root, 'index.js'), 'export default {}\n')
  writeFileSync(join(root, 'cordis.patch.yml'), 'plugins: []\n')
  writeFileSync(join(root, 'checks.json'), JSON.stringify({ version: 1, rules: [] }, null, 2))
  writeFileSync(join(root, '.github', 'workflows', 'release.yml'), 'name: Release\n')
  writeFileSync(join(root, 'market.json'), JSON.stringify({ category: 'dev', description: { en: 'x.' } }, null, 2))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ntmp/\n')
  writeFileSync(join(root, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'T', description: 'Does a thing.' } }))
  writeFileSync(join(root, 'locale', 'zh.json'), JSON.stringify({ meta: { title: 'T', description: '做一件事。' } }))
  git(root, 'init', '-q')
  if (options.remote !== false) git(root, 'remote', 'add', 'origin', 'https://github.com/owner/dsh-plugin-complete.git')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

/** A project that runs but carries none of the standard files. */
function makeBare(root, options = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-bare',
    version: '1.0.0',
    description: 'A bare fixture with no standard files at all.',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(root, 'index.js'), 'export default {}\n')
  writeFileSync(join(root, 'cordis.patch.yml'), 'plugins: []\n')
  git(root, 'init', '-q')
  if (options.remote !== false) git(root, 'remote', 'add', 'origin', 'https://github.com/owner/dsh-plugin-bare.git')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

rmSync(work, { recursive: true, force: true })

try {
  console.log('\na project that already meets the standard')
  const complete = makeComplete(join(work, 'complete'))
  const completePlan = await planAdoption(complete)
  check('it plans no writes', completePlan.actions.length === 0, JSON.stringify(ids(completePlan)))
  check('it is not blocked', completePlan.blocked === undefined)
  const noop = await applyAdoption(complete, completePlan)
  check('applying writes nothing', noop.applied.length === 0 && noop.skipped.length === 0)

  console.log('\na project with no standard files')
  const bare = makeBare(join(work, 'bare'))
  const barePlan = await planAdoption(bare)
  check('it plans the five safe additions', JSON.stringify(ids(barePlan)) === JSON.stringify([
    'add-checks-json', 'add-ci-workflow', 'add-market-json', 'add-repository', 'append-gitignore',
  ]), JSON.stringify(ids(barePlan)))
  check('patch drift is reported, not acted on', barePlan.manual.some(item => item.id === 'patch:drift'))

  const dry = await applyAdoption(bare, barePlan, { dryRun: true })
  check('a dry run reports the writes', dry.applied.length === 5 && dry.dryRun === true)
  check('a dry run writes nothing', !existsSync(join(bare, 'checks.json')) && !existsSync(join(bare, 'market.json')))

  const applied = await applyAdoption(bare, barePlan)
  check('apply writes all five', applied.applied.length === 5, JSON.stringify(applied.skipped))

  const after = await planAdoption(bare)
  check('a second run plans nothing', after.actions.length === 0, JSON.stringify(ids(after)))

  const manifest = JSON.parse(readFileSync(join(bare, 'package.json'), 'utf8'))
  check('repository comes from the git remote', manifest.repository?.url === 'git+https://github.com/owner/dsh-plugin-bare.git', JSON.stringify(manifest.repository))
  check('the workflow is the real one', readFileSync(join(bare, '.github/workflows/release.yml'), 'utf8').includes("tags: ['v*']"))
  check('the workflow unescapes Actions contexts', readFileSync(join(bare, '.github/workflows/release.yml'), 'utf8').includes('${{ github.ref }}'))
  const checksFile = JSON.parse(readFileSync(join(bare, 'checks.json'), 'utf8'))
  check('the starter checks only hold rules the project passes', Array.isArray(checksFile.rules) && checksFile.rules.length > 0, JSON.stringify(checksFile.rules.map(rule => rule.id)))
  check('gitignore gained both entries', readFileSync(join(bare, '.gitignore'), 'utf8').includes('node_modules/') && readFileSync(join(bare, '.gitignore'), 'utf8').includes('tmp/'))
  const market = JSON.parse(readFileSync(join(bare, 'market.json'), 'utf8'))
  check('the market draft carries the note that it needs a read', typeof market._note === 'string')

  console.log('\nmanifest formatting')
  const formatted = join(work, 'formatted')
  makeBare(formatted)
  // A hand-written manifest: 4-space indent, keys in an order the owner chose.
  writeFileSync(join(formatted, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-bare',
    version: '1.0.0',
    description: 'A bare fixture with no standard files at all.',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 4) + '\n')
  git(formatted, 'add', '-A')
  git(formatted, 'commit', '-q', '-m', 'reformat')
  const formattedBefore = readFileSync(join(formatted, 'package.json'), 'utf8')
  const formattedPlan = await planAdoption(formatted)
  await applyAdoption(formatted, formattedPlan)
  const formattedAfter = readFileSync(join(formatted, 'package.json'), 'utf8')
  check('the 4-space indent survives', formattedAfter.startsWith('{\n    "name"'), JSON.stringify(formattedAfter.slice(0, 20)))
  check('the original text is still a prefix of the new file', formattedAfter.startsWith(formattedBefore.trimEnd().replace(/}$/, '').trimEnd()))
  check('the added field is the only new key', Object.keys(JSON.parse(formattedAfter)).length === Object.keys(JSON.parse(formattedBefore)).length + 1)
  check('the result still parses and keeps the version', JSON.parse(formattedAfter).version === '1.0.0')

  console.log('\nnot overwriting')
  const custom = join(work, 'custom')
  makeBare(custom)
  writeFileSync(join(custom, 'checks.json'), '{"version":1,"rules":[],"mine":true}\n')
  git(custom, 'add', '-A')
  git(custom, 'commit', '-q', '-m', 'custom checks')
  const before = readFileSync(join(custom, 'checks.json'), 'utf8')
  const customPlan = await planAdoption(custom)
  await applyAdoption(custom, customPlan)
  check('an existing checks.json is byte-identical afterwards', readFileSync(join(custom, 'checks.json'), 'utf8') === before)

  // The plan says "add checks.json"; then the file appears before apply runs.
  // The only thing standing between that race and a destroyed file is the skip.
  const raced = join(work, 'raced')
  makeBare(raced)
  const racedPlan = await planAdoption(raced)
  writeFileSync(join(raced, 'checks.json'), '{"version":1,"rules":[],"mine":true}\n')
  const racedBefore = readFileSync(join(raced, 'checks.json'), 'utf8')
  const racedResult = await applyAdoption(raced, racedPlan, { force: true })
  check('a file that appeared after planning is skipped', racedResult.skipped.some(item => item.id === 'add-checks-json'), JSON.stringify(racedResult.skipped))
  check('and left byte-identical', readFileSync(join(raced, 'checks.json'), 'utf8') === racedBefore)

  console.log('\nrefusing to write over uncommitted work')
  const dirty = join(work, 'dirty')
  makeBare(dirty)
  writeFileSync(join(dirty, 'index.js'), 'export default { changed: true }\n')
  const dirtyPlan = await planAdoption(dirty)
  check('a dirty tree blocks the plan', typeof dirtyPlan.blocked === 'string', String(dirtyPlan.blocked))
  let refused = ''
  try {
    await applyAdoption(dirty, dirtyPlan)
  } catch (error) {
    refused = error.message
  }
  check('applying refuses', /dirty/.test(refused), refused)
  check('nothing was written', !existsSync(join(dirty, 'checks.json')))
  const forced = await applyAdoption(dirty, dirtyPlan, { force: true })
  check('--force writes anyway', forced.applied.length > 0)

  console.log('\noutside git')
  // Outside the repository on purpose: a subdirectory of a work tree is still
  // inside one, so "not in git" has to mean a directory outside any work tree.
  const loose = mkdtempSync(join(tmpdir(), 'adopt-loose-'))
  mkdirSync(loose, { recursive: true })
  writeFileSync(join(loose, 'package.json'), JSON.stringify({ name: 'dsh-plugin-loose', version: '1.0.0', description: 'Not in git at all, so nothing could be rolled back.', exports: { '.': './index.js' } }, null, 2))
  writeFileSync(join(loose, 'index.js'), 'export default {}\n')
  check('a directory outside git is recognised', workingTreeState(loose).git === false)
  const loosePlan = await planAdoption(loose)
  check('no repository action without a remote', loosePlan.actions.every(action => action.id !== 'add-repository'))
  rmSync(loose, { recursive: true, force: true })

  console.log('\nnot a plugin package')
  const notPackage = join(work, 'not-a-package')
  mkdirSync(notPackage, { recursive: true })
  writeFileSync(join(notPackage, 'README.md'), '# not a package\n')
  let refusal = ''
  try {
    await auditProject(notPackage)
  } catch (error) {
    refusal = error.message
  }
  check('a directory without package.json is refused clearly', /no package\.json/.test(refusal), refusal)
  check('the message names the monorepo case', /subdirectory/.test(refusal), refusal)

  console.log('\nthis repository')
  const own = await auditProject(repo)
  check('this repository passes its own bundle check', own.bundle.ok === true, JSON.stringify(own.bundle.checks.filter(item => item.status === 'fail')))
  check('it has every standard file', own.missing.length === 0, JSON.stringify(own.missing.map(item => item.path)))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nADOPT TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nadopt ok')
}
