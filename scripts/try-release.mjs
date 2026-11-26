// Tests for lib/release.js: the semver subset, the readiness checks, and the
// packer surface. No network, no publish, no sandbox.
//
//   node scripts/try-release.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectRelease, packSurface, parseVersion, satisfies } from '../lib/release.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-release')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

rmSync(work, { recursive: true, force: true })

try {
  console.log('\nsemver subset')
  check('parses a release version', JSON.stringify(parseVersion('1.2.3')) === JSON.stringify({ major: 1, minor: 2, patch: 3 }))
  check('parses a prerelease', parseVersion('0.2.2-rc.5')?.pre === 'rc.5')
  check('rejects nonsense', parseVersion('not-a-version') === undefined)
  check('exact match', satisfies('1.2.3', '1.2.3'))
  check('caret allows a minor bump', satisfies('1.3.0', '^1.2.3'))
  check('caret stops at the next major', satisfies('2.0.0', '^1.2.3') === false)
  check('tilde stops at the next minor', satisfies('1.2.9', '~1.2.3') && satisfies('1.3.0', '~1.2.3') === false)
  check('greater-or-equal', satisfies('0.2.3', '>=0.2.2'))
  check('less-than', satisfies('0.2.1', '<0.2.2'))
  check('either side of ||', satisfies('2.0.0', '^1.0.0 || ^2.0.0'))
  check('a prerelease is below its release', satisfies('0.2.2', '>=0.2.2-rc.5'))
  check('a prerelease satisfies its own range', satisfies('0.2.2-rc.5', '^0.2.2-rc.5'))
  check('rc.5 is above rc.4', satisfies('0.2.2-rc.5', '>=0.2.2-rc.4'))
  check('rc.5 is below rc.10 numerically', satisfies('0.2.2-rc.5', '>=0.2.2-rc.10') === false)
  check('a caret on 0.x stays in the minor', satisfies('0.3.0', '^0.2.2') === false)

  console.log('\nreadiness on a good package')
  const good = join(work, 'good')
  mkdirSync(good, { recursive: true })
  writeFileSync(join(good, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-good',
    version: '1.0.0',
    description: 'A well formed package for the release test.',
    exports: { '.': './index.js' },
    files: ['index.js', 'cordis.patch.yml', 'README.md', 'icon.svg'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    engines: { dsh: '^0.2.2-rc.5' },
  }, null, 2))
  writeFileSync(join(good, 'index.js'), 'export const name = "good"\n')
  writeFileSync(join(good, 'cordis.patch.yml'), '- insert: []\n')
  writeFileSync(join(good, 'README.md'), '# good\n')
  writeFileSync(join(good, 'icon.svg'), '<svg/>\n')

  const report = await inspectRelease(good, {
    dshVersion: '0.2.2-rc.5',
    surface: { files: ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'icon.svg'], totalSize: 2048, source: 'test' },
  })
  check('a good package passes', report.ok === true, JSON.stringify(report.checks.filter(item => item.status !== 'pass')))
  check('compatibility is checked against the given version',
    report.checks.find(item => item.id === 'release:compatibility')?.status === 'pass')

  const tooNew = await inspectRelease(good, {
    dshVersion: '0.3.0',
    surface: { files: ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'icon.svg'], totalSize: 2048, source: 'test' },
  })
  check('an incompatible DSH fails the check', tooNew.ok === false)

  console.log('\nreadiness failures')
  const bad = join(work, 'bad')
  mkdirSync(bad, { recursive: true })
  writeFileSync(join(bad, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-bad',
    version: 'nope',
    private: true,
    exports: { '.': './missing.js' },
    dsh: { bundle: { patch: './nope.yml' } },
  }, null, 2))
  const badReport = await inspectRelease(bad, {
    dshVersion: '0.2.2-rc.5',
    surface: { files: ['package.json', 'tmp/debug.log', 'node_modules/x/index.js'], totalSize: 0, source: 'test' },
  })
  const status = id => badReport.checks.find(item => item.id === id)?.status
  check('a non-semver version fails', status('release:version') === 'fail')
  check('a missing entry fails', status('release:entry') === 'fail')
  check('a missing patch fails', status('release:patch') === 'fail')
  check('private is a warning, not a failure', status('release:private') === 'warn')
  check('build leftovers in the tarball fail', status('release:surface') === 'fail')
  check('the package as a whole is not ok', badReport.ok === false)

  console.log('\npacker surface')
  const surface = packSurface(repo)
  check('a packer answered', surface.source === 'pnpm' || surface.source === 'npm', surface.source)
  check('the surface includes the manifest', surface.files.includes('package.json'), JSON.stringify(surface.files.slice(0, 5)))
  check('the surface excludes tmp', surface.files.every(file => !file.startsWith('tmp/')), JSON.stringify(surface.files.filter(file => file.startsWith('tmp/'))))
  check('the surface has a size', typeof surface.totalSize === 'number')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nRELEASE TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nrelease ok')
}
