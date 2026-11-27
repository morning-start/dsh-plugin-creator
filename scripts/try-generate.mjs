// Tests for the generic template engine (lib/generate.js) and the declarative
// rule runner (lib/rules.js), using a throwaway scheme — the engine must not know
// anything about plugins.
//
//   node scripts/try-generate.mjs
//
// Also asserts the real bundle scheme still produces the file sets it promises,
// with and without a tool and a skill, and that its own rules pass.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, loadRecipe, render, test } from '../lib/generate.js'
import { covers, runRules, walk } from '../lib/rules.js'
import { scaffold } from '../lib/scaffold.js'
import { runProjectChecks } from '../lib/checks.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-generate')
const scheme = join(work, 'scheme')

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
mkdirSync(scheme, { recursive: true })

writeFileSync(join(scheme, 'recipe.json'), JSON.stringify({
  name: 'test',
  variables: [
    { name: 'flag', type: 'boolean', default: true },
    { name: 'name', required: true, transform: 'trim' },
    { name: 'slug', derive: 'slug' },
    { name: 'long', required: true, minLength: 3 },
  ],
  files: [
    { from: 'main.txt.tpl', to: '{{slug}}.txt' },
    { from: 'json.tpl', to: 'data.json' },
    { from: 'extra.txt.tpl', to: 'extra.txt', when: 'flag' },
    { from: 'min.txt.tpl', to: 'extra.txt', when: '!flag' },
    { from: 'local.txt', to: '.local', package: false },
  ],
  rules: [
    { type: 'placeholder-free' },
    { type: 'file-exists', path: 'data.json' },
    { type: 'json-field', path: 'data.json', field: 'ok', equals: true },
    { type: 'files-listed', manifest: 'data.json' },
  ],
}, null, 2))

writeFileSync(join(scheme, 'main.txt.tpl'), '---\nname: {{slug}}\n---\nhello {{name}}\n')
writeFileSync(join(scheme, 'json.tpl'), '{"ok": true, "files": ["*.txt", "data.json"], "name": {{name|json}}}')
writeFileSync(join(scheme, 'extra.txt.tpl'), 'extra\n')
writeFileSync(join(scheme, 'min.txt.tpl'), 'min\n')
writeFileSync(join(scheme, 'local.txt'), 'local\n')

const derivations = {
  slug: values => String(values.name ?? '').toLowerCase().replace(/\s+/g, '-'),
}

