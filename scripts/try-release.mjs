// Tests for lib/release.js: the semver subset, the readiness checks, and the
// packer surface. No network, no publish, no sandbox.
//
//   node scripts/try-release.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpVersion, createGithubRelease, inspectRelease, packSurface, parseVersion, publishRelease, satisfies, verifyPublished } from '../lib/release.js'
import { shipRelease } from '../lib/ship.js'

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

  // A fixture nested in this repository must not be judged by this repository's
  // tag: that is how a test package at 1.0.0 failed on a v0.1.3 build.
  const nested = join(work, 'nested')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-nested',
    version: '1.0.0',
    description: 'A fixture that lives inside this repository rather than at its root.',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(nested, 'index.js'), 'export default {}\n')
  writeFileSync(join(nested, 'cordis.patch.yml'), 'plugins: []\n')
  const nestedReport = await inspectRelease(nested)
  const nestedTag = nestedReport.checks.find(item => item.id === 'release:tag')
  check('a nested package is not judged by the outer tag', nestedTag?.status === 'pass', nestedTag?.message)
  check('and it says why', /not the repository root/.test(nestedTag?.message ?? ''), nestedTag?.message)

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


  console.log('\nshipping')
  const shipDir = join(work, 'ship')
  mkdirSync(shipDir, { recursive: true })
  writeFileSync(join(shipDir, 'package.json'), JSON.stringify({ name: 'dsh-plugin-ship', version: '2.0.0' }))
  const okReadiness = { ok: true, checks: [{ id: 'release:manifest', status: 'pass', message: '' }] }
  const badReadiness = { ok: false, checks: [{ id: 'release:patch', status: 'fail', message: 'no patch' }] }
  const tarball = join(work, 'ship', 'ship-2.0.0.tgz')
  writeFileSync(tarball, 'x')
  const order = []
  const deps = {
    readiness: () => okReadiness,
    packer: () => { order.push('pack'); return { tarball } },
    publisher: () => { order.push('publish'); return { ok: true, version: '2.0.0', output: '+ dsh-plugin-ship@2.0.0' } },
    releaseCreator: () => { order.push('release'); return { ok: true, url: 'https://github.com/o/r/releases/tag/v2.0.0' } },
    verifier: async () => { order.push('verify'); return { ok: true, findings: [] } },
  }

  const shipped = await shipRelease(shipDir, { ...deps, confirmed: true })
  check('a clean ship succeeds', shipped.ok === true, JSON.stringify(shipped.steps))
  check('the order is check, pack, publish, release, verify', JSON.stringify(order) === JSON.stringify(['pack', 'publish', 'release', 'verify']), JSON.stringify(order))
  check('the release URL is reported', shipped.url?.includes('/releases/tag/v2.0.0') === true)
  check('the tarball is reported', shipped.tarball === tarball)

  const blocked = await shipRelease(shipDir, { ...deps, readiness: () => badReadiness })
  check('a failed readiness stops before packing', blocked.ok === false && blocked.failedAt === 'check')
  check('it names the failed checks', blocked.failedChecks?.includes('release:patch') === true)

  const publishFailed = await shipRelease(shipDir, { ...deps, publisher: () => ({ ok: false, output: 'npm error 402' }) })
  check('a failed publish stops before the release', publishFailed.ok === false && publishFailed.failedAt === 'publish')
  check('the release never ran', publishFailed.steps.some(step => step.step === 'release') === false)

  const slow = await shipRelease(shipDir, { ...deps, verifier: async () => ({ ok: false, findings: [{ id: 'npm:tarball', status: 'fail', message: '404' }] }) })
  check('a slow registry does not undo the release', slow.ok === true && slow.installable === false)
  check('the verify step is marked advisory', slow.steps.find(step => step.step === 'verify')?.advisory === true)

  const noNpm = await shipRelease(shipDir, { ...deps, skipNpm: true })
  check('--skip-npm skips publishing', noNpm.ok === true && noNpm.steps.find(step => step.step === 'publish')?.detail.includes('skipped'))

  const dryShip = await shipRelease(shipDir, { ...deps, dryRun: true, publisher: () => ({ ok: true, dryRun: true, output: '' }), releaseCreator: () => ({ ok: true, dryRun: true, command: 'gh release create v2.0.0' }) })
  check('a dry run reports both steps as dry', dryShip.ok === true && dryShip.steps.find(step => step.step === 'publish')?.detail.includes('dry run'))

  console.log('\nversion bump (step 1 of the fixed flow)')
  const bumpDir = join(work, 'bump')
  mkdirSync(bumpDir, { recursive: true })
  const writeManifest = (version) => writeFileSync(join(bumpDir, 'package.json'), `${JSON.stringify({ name: 'dsh-plugin-bump', version }, null, 2)}\n`)
  const readVersion = () => JSON.parse(readFileSync(join(bumpDir, 'package.json'), 'utf8')).version
  const refusal = (run) => {
    try {
      run()
    } catch (error) {
      return error.message
    }
    return ''
  }

  writeManifest('1.2.3')
  const patched = bumpVersion(bumpDir, { part: 'patch' })
  check('patch bumps the last component', patched.version === '1.2.4' && readVersion() === '1.2.4', `${patched.version} / file ${readVersion()}`)
  check('the previous version is reported', patched.previous === '1.2.3', patched.previous)
  check('it prints the tag command', patched.steps.some(step => step === 'git tag v1.2.4'), JSON.stringify(patched.steps))
  check('it says CI publishes', patched.steps.some(step => /CI publishes/.test(step)), JSON.stringify(patched.steps))

  const minorBump = bumpVersion(bumpDir, { part: 'minor' })
  check('minor zeroes the patch', minorBump.version === '1.3.0', minorBump.version)
  const majorBump = bumpVersion(bumpDir, { part: 'major' })
  check('major zeroes minor and patch', majorBump.version === '2.0.0', majorBump.version)

  writeManifest('1.0.0')
  check('an explicit version is accepted', bumpVersion(bumpDir, { version: '1.5.2' }).version === '1.5.2')
  check('a downgrade is refused', /must be greater/.test(refusal(() => bumpVersion(bumpDir, { version: '0.9.0' }))), 'no refusal')
  check('the same version is refused', /must be greater/.test(refusal(() => bumpVersion(bumpDir, { version: '1.5.2' }))), 'no refusal')
  check('a non-semver target is refused', /not a semver/.test(refusal(() => bumpVersion(bumpDir, { version: 'next' }))), 'no refusal')
  check('an unknown part is refused', /patch, minor, or major/.test(refusal(() => bumpVersion(bumpDir, { part: 'huge' }))), 'no refusal')

  writeManifest('not-a-version')
  check('a non-semver current version is refused', /is not semver/.test(refusal(() => bumpVersion(bumpDir, {}))), 'no refusal')

  // The manifest must stay reviewable: two-space JSON with a trailing newline,
  // so the diff is one line rather than the whole file.
  writeManifest('3.1.4')
  bumpVersion(bumpDir, { part: 'patch' })
  const manifestText = readFileSync(join(bumpDir, 'package.json'), 'utf8')
  check('the manifest keeps npm\'s shape', manifestText.endsWith('}\n') && /^\{\n {2}"name"/.test(manifestText), JSON.stringify(manifestText.slice(0, 20)))

  // A version that already has a tag must not be re-tagged: moving a tag makes
  // what it points at untrustworthy.
  writeManifest('2.0.0')
  const { spawnSync } = await import('node:child_process')
  spawnSync('git init -q', { cwd: bumpDir, shell: true })
  spawnSync('git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', { cwd: bumpDir, shell: true })
  spawnSync('git tag v2.0.1', { cwd: bumpDir, shell: true })
  check('an existing tag is refused', /already exists/.test(refusal(() => bumpVersion(bumpDir, { part: 'patch' }))), 'no refusal')
  check('an untagged version still bumps', bumpVersion(bumpDir, { part: 'minor' }).version === '2.1.0')

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

  // Republishing a version that already exists (two releases in the same minute)
  // fails with E403; the fix is to point `dist-tag` at this exact version.
  const republishStub = join(work, 'stub-republish.mjs')
  writeFileSync(republishStub, 'console.error("npm error You cannot publish over the previously published versions: 1.2.3.")\nprocess.exit(1)\n')
  const republish = publishRelease(publishable, {
    publisher: { kind: 'npm', command: `node "${republishStub}"` },
    confirmed: true,
    repairTag: true,
    runDistTag: (command) => {
      check('the repair points dist-tag at this exact version', /dist-tag add dsh-plugin-publishable@1\.2\.3 latest/.test(command), command)
      return { status: 0, stdout: '+ latest: 1.2.3', stderr: '' }
    },
  })
  check('a republish of an existing version repairs the dist-tag instead of failing', republish.ok === true && republish.repairTag === true, JSON.stringify(republish))

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
