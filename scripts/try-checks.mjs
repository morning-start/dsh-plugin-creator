// Tests for the project-check engine: the four rule types that carry the
// "开发规范化" load, plus the checks-file loader.
//
//   node scripts/try-checks.mjs

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChecks, runProjectChecks } from '../lib/checks.js'
import { inspectBundle } from '../lib/bundle-check.js'
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

  console.log('\ncontract drift')
  const contractDir = join(work, 'contract')
  mkdirSync(join(contractDir, 'docs'), { recursive: true })
  mkdirSync(join(contractDir, 'tools'), { recursive: true })
  writeFileSync(join(contractDir, 'tools', 'gen.mjs'), [
    "import { readFileSync } from 'node:fs'",
    "const source = JSON.parse(readFileSync(new URL('./source.json', import.meta.url), 'utf8'))",
    "process.stdout.write(`# contract\\n${source.items.map(item => `- ${item}`).join('\\n')}\\n`)",
  ].join('\n'))
  writeFileSync(join(contractDir, 'tools', 'source.json'), JSON.stringify({ items: ['alpha', 'beta'] }))
  const contractRule = [{
    id: 'contract',
    type: 'contract-drift',
    file: 'docs/contract.md',
    generator: 'node tools/gen.mjs',
  }]

  const missing = await runRules(contractDir, contractRule)
  check('a missing contract fails', missing.checks[0].status === 'fail')
  check('it says how to produce one', /does not exist/.test(missing.checks[0].message), missing.checks[0].message)

  const updated = await runRules(contractDir, contractRule, {}, { update: true })
  check('update writes the file', updated.checks[0].status === 'pass', updated.checks[0].message)
  check('the generated content is right', readFileSync(join(contractDir, 'docs', 'contract.md'), 'utf8').includes('- alpha'))

  const inSync = await runRules(contractDir, contractRule)
  check('an in-sync contract passes', inSync.checks[0].status === 'pass', inSync.checks[0].message)

  writeFileSync(join(contractDir, 'tools', 'source.json'), JSON.stringify({ items: ['alpha', 'beta', 'gamma'] }))
  const drifted = await runRules(contractDir, contractRule)
  check('a changed source is drift', drifted.checks[0].status === 'fail')
  check('the first differing line is named', /first difference at line/.test(drifted.checks[0].message), drifted.checks[0].message)

  const repaired = await runRules(contractDir, contractRule, {}, { update: true })
  check('update repairs the drift', repaired.checks[0].status === 'pass' && readFileSync(join(contractDir, 'docs', 'contract.md'), 'utf8').includes('gamma'))

  writeFileSync(join(contractDir, 'tools', 'source.json'), JSON.stringify({ items: [] }))
  writeFileSync(join(contractDir, 'docs', 'contract.md'), '# contract\nstale\n')
  const crlf = await runRules(contractDir, contractRule, {}, { update: true })
  check('line endings do not count as drift', crlf.checks[0].status === 'pass')

  writeFileSync(join(contractDir, 'tools', 'gen-bad.mjs'), 'process.exit(3)')
  const brokenGenerator = await runRules(contractDir, [{
    id: 'contract-bad',
    type: 'contract-drift',
    file: 'docs/contract.md',
    generator: 'node tools/gen-bad.mjs',
  }])
  check('a failing generator fails the rule', brokenGenerator.checks[0].status === 'fail')
  check('the exit code is reported', /failed \(3\)/.test(brokenGenerator.checks[0].message), brokenGenerator.checks[0].message)

  console.log('\nsession message identity')
  const sessionRoot = join(work, 'session')
  mkdirSync(sessionRoot, { recursive: true })
  const sessionRule = [{ id: 'session', type: 'session-message-identity', root: '.' }]

  // 反例先红：字面量直接交给会话，写的时候不报，加载时整段历史打不开。
  writeFileSync(join(sessionRoot, 'bad-literal.js'), [
    'export function remind(agent, text) {',
    "  agent.followup({ role: 'user', content: [{ type: 'text', text }] })",
    '}',
  ].join('\n'))
  const badLiteral = await runRules(sessionRoot, sessionRule)
  check('a message literal without an id fails', badLiteral.checks[0].status === 'fail', badLiteral.checks[0].message)
  check('the finding names the file and line', /bad-literal\.js:2/.test(badLiteral.checks[0].message), badLiteral.checks[0].message)
  check('the finding explains the load-time failure', /lacks an identified message/.test(badLiteral.checks[0].message), badLiteral.checks[0].message)

  // 正例：交给构造器补 id。
  writeFileSync(join(sessionRoot, 'bad-literal.js'), [
    "import { createUserMessage } from '@deepseek-ai/dsh-session'",
    'export function remind(agent, text) {',
    "  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'goal' } }))",
    '}',
  ].join('\n'))
  const goodLiteral = await runRules(sessionRoot, sessionRule)
  check('a message built by the identifying constructor passes', goodLiteral.checks[0].status === 'pass', goodLiteral.checks[0].message)

  // 反例：事件 append 的载荷不是构造器。
  writeFileSync(join(sessionRoot, 'bad-event.js'), [
    'export function record(log, payload) {',
    "  log.append('user/message', payload)",
    '}',
  ].join('\n'))
  const badEvent = await runRules(sessionRoot, sessionRule)
  check('an event appended from a bare payload fails', badEvent.checks[0].status === 'fail', badEvent.checks[0].message)

  writeFileSync(join(sessionRoot, 'bad-event.js'), [
    "import { createUserMessage } from '@deepseek-ai/dsh-session'",
    'export function record(log, text) {',
    "  log.append('user/message', createUserMessage({ content: [{ type: 'text', text }] }))",
    '}',
  ].join('\n'))
  const goodEvent = await runRules(sessionRoot, sessionRule)
  check('an event appended from the constructor passes', goodEvent.checks[0].status === 'pass', goodEvent.checks[0].message)

  // 文档里写出这个形状不该算：注释和字符串先被遮掉。
  writeFileSync(join(sessionRoot, 'doc-only.js'), [
    '/** A message looks like `{ role: \'user\', content: [] }`. */',
    "export const NOTE = \"{ role: 'user', content: [] }\"",
    'export const ok = 1',
  ].join('\n'))
  const docOnly = await runRules(sessionRoot, sessionRule)
  check('a shape spelled out in a comment or string is not a finding', docOnly.checks[0].status === 'pass', docOnly.checks[0].message)

  // 同一个判断在 bundle-check 里也要成立，否则 check 工具永远 pass。
  writeFileSync(join(sessionRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
  writeFileSync(join(sessionRoot, 'index.js'), [
    'export function remind(agent, text) {',
    "  agent.followup({ role: 'user', content: [{ type: 'text', text }] })",
    '}',
  ].join('\n'))
  const bundleBad = (await inspectBundle(sessionRoot)).checks.find(item => item.id === 'session:message-identity')
  check('the bundle check reports a bad literal too', bundleBad.status === 'warn', bundleBad.message)
  check('the bundle check names the file and line', /index\.js:2/.test(bundleBad.message), bundleBad.message)

  writeFileSync(join(sessionRoot, 'index.js'), [
    "import { createUserMessage } from '@deepseek-ai/dsh-session'",
    'export function remind(agent, text) {',
    "  agent.followup(createUserMessage({ content: [{ type: 'text', text }] }))",
    '}',
  ].join('\n'))
  const bundleGood = (await inspectBundle(sessionRoot)).checks.find(item => item.id === 'session:message-identity')
  check('the bundle check passes a built message', bundleGood.status === 'pass', bundleGood.message)

  console.log('\nundeclared inject')
  const injectRoot = join(work, 'inject')
  mkdirSync(injectRoot, { recursive: true })
  const injectRule = [{ id: 'inject', type: 'undeclared-inject', root: '.' }]
  // 反例先红：访问了 ctx.tools 却没写 inject。
  writeFileSync(join(injectRoot, 'missing.js'), [
    'export function apply(ctx) {',
    "  ctx.tools.register({ name: 'x' })",
    '}',
  ].join('\n'))
  const missingInject = await runRules(injectRoot, injectRule)
  check('accessing a service without declaring it fails', missingInject.checks[0].status === 'fail', missingInject.checks[0].message)
  check('the finding names the service', /ctx\.tools/.test(missingInject.checks[0].message), missingInject.checks[0].message)
  // 正例：声明了就过。
  writeFileSync(join(injectRoot, 'missing.js'), [
    "export const inject = ['tools']",
    'export function apply(ctx) {',
    "  ctx.tools.register({ name: 'x' })",
    '}',
  ].join('\n'))
  const declaredInject = await runRules(injectRoot, injectRule)
  check('a declared service passes', declaredInject.checks[0].status === 'pass', declaredInject.checks[0].message)
  // ctx 动词不算服务。
  writeFileSync(join(injectRoot, 'missing.js'), [
    'export function apply(ctx) {',
    "  ctx.effect(() => {})",
    "  ctx.on('agent/created', () => {})",
    '}',
  ].join('\n'))
  const verbsOnly = await runRules(injectRoot, injectRule)
  check('ctx verbs are not services', verbsOnly.checks[0].status === 'pass', verbsOnly.checks[0].message)

  console.log('\nbare-name dependency')
  const depRoot = join(work, 'deps')
  mkdirSync(depRoot, { recursive: true })
  writeFileSync(join(depRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }))
  const depRule = [{ id: 'dep', type: 'bare-name-dependency', root: '.' }]
  writeFileSync(join(depRoot, 'index.js'), "import { Context } from 'cordis'\nexport const x = Context\n")
  const bareImport = await runRules(depRoot, depRule)
  check('a bare framework import fails', bareImport.checks[0].status === 'fail', bareImport.checks[0].message)
  check('the finding names the specifier', /"cordis"/.test(bareImport.checks[0].message), bareImport.checks[0].message)
  writeFileSync(join(depRoot, 'index.js'), "import { Context } from '@deepseek-ai/cordis'\nimport leftPad from 'left-pad'\nimport { readFile } from 'node:fs/promises'\nexport const x = [Context, leftPad, readFile]\n")
  const goodImport = await runRules(depRoot, depRule)
  check('scoped, declared, and builtin imports pass', goodImport.checks[0].status === 'pass', goodImport.checks[0].message)

  console.log('\nmanifest shape')
  const manifestRoot = join(work, 'manifest')
  mkdirSync(manifestRoot, { recursive: true })
  const manifestRule = [{ id: 'manifest', type: 'manifest-shape', manifest: 'package.json' }]
  writeFileSync(join(manifestRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dsh: { bundle: { patch: ['./a.yml', './b.yml'] } } }))
  const arrayPatch = await runRules(manifestRoot, manifestRule)
  check('an array bundle.patch fails', arrayPatch.checks[0].status === 'fail', arrayPatch.checks[0].message)
  writeFileSync(join(manifestRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dsh: { client: {} } }))
  const missingClient = await runRules(manifestRoot, manifestRule)
  check('dsh.client without exports["./client"] fails', missingClient.checks[0].status === 'fail', missingClient.checks[0].message)
  writeFileSync(join(manifestRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dsh: { plugn: {} } }))
  const unknownKey = await runRules(manifestRoot, manifestRule)
  check('an unknown dsh field fails', unknownKey.checks[0].status === 'fail', unknownKey.checks[0].message)
  writeFileSync(join(manifestRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(manifestRoot, 'cordis.patch.yml'), '- insert: []\n')
  const goodManifest = await runRules(manifestRoot, manifestRule)
  check('a well formed dsh manifest passes', goodManifest.checks[0].status === 'pass', goodManifest.checks[0].message)

  console.log('\ncustom session event')
  const eventRoot = join(work, 'events')
  mkdirSync(eventRoot, { recursive: true })
  const eventRule = [{ id: 'event', type: 'custom-session-event', root: '.' }]
  writeFileSync(join(eventRoot, 'index.js'), 'export function record(session) {\n  session.append(\'my-plugin/thing\', { detail: 1 })\n}\n')
  const undeclaredEvent = await runRules(eventRoot, eventRule)
  check('appending an undeclared event type fails', undeclaredEvent.checks[0].status === 'fail', undeclaredEvent.checks[0].message)
  check('the finding names the type', /my-plugin\/thing/.test(undeclaredEvent.checks[0].message), undeclaredEvent.checks[0].message)
  writeFileSync(join(eventRoot, 'types.ts'), "declare module '@deepseek-ai/dsh-session/types' {\n  interface SessionEventMap {\n    'my-plugin/thing': { type: 'my-plugin/thing'; detail: number }\n  }\n}\n")
  const declaredEvent = await runRules(eventRoot, eventRule)
  check('a declared event type passes', declaredEvent.checks[0].status === 'pass', declaredEvent.checks[0].message)

  console.log('\nerror cards')
  const cardRoot = join(work, 'cards')
  mkdirSync(join(cardRoot, 'errors'), { recursive: true })
  const cardRule = [{ id: 'cards', type: 'errors-card' }]
  const fullCard = (overrides = []) => [
    '---',
    'id: demo-error',
    'name: 示例错误',
    'title: 一个用来测试卡片的错误',
    'cause: 写错了一处',
    'matches:',
    '  - "demo error text"',
    'location: 插件入口',
    'consequence: 插件起不来',
    'fix: 改回来',
    'severity: broken',
    'check: manifest-shape',
    '---',
    '',
    '# 正文',
    '',
    '细节在这里。',
    ...overrides,
  ].join('\n')

  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard())
  const goodCard = await runRules(cardRoot, cardRule)
  check('a complete card passes', goodCard.checks[0].status === 'pass', goodCard.checks[0].message)

  // The card is what makes an entry scannable; a card missing a field is not a card.
  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard().replace('  - "demo error text"\n', ''))
  const noMatches = await runRules(cardRoot, cardRule)
  check('a card without matches fails', noMatches.checks[0].status === 'fail', noMatches.checks[0].message)
  check('the finding names the missing field', /matches/.test(noMatches.checks[0].message), noMatches.checks[0].message)

  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard().replace('severity: broken', 'severity: who-knows'))
  const badSeverity = await runRules(cardRoot, cardRule)
  check('an unknown severity fails', badSeverity.checks[0].status === 'fail', badSeverity.checks[0].message)

  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard().replace('check: manifest-shape', 'check: no-such-rule'))
  const badCheck = await runRules(cardRoot, cardRule)
  check('a card pointing at a rule that does not exist fails', badCheck.checks[0].status === 'fail', badCheck.checks[0].message)

  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard().replace('id: demo-error', 'id: other-name'))
  const badId = await runRules(cardRoot, cardRule)
  check('an id that does not match the filename fails', badId.checks[0].status === 'fail', badId.checks[0].message)

  writeFileSync(join(cardRoot, 'errors', 'README.md'), '# 目录说明\n')
  writeFileSync(join(cardRoot, 'errors', 'demo-error.md'), fullCard())
  const withReadme = await runRules(cardRoot, cardRule)
  check('README.md is documentation, not a card', withReadme.checks[0].status === 'pass', withReadme.checks[0].message)

  console.log('\ntemplate variants')
  const tplRoot = join(work, 'templates')
  mkdirSync(join(tplRoot, 'bundle'), { recursive: true })
  const writeRecipe = (files) => writeFileSync(
    join(tplRoot, 'bundle', 'recipe.json'),
    JSON.stringify({ name: 'bundle', variables: [{ name: 'rowId' }, { name: 'title' }], files }),
  )
  const tplRule = [{ id: 'tpl', type: 'template-variants', directory: 'templates/bundle' }]
  const fullTpl = "export const name = '{{rowId}}'\nexport const inject = ['tools']\nexport function apply(ctx) {\n  ctx.effect(() => ctx.tools.register({}))\n}\n"
  const hello = "export const name = '{{rowId}}'\nexport function apply(ctx) {\n  void ctx\n}\n"

  writeRecipe([
    { from: 'index.tpl', to: 'index.js', when: 'withTool' },
    { from: 'index.min.tpl', to: 'index.js', when: '!withTool' },
  ])
  writeFileSync(join(tplRoot, 'bundle', 'index.tpl'), fullTpl)
  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), hello)
  const goodTpl = await runRules(work, tplRule)
  check('variants of one destination that agree pass', goodTpl.checks[0].status === 'pass', goodTpl.checks[0].message)

  // The hello variant drifting away from the real one is the whole point of this rule.
  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), "export const name = '{{rowId}}-hello'\nexport function apply(ctx) {\n  void ctx\n}\n")
  const driftedTpl = await runRules(work, tplRule)
  check('a variant with a different plugin name fails', driftedTpl.checks[0].status === 'fail', driftedTpl.checks[0].message)
  check('the finding names both templates', /index\.min\.tpl/.test(driftedTpl.checks[0].message), driftedTpl.checks[0].message)

  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), hello)
  writeFileSync(join(tplRoot, 'bundle', 'orphan.tpl'), hello)
  const orphan = await runRules(work, tplRule)
  check('a template the recipe never uses fails', orphan.checks[0].status === 'fail', orphan.checks[0].message)
  check('the finding names the orphan', /orphan\.tpl/.test(orphan.checks[0].message), orphan.checks[0].message)
  rmSync(join(tplRoot, 'bundle', 'orphan.tpl'))

  // Declaring a service you never use leaves the plugin waiting forever.
  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), "export const name = '{{rowId}}'\nexport const inject = ['tools']\nexport function apply(ctx) {\n  void ctx\n}\n")
  const idleInject = await runRules(work, tplRule)
  check('declaring a service the template never touches fails', idleInject.checks[0].status === 'fail', idleInject.checks[0].message)
  check('the finding explains the wait', /wait/i.test(idleInject.checks[0].message), idleInject.checks[0].message)

  // Touching a service without declaring it is refused by the context Proxy.
  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), "export const name = '{{rowId}}'\nexport function apply(ctx) {\n  ctx.tools.register({})\n}\n")
  const missingInjectTpl = await runRules(work, tplRule)
  check('touching a service without declaring it fails', missingInjectTpl.checks[0].status === 'fail', missingInject.checks[0].message)

  writeFileSync(join(tplRoot, 'bundle', 'index.min.tpl'), hello)
  writeRecipe([{ from: 'index.tpl', to: 'index.js' }])
  writeFileSync(join(tplRoot, 'bundle', 'index.tpl'), "export const name = '{{rowId}}'\nexport function apply(ctx) {\n  void ctx\n}\n")
  const undeclaredPlaceholder = await runRules(work, tplRule)
  check('an undeclared placeholder fails', undeclaredPlaceholder.checks[0].status === 'fail', undeclaredPlaceholder.checks[0].message)

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

  // The fix-error skill is only useful if the cards it indexes are complete and
  // the script it tells you to run actually ships with the package.
  const skillsDir = join(repo, 'skills')
  const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  check('the fix-error skill exists', skillNames.includes('dsh-plugin-fix-error'), skillNames.join(', '))
  const skillProblems = skillNames.filter((name) => {
    let text
    try {
      text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
    } catch {
      return true
    }
    if (!text.startsWith('---\n')) return true
    if (!new RegExp(`^name: ${name}$`, 'm').test(text)) return true
    const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? ''
    return description.replace(/^["']|["']$/g, '').length < 20
  })
  check('every bundled skill has a valid frontmatter', skillProblems.length === 0, skillProblems.join(', '))

  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  check('the card lister ships with the package', (manifest.files ?? []).includes('scripts/list-errors.mjs'), JSON.stringify(manifest.files))
  check('the cards ship with the package', (manifest.files ?? []).includes('errors'), JSON.stringify(manifest.files))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nCHECKS TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nchecks ok')
}
