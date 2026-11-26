// Tests for the project-check engine: the four rule types that carry the
// "开发规范化" load, plus the checks-file loader.
//
//   node scripts/try-checks.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChecks, runProjectChecks } from '../lib/checks.js'
import { runRules } from '../lib/rules.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-checks')

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

rmSync(work, { recursive: true, force: true })

try {
  console.log('\ndoc links')
  const docs = join(work, 'docs')
  mkdirSync(join(docs, 'guide'), { recursive: true })
  writeFileSync(join(docs, 'index.md'), [
    '# index',
    '[guide](guide/start.md)',
    '[missing](guide/nope.md)',
    '[external](https://example.com/x)',
    '[anchor](#section)',
    '[absolute](/etc/passwd)',
  ].join('\n'))
  writeFileSync(join(docs, 'guide', 'start.md'), '# start\n[back](../index.md)\n')
  const brokenLinks = await runRules(work, [{ id: 'links', type: 'doc-links' }])
  check('a broken relative link fails', brokenLinks.checks[0].status === 'fail')
  check('the report names the file and the target', /docs\/index\.md → guide\/nope\.md/.test(brokenLinks.checks[0].message), brokenLinks.checks[0].message)
  check('external, anchor, and absolute links are skipped', !/example\.com|#section|\/etc\/passwd/.test(brokenLinks.checks[0].message), brokenLinks.checks[0].message)

  writeFileSync(join(docs, 'index.md'), '# index\n[guide](guide/start.md)\n')
  const goodLinks = await runRules(work, [{ id: 'links', type: 'doc-links' }])
  check('all links resolving passes', goodLinks.checks[0].status === 'pass', goodLinks.checks[0].message)
  check('the count is reported', /2 markdown file\(s\), 2 relative link\(s\)/.test(goodLinks.checks[0].message), goodLinks.checks[0].message)

  mkdirSync(join(work, 'tmp'), { recursive: true })
  writeFileSync(join(work, 'tmp', 'scratch.md'), '[dead](nowhere.md)')
  const skipped = await runRules(work, [{ id: 'links', type: 'doc-links' }])
  check('tmp/ is not part of the doc tree', skipped.checks[0].status === 'pass', skipped.checks[0].message)

  console.log('\nlocale parity')
  mkdirSync(join(work, 'locale'), { recursive: true })
  writeFileSync(join(work, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'T', description: 'D' } }))
  writeFileSync(join(work, 'locale', 'zh.json'), JSON.stringify({ meta: { title: 'T' } }))
  const parity = await runRules(work, [{ id: 'locale', type: 'locale-parity' }])
  check('a missing key fails', parity.checks[0].status === 'fail')
  check('the missing key is named', /description/.test(parity.checks[0].message), parity.checks[0].message)
  writeFileSync(join(work, 'locale', 'zh.json'), JSON.stringify({ meta: { title: 'T', description: 'D' } }))
  const parityOk = await runRules(work, [{ id: 'locale', type: 'locale-parity' }])
  check('matching keys pass', parityOk.checks[0].status === 'pass', parityOk.checks[0].message)

  console.log('\nimport boundaries')
  const src = join(work, 'src')
  mkdirSync(join(src, 'domain'), { recursive: true })
  mkdirSync(join(src, 'application'), { recursive: true })
  mkdirSync(join(src, 'infrastructure'), { recursive: true })
  writeFileSync(join(src, 'domain', 'user.ts'), 'export const user = 1\n')
  writeFileSync(join(src, 'application', 'use.ts'), "import { user } from '../domain/user.js'\n")
  writeFileSync(join(src, 'infrastructure', 'db.ts'), "import { readFileSync } from 'node:fs'\nexport const db = readFileSync\n")
  const boundaryConfig = [{
    id: 'arch',
    type: 'import-boundary',
    root: 'src',
    layers: { domain: ['application', 'infrastructure'], application: ['infrastructure'], infrastructure: [] },
    builtins: { domain: ['fs', 'child_process'], application: ['fs'] },
    allowExternal: ['infrastructure'],
  }]
  const clean = await runRules(work, boundaryConfig)
  check('a correct layering passes', clean.checks[0].status === 'pass', clean.checks[0].message)

  writeFileSync(join(src, 'domain', 'bad.ts'), "import { db } from '../infrastructure/db.js'\nexport const bad = db\n")
  const outward = await runRules(work, boundaryConfig)
  check('an outward import fails', outward.checks[0].status === 'fail')
  check('the violation names the layers', /domain must not import infrastructure/.test(outward.checks[0].message), outward.checks[0].message)

  writeFileSync(join(src, 'domain', 'bad.ts'), "import { readFileSync } from 'node:fs'\nexport const bad = readFileSync\n")
  const builtin = await runRules(work, boundaryConfig)
  check('a host module in an inner layer fails', builtin.checks[0].status === 'fail', builtin.checks[0].message)

  writeFileSync(join(src, 'domain', 'bad.ts'), "import lodash from 'lodash'\nexport const bad = lodash\n")
  const external = await runRules(work, boundaryConfig)
  check('a package in an inner layer fails', external.checks[0].status === 'fail', external.checks[0].message)

  writeFileSync(join(src, 'domain', 'bad.ts'), 'export const ok = 1\n')
  console.log('\nno-console')
  writeFileSync(join(src, 'application', 'noisy.ts'), 'console.log("hi")\n')
  const noisy = await runRules(work, [{ id: 'console', type: 'no-console', root: 'src', layers: ['application'] }])
  check('console in a watched layer fails', noisy.checks[0].status === 'fail', noisy.checks[0].message)
  const scoped = await runRules(work, [{ id: 'console', type: 'no-console', root: 'src', layers: ['domain'] }])
  check('a layer outside the watch list is ignored', scoped.checks[0].status === 'pass', scoped.checks[0].message)

  console.log('\nchecks file')
  await expectError('a missing checks file is an error', () => loadChecks(work), /no checks file/)
  writeFileSync(join(work, 'checks.json'), JSON.stringify({ version: 1, rules: [{ id: 'entry', type: 'file-exists', path: 'package.json' }] }))
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
  const loaded = await loadChecks(work)
  check('the conventional name is found', loaded.path.endsWith('checks.json'))
  const run = await runProjectChecks(work)
  check('the declared rule runs', run.checks[0].status === 'pass', JSON.stringify(run.checks))
  check('the run reports how many rules ran', run.ran === 1 && run.declared === 1)

  const filtered = await runProjectChecks(work, { only: ['other'] })
  check('--only filters', filtered.ran === 0)

  writeFileSync(join(work, 'checks.json'), JSON.stringify({ version: 1, rules: [] }))
  await expectError('an empty rules array is an error', () => loadChecks(work), /non-empty "rules"/)
  writeFileSync(join(work, 'checks.json'), JSON.stringify({ version: 1, rules: [{ id: 'x' }] }))
  await expectError('a rule without a type is an error', () => loadChecks(work), /needs a "type"/)

  console.log('\nthis repository')
  const own = await runProjectChecks(repo)
  check('this repository passes its own checks', own.ok === true, JSON.stringify(own.checks.filter(item => item.status !== 'pass')))
  check('the documentation tree was actually walked', /markdown file/.test(own.checks.find(item => item.id === 'docs:links')?.message ?? ''), JSON.stringify(own.checks))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nCHECKS TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nchecks ok')
}