try {
  console.log('\nrecipe loading')
  const recipe = await loadRecipe(scheme)
  check('loads a recipe', recipe.name === 'test')
  await expectError('a missing recipe is an error', () => loadRecipe(join(work, 'nope')), /no recipe\.json/)
  mkdirSync(join(work, 'broken'), { recursive: true })
  writeFileSync(join(work, 'broken', 'recipe.json'), '{')
  await expectError('invalid JSON is an error', () => loadRecipe(join(work, 'broken')), /not valid JSON/)

  console.log('\nthe when grammar')
  check('a truthy name', test('flag', { flag: true }))
  check('a negated name', test('!flag', { flag: false }))
  check('either side of ||', test('nope || flag', { flag: true }))
  check('false when nothing matches', test('nope', { flag: true }) === false)
  check('an empty array is falsy', test('list', { list: [] }) === false)

  console.log('\nrendering')
  check('a scalar', render('a{{x}}b', { x: 'X' }) === 'aXb')
  check('a JSON filter escapes quotes', render('{{x|json}}', { x: 'a"b' }) === '"a\\"b"')
  await expectError('an unresolved placeholder is fatal', async () => render('{{nope}}', {}), /unresolved placeholders/)
  await expectError('an unknown filter is fatal', async () => render('{{x|bogus}}', { x: 1 }), /unknown filter/)

  console.log('\nvariable resolution')
  const out = join(work, 'out')
  const first = await generate({ recipe, dest: out, values: { name: '  Hello World  ', long: 'abc' }, derivations })
  check('a transform trims', readFileSync(join(out, 'hello-world.txt'), 'utf8').includes('hello Hello World'))
  check('a derive feeds the path', existsSync(join(out, 'hello-world.txt')))
  check('a boolean default applies', existsSync(join(out, 'extra.txt')) && readFileSync(join(out, 'extra.txt'), 'utf8').trim() === 'extra')
  check('the json filter produced valid JSON', JSON.parse(readFileSync(join(out, 'data.json'), 'utf8')).name === 'Hello World')
  check('rules ran', first.checks.ok === true, JSON.stringify(first.checks?.checks))
  check('the local-only file is ignored by files-listed', first.checks.checks.every(item => item.status === 'pass'), JSON.stringify(first.checks.checks))

  await expectError('a required variable is required',
    () => generate({ recipe, dest: join(work, 'x1'), values: { long: 'abc' }, derivations }), /name is required/)
  await expectError('minLength is enforced',
    () => generate({ recipe, dest: join(work, 'x2'), values: { name: 'a', long: 'ab' }, derivations }), /at least 3 characters/)
  await expectError('a non-empty destination needs force',
    () => generate({ recipe, dest: out, values: { name: 'again', long: 'abc' }, derivations }), /not empty/)

  const forced = await generate({ recipe, dest: out, values: { name: 'again', long: 'abc' }, derivations, force: true })
  check('force writes anyway', forced.files.length > 0)

  const dry = join(work, 'dry')
  const planned = await generate({ recipe, dest: dry, values: { name: 'dry run', long: 'abc' }, derivations, dryRun: true })
  check('dry run lists files', planned.files.includes('dry-run.txt'))
  check('dry run writes nothing', !existsSync(dry))
  check('dry run runs no rules', planned.checks === undefined)

  console.log('\nrule types')
  const rulesDir = join(work, 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(join(rulesDir, 'a.txt'), '{{leftover}}\n')
  writeFileSync(join(rulesDir, 'SKILL.md'), '---\nname: real\n---\nbody\n')
  const ruleRun = await runRules(rulesDir, [
    { id: 'ph', type: 'placeholder-free' },
    { id: 'fe', type: 'file-exists', path: 'a.txt' },
    { id: 'fa', type: 'file-absent', path: 'nope.txt' },
    { id: 'fm', type: 'frontmatter-name', path: 'SKILL.md', equals: 'expected' },
    { id: 'fm-ok', type: 'frontmatter-name', path: 'SKILL.md', equals: 'real' },
    { id: 'unknown', type: 'nonsense' },
  ])
  const status = id => ruleRun.checks.find(item => item.id === id)?.status
  check('a leftover placeholder fails', status('ph') === 'fail')
  check('file-exists passes', status('fe') === 'pass')
  check('file-absent passes', status('fa') === 'pass')
  check('a wrong frontmatter name fails', status('fm') === 'fail')
  check('a matching frontmatter name passes', status('fm-ok') === 'pass')
  check('an unknown rule type fails without throwing', status('unknown') === 'fail')
  check('the summary counts every check', ruleRun.summary.fail + ruleRun.summary.pass === 6)

  console.log('\nwhitelist matching')
  check('an exact file', covers('index.js', 'index.js'))
  check('a directory prefix', covers('tools', 'tools/example.js'))
  check('a single-level glob', covers('locale/*.json', 'locale/en.json'))
  check('a glob does not cross a slash', covers('locale/*.json', 'locale/deep/en.json') === false)
  check('an unlisted file is not covered', covers('index.js', 'other.js') === false)

  console.log('\nthe bundle scheme')
  for (const [label, values, expected] of [
    ['tool only', { packageName: 'dsh-plugin-a', title: 'A', description: 'A test plugin for the engine.' }, ['index.js', 'tools/example.js', 'cordis.patch.yml', 'locale/en.json', 'package.json', 'README.md', 'icon.svg', '.gitignore', '.gitattributes', 'checks.json', '.github/workflows/release.yml']],
    ['no tool, with skill', { packageName: '@scope/b', title: 'B', description: 'Another test plugin here.', withTool: false, withSkill: true, titleZh: '乙' }, ['index.js', 'skills/b/SKILL.md', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'package.json', 'checks.json', '.github/workflows/release.yml']],
  ]) {
    const dest = join(work, label.replace(/[^a-z]+/g, '-'))
    const result = await scaffold({ ...values, dest })
    check(`${label}: expected files present`, expected.every(file => result.files.includes(file)), JSON.stringify(result.files))
    check(`${label}: checks pass`, result.checks.ok === true, JSON.stringify(result.checks.checks.filter(item => item.status !== 'pass')))
    check(`${label}: no tool means no tools dir`, values.withTool === false ? !result.files.includes('tools/example.js') : true)
    check(`${label}: skill frontmatter matches`, values.withSkill === true
      ? readFileSync(join(dest, 'skills', values.packageName.split('/').pop(), 'SKILL.md'), 'utf8').includes(`name: ${values.packageName.split('/').pop()}`)
      : true)
    // The starter checks file must actually pass on the project it ships with.
    const starter = await runProjectChecks(dest)
    check(`${label}: the starter checks pass`, starter.ok === true, JSON.stringify(starter.checks.filter(item => item.status !== 'pass')))
    check(`${label}: the zh variant declares locale parity`,
      values.titleZh === undefined ? starter.ran === 5 : starter.ran === 6, `${starter.ran} rules ran`)
  }

  const walked = await walk(join(work, 'out'))
  check('walk lists generated files', walked.includes('data.json') && walked.includes('hello-world.txt'))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nGENERATE TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\ngenerate ok')
}
