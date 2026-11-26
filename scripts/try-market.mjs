// Tests for lib/market.js: building the entry from the package, the published
// rules, and the quoting that decides whether the file parses.
//
//   node scripts/try-market.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEntry, CATEGORIES, entrySlug, renderEntry, validateEntry } from '../lib/market.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-market')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const status = (result, id) => result.checks.find(item => item.id === id)?.status
const message = (result, id) => result.checks.find(item => item.id === id)?.message ?? ''

/** A package directory with a git remote, so the entry can be derived. */
function makePackage(name, options = {}) {
  const root = join(work, name)
  mkdirSync(join(root, 'locale'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-fixture',
    version: '1.0.0',
    description: 'A fixture package for the market entry tests.',
    ...(options.manifest ?? {}),
  }, null, 2))
  writeFileSync(join(root, 'locale', 'en.json'), JSON.stringify({
    meta: { title: 'Fixture', description: 'Does one thing well. And then some more text that is not the market line.' },
  }))
  if (options.market !== undefined) writeFileSync(join(root, 'market.json'), JSON.stringify(options.market, null, 2))
  if (options.remote !== false) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['remote', 'add', 'origin', options.remote ?? 'https://github.com/owner/dsh-plugin-fixture.git'], { cwd: root })
  }
  return root
}

rmSync(work, { recursive: true, force: true })

try {
  console.log('\nentry slug')
  check('a plain repo', entrySlug('https://github.com/owner/repo') === 'owner__repo.yml')
  check('a monorepo subdirectory', entrySlug('https://github.com/owner/repo/tree/main/packages/my-plugin') === 'owner__repo--packages-my-plugin.yml')
  check('a non-github url has no slug', entrySlug('https://gitlab.com/owner/repo') === undefined)

  console.log('\nbuilding from the package')
  const plain = makePackage('plain')
  const derived = buildEntry(plain)
  check('the url comes from the git remote', derived.entry.url === 'https://github.com/owner/dsh-plugin-fixture', derived.entry.url)
  check('the name is owner/repo', derived.entry.name === 'owner/dsh-plugin-fixture')
  check('the category defaults to dev', derived.entry.category === 'dev')
  check('the line is the first sentence of meta.description', derived.entry.description.en === 'Does one thing well.', derived.entry.description.en)
  check('an ssh remote is normalised', buildEntry(makePackage('ssh', { remote: 'git@github.com:owner/other.git' })).entry.name === 'owner/other')
  check('no market.json is reported as derived', derived.source === undefined)

  const curated = makePackage('curated', {
    market: {
      category: 'tools',
      description: { en: 'Does one thing: the fixture. It also ends with a period.', zh: '做一件事：夹具。' },
      icon: 'https://raw.githubusercontent.com/owner/dsh-plugin-fixture/main/assets/icon-180.png',
    },
  })
  const built = buildEntry(curated)
  check('market.json wins over the derived values', built.entry.category === 'tools' && built.entry.description.en.startsWith('Does one thing:'))
  check('market.json is named as the source', built.source?.endsWith('market.json') === true)

  console.log('\nthe published rules')
  const good = validateEntry({
    url: 'https://github.com/owner/repo',
    name: 'owner/repo',
    category: 'dev',
    description: { en: 'Adds a thing that does something. It ends with a period.', zh: '加一个做事的东西。' },
  })
  check('a well-formed entry passes', good.ok === true, JSON.stringify(good.checks.filter(item => item.status === 'fail')))
  check('the filename is reported', good.filename === 'owner__repo.yml')

  const badUrl = validateEntry({ url: 'https://gitlab.com/owner/repo', name: 'owner/repo', category: 'dev', description: { en: 'X.' } })
  check('a non-github url fails', status(badUrl, 'market:url') === 'fail')

  const badCategory = validateEntry({ url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'plugins', description: { en: 'X.' } })
  check('an unknown category fails', status(badCategory, 'market:category') === 'fail')
  check('the allowed categories are listed', /dev/.test(message(badCategory, 'market:category')))

  const noPeriod = validateEntry({ url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev', description: { en: 'No period here' } })
  check('a description without a period fails', status(noPeriod, 'market:description-en') === 'fail')

  const multiline = validateEntry({ url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev', description: { en: 'Line one.\nLine two.' } })
  check('a multi-line description fails', status(multiline, 'market:description-en') === 'fail')

  const noEnglish = validateEntry({ url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev', description: { zh: '只有中文。' } })
  check('a missing description.en fails', status(noEnglish, 'market:description-en') === 'fail')

  const noChinese = validateEntry({ url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev', description: { en: 'Only English.' } })
  check('a missing description.zh only warns', status(noChinese, 'market:description-zh') === 'warn' && noChinese.ok === true)

  const svgIcon = validateEntry({
    url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev',
    description: { en: 'X.' }, icon: 'https://raw.githubusercontent.com/owner/repo/main/icon.svg',
  })
  check('an svg icon fails', status(svgIcon, 'market:icon') === 'fail')
  const goodIcon = validateEntry({
    url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev',
    description: { en: 'X.' }, icon: 'https://raw.githubusercontent.com/owner/repo/main/icon.png',
  })
  check('a github-hosted png passes', status(goodIcon, 'market:icon') === 'pass')

  const rotting = validateEntry({
    url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev',
    description: { en: 'X.' }, tarball: 'https://github.com/owner/repo/releases/latest/download/repo-1.2.0.tgz',
  })
  check('a versioned asset under latest/download warns about rot', status(rotting, 'market:tarball-rot') === 'warn', message(rotting, 'market:tarball-rot'))
  const pinned = validateEntry({
    url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev',
    description: { en: 'X.' }, tarball: 'https://github.com/owner/repo/releases/download/v1.2.0/repo-1.2.0.tgz',
  })
  check('a pinned tag with a version is fine', status(pinned, 'market:tarball') === 'pass' && status(pinned, 'market:tarball-rot') === undefined)

  console.log('\nrendering')
  const rendered = renderEntry({
    url: 'https://github.com/owner/repo',
    name: 'owner/repo',
    category: 'dev',
    description: { en: 'Does one thing: the fixture.', zh: '做一件事：夹具。' },
  })
  check('url, name and category stay plain', rendered.startsWith('url: https://github.com/owner/repo\nname: owner/repo\ncategory: dev\n'), rendered)
  check('a description containing ": " is quoted', rendered.includes("en: 'Does one thing: the fixture.'"), rendered)
  check('a quote inside a value is doubled', renderEntry({
    url: 'https://github.com/owner/repo', name: 'owner/repo', category: 'dev',
    description: { en: "It's a fixture." },
  }).includes("en: 'It''s a fixture.'"))

  const { entry } = buildEntry(plain)
  check('a derived entry renders', renderEntry(entry).includes('name: owner/dsh-plugin-fixture'))

  console.log('\nthis repository')
  const own = buildEntry(repo)
  const ownValidation = validateEntry(own.entry)
  check('this repository produces a valid entry', ownValidation.ok === true, JSON.stringify(ownValidation.checks.filter(item => item.status === 'fail')))
  check('the category is a published one', CATEGORIES.includes(own.entry.category))
  check('the line is one sentence ending with a period', own.entry.description.en.split(/(?<=\.)\s/).length >= 1 && /\.$/.test(own.entry.description.en))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nMARKET TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nmarket ok')
}
