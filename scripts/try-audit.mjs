// Tests for the privacy and security groups of lib/bundle-check.js.
//
//   node scripts/try-audit.mjs
//
// Each fixture is a minimal package directory; the check runs on the real
// implementation, so a rule that stops working shows up here rather than in a
// delivery.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectBundle } from '../lib/bundle-check.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-audit')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A minimal but valid bundle, so only the audited group can fail. */
function makeBundle(name, options = {}) {
  const root = join(work, name)
  mkdirSync(join(root, 'locale'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: `dsh-plugin-${name}`,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' },
    files: ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'docs'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...(options.manifest ?? {}),
  }, null, 2))
  writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: x\n      name: dsh-plugin-x\n')
  writeFileSync(join(root, 'index.js'), options.index ?? 'export function apply(ctx) {}\nexport const inject = []\n')
  writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>')
  writeFileSync(join(root, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Audit fixture', description: 'A fixture for the privacy and security checks.' } }))
  if (options.extra !== undefined) {
    for (const [path, text] of Object.entries(options.extra)) {
      const full = join(root, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, text)
    }
  }
  return root
}

const status = (report, id) => report.checks.find(item => item.id === id)?.status
const detail = (report, id) => report.checks.find(item => item.id === id)?.message ?? ''

// Fixture strings are assembled from parts so this test file does not itself
// trip the checks it is testing (the repository is audited in the last section).
const homePath = ['C:', 'Users', 'RealPerson', 'projects'].join('\\')
const posixHome = ['', 'home', 'realperson', 'bin'].join('/')
const machinePath = ['E:', 'Workplace', 'secret-project', 'src'].join('\\')
const fakeKey = ['sk', 'x'.repeat(24)].join('-')
const keyHeader = ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ')
const personalEmail = ['someone.real', 'gmail.com'].join('@')

rmSync(work, { recursive: true, force: true })

try {
  console.log('\na clean bundle')
  const clean = await inspectBundle(makeBundle('clean'))
  check('no failures', clean.ok === true, JSON.stringify(clean.checks.filter(item => item.status === 'fail')))
  check('home paths pass', status(clean, 'privacy:home-paths') === 'pass')
  check('credentials pass', status(clean, 'privacy:credentials') === 'pass')
  check('install hooks pass', status(clean, 'security:install-hooks') === 'pass')
  check('dynamic code passes', status(clean, 'security:dynamic-code') === 'pass')
  check('a quiet plugin reports no capabilities', status(clean, 'security:capabilities') === 'pass', detail(clean, 'security:capabilities'))

  console.log('\nprivacy')
  const home = await inspectBundle(makeBundle('home', {
    extra: { 'docs/NOTES.md': `I build this in ${homePath} and deploy from ${posixHome}\n` },
  }))
  check('a real home path fails', status(home, 'privacy:home-paths') === 'fail')
  check('the account is named in the report', /RealPerson|realperson/.test(detail(home, 'privacy:home-paths')), detail(home, 'privacy:home-paths'))
  check('the package is not ok', home.ok === false)

  const placeholder = await inspectBundle(makeBundle('placeholder', {
    extra: { 'docs/NOTES.md': 'C:\\Users\\<user>\\project and /Users/someone/work and /home/you/bin\n' },
  }))
  check('placeholder accounts do not fail', status(placeholder, 'privacy:home-paths') === 'pass', detail(placeholder, 'privacy:home-paths'))

  const secret = await inspectBundle(makeBundle('secret', {
    extra: { 'lib/client.js': `const key = "${fakeKey}"\nexport default key\n` },
  }))
  check('an API key fails', status(secret, 'privacy:credentials') === 'fail')
  check('the credential kind is named', /OpenAI-style key/.test(detail(secret, 'privacy:credentials')), detail(secret, 'privacy:credentials'))

  const privateKey = await inspectBundle(makeBundle('privatekey', {
    extra: { 'docs/KEY.txt': `${keyHeader}\nMIIE...\n` },
  }))
  check('a private key fails', status(privateKey, 'privacy:credentials') === 'fail')

  const email = await inspectBundle(makeBundle('email', {
    extra: { 'docs/CONTACT.md': `mail me at ${personalEmail}\n` },
  }))
  check('a personal email warns', status(email, 'privacy:emails') === 'warn', detail(email, 'privacy:emails'))
  check('a personal email does not block', email.ok === true)
  const exampleEmail = await inspectBundle(makeBundle('example-email', {
    extra: { 'docs/CONTACT.md': 'mail me at someone@example.com\n' },
  }))
  check('an example-domain email passes', status(exampleEmail, 'privacy:emails') === 'pass')

  const machine = await inspectBundle(makeBundle('machine', {
    extra: { 'docs/NOTES.md': `checkout at ${machinePath}\n` },
  }))
  check('a machine path warns', status(machine, 'privacy:machine-paths') === 'warn', detail(machine, 'privacy:machine-paths'))

  console.log('\nsecurity')
  const hooks = await inspectBundle(makeBundle('hooks', {
    manifest: { scripts: { postinstall: 'node scripts/setup.mjs' } },
  }))
  check('a postinstall hook fails', status(hooks, 'security:install-hooks') === 'fail')
  check('the hook is named', /postinstall/.test(detail(hooks, 'security:install-hooks')), detail(hooks, 'security:install-hooks'))

  const dynamic = await inspectBundle(makeBundle('dynamic', {
    index: 'export function apply(ctx) {\n  const run = (code) => eval(code)\n  run("1")\n}\n',
  }))
  check('eval in a shipped file fails', status(dynamic, 'security:dynamic-code') === 'fail')
  check('the file is named', /index\.js/.test(detail(dynamic, 'security:dynamic-code')), detail(dynamic, 'security:dynamic-code'))

  const unshipped = await inspectBundle(makeBundle('unshipped', {
    extra: { 'scripts/dev.mjs': 'eval("1")\n' },
  }))
  check('eval outside the packaged files is ignored', status(unshipped, 'security:dynamic-code') === 'pass', detail(unshipped, 'security:dynamic-code'))

  const capable = await inspectBundle(makeBundle('capable', {
    index: 'import { spawnSync } from "node:child_process"\nimport { writeFileSync } from "node:fs"\nexport function apply() { spawnSync("ls", { shell: true }); writeFileSync("x", "y") }\n',
  }))
  check('capabilities are reported, not failed', status(capable, 'security:capabilities') === 'warn', detail(capable, 'security:capabilities'))
  check('the capability list names commands and writes', /runs commands/.test(detail(capable, 'security:capabilities')) && /writes files/.test(detail(capable, 'security:capabilities')), detail(capable, 'security:capabilities'))
  check('a capable plugin is still installable', capable.ok === true)

  const shell = await inspectBundle(makeBundle('shell', {
    index: 'import { execSync } from "node:child_process"\nexport function apply(name) { execSync(`git log ${name}`, { shell: true }) }\n',
  }))
  check('a shell command built from a value warns', status(shell, 'security:shell-interpolation') === 'warn', detail(shell, 'security:shell-interpolation'))
  check('the file is named', /index\.js/.test(detail(shell, 'security:shell-interpolation')), detail(shell, 'security:shell-interpolation'))

  console.log('\nthis repository')
  const own = await inspectBundle(repo)
  check('this repository has no privacy or security failure', own.ok === true, JSON.stringify(own.checks.filter(item => item.status === 'fail')))
  check('the privacy group actually ran', status(own, 'privacy:home-paths') === 'pass')
  check('the security group actually ran', status(own, 'security:install-hooks') === 'pass')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nAUDIT TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\naudit ok')
}
