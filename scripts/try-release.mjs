// Tests for lib/release.js: the semver subset, the readiness checks, and the
// packer surface. No network, no publish, no sandbox.
//
//   node scripts/try-release.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGithubRelease, inspectRelease, packSurface, parseVersion, publishRelease, satisfies, verifyPublished } from '../lib/release.js'

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

  console.log('\npublishing')
  const publishable = join(work, 'publishable')
  mkdirSync(publishable, { recursive: true })
  writeFileSync(join(publishable, 'package.json'), JSON.stringify({ name: 'dsh-plugin-publishable', version: '1.2.3' }))
  const stub = join(work, 'stub-publisher.mjs')
  writeFileSync(stub, 'console.log("+ dsh-plugin-publishable@1.2.3")\n')
  const fakePublisher = { kind: 'npm', command: `node "${stub}"` }

  const dry = publishRelease(publishable, { publisher: fakePublisher, dryRun: true })
  check('a dry run does not need confirmation', dry.ok === true && dry.dryRun === true)
  check('a dry run still reports the version', dry.version === '1.2.3')

  let refused = ''
  try {
    publishRelease(publishable, { publisher: fakePublisher })
  } catch (error) {
    refused = error.message
  }
  check('a real publish refuses without confirmation', /irreversible/.test(refused), refused)

  const published = publishRelease(publishable, { publisher: fakePublisher, confirmed: true })
  check('a confirmed publish runs the publisher', published.ok === true && published.output.includes('@1.2.3'), published.output)

  const privateDir = join(work, 'private')
  mkdirSync(privateDir, { recursive: true })
  writeFileSync(join(privateDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true }))
  let privateRefusal = ''
  try {
    publishRelease(privateDir, { publisher: fakePublisher, confirmed: true })
  } catch (error) {
    privateRefusal = error.message
  }
  check('private: true blocks publishing', /private/.test(privateRefusal), privateRefusal)

  console.log('\nregistry propagation')
  const { createServer } = await import('node:http')
  let stale = false
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/dsh-plugin-fixture')) {
      const tarball = `http://127.0.0.1:${server.address().port}/fixture-1.0.0.tgz`
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        'dist-tags': { latest: stale ? '0.0.0-stage' : '1.0.0' },
        versions: { '1.0.0': { dist: { tarball } } },
      }))
      return
    }
    if (request.url === '/fixture-1.0.0.tgz') {
      response.writeHead(stale ? 404 : 200)
      response.end('')
      return
    }
    response.writeHead(404)
    response.end('')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const registry = `http://127.0.0.1:${server.address().port}`

  const settled = await verifyPublished('dsh-plugin-fixture', '1.0.0', { registry })
  check('a settled publish passes', settled.ok === true, JSON.stringify(settled.findings))
  check('the dist-tag is checked', settled.findings.find(item => item.id === 'npm:dist-tag')?.status === 'pass')
  check('the tarball is checked', settled.findings.find(item => item.id === 'npm:tarball')?.status === 'pass')

  stale = true
  const staleResult = await verifyPublished('dsh-plugin-fixture', '1.0.0', { registry })
  check('a placeholder dist-tag fails', staleResult.ok === false)
  check('it says what the tag points at', /0\.0\.0-stage/.test(staleResult.findings.find(item => item.id === 'npm:dist-tag')?.message ?? ''))
  check('an unreachable tarball fails', staleResult.findings.find(item => item.id === 'npm:tarball')?.status === 'fail')
  server.close()

  const missing = await verifyPublished('dsh-plugin-fixture', '1.0.0', { registry, timeoutMs: 1500 })
  check('an unreachable registry fails instead of hanging', missing.ok === false)

  console.log('\ngithub release')
  const packed = join(work, 'release', 'dsh-plugin-publishable-1.2.3.tgz')
  mkdirSync(join(work, 'release'), { recursive: true })
  writeFileSync(packed, 'not really a tarball')
  const ghPlan = createGithubRelease(publishable, { tarball: packed, dryRun: true })
  check('a dry run prints the command', ghPlan.command.startsWith('gh release create v1.2.3'), ghPlan.command)
  check('the asset name carries no version', ghPlan.asset.endsWith('dsh-plugin-publishable.tgz'), ghPlan.asset)
  let ghRefusal = ''
  try {
    createGithubRelease(publishable, { tarball: join(work, 'nope.tgz'), dryRun: true })
  } catch (error) {
    ghRefusal = error.message
  }
  check('a missing tarball is refused', /pack/.test(ghRefusal), ghRefusal)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nRELEASE TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nrelease ok')
}
