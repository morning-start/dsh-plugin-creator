// End-to-end test for lib/ui.js: a real headless browser against a local page.
//
//   node scripts/try-ui.mjs
//
// Uses its own CDP port so it never touches a browser someone else is driving,
// and skips (rather than fails) when no Chrome/Edge is installed.

import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureChrome, findChrome, openPage, runAssertions, stopChrome } from '../lib/ui.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const shots = join(repo, 'tmp', 'test-ui')
const port = 9333

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const pages = {
  '/': `<!doctype html><meta charset="utf-8"><title>ui test</title>
    <div id="panel">team view</div>
    <button id="go">go</button>
    <input id="box">
    <script>
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('panel').textContent = 'clicked'
      })
    </script>`,
  '/error': `<!doctype html><meta charset="utf-8"><title>broken</title>
    <script>console.error('boom from the page')</script>
    <div id="panel">still renders</div>`,
}

const server = createServer((request, response) => {
  const body = pages[request.url === '/error' ? '/error' : '/']
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`

rmSync(shots, { recursive: true, force: true })
const browser = findChrome()
if (browser === undefined) {
  console.log('no Chrome or Edge found; skipping the UI test (set CHROME_PATH to run it)')
  server.close()
  process.exit(0)
}

let page
try {
  console.log('\nbrowser')
  const started = await ensureChrome({ port, windowSize: '1280x800' })
  check('a browser answered on the CDP port', started.started === true || started.started === false)
  const again = await ensureChrome({ port })
  check('a second call reuses it', again.started === false)

  // Two browsers must be able to coexist: a shared --user-data-dir silently stops
  // the second one from exposing its own CDP port.
  const otherPort = port + 1
  const secondBrowser = await ensureChrome({ port: otherPort })
  const secondAlive = await fetch(`http://127.0.0.1:${otherPort}/json/version`).then(response => response.status).catch(() => 0)
  check('a second port gets its own browser', secondBrowser.started === true && secondAlive === 200, `${secondBrowser.started} / ${secondAlive}`)
  check('the profiles differ', secondBrowser.profile !== again.profile, `${secondBrowser.profile} vs ${again.profile}`)
  stopChrome(otherPort)

  console.log('\npage and assertions')
  page = await openPage(`${base}/`, { port, size: '1280x800' })
  check('the page opened', typeof page.target?.id === 'string')

  const pass = await runAssertions(page, [
    { id: 'panel-present', selector: '#panel' },
    { id: 'text-present', text: 'team view' },
    { id: 'title', expression: 'document.title', equals: 'ui test' },
    { id: 'no-errors', noConsoleErrors: true },
  ])
  check('all assertions pass on a healthy page', pass.ok === true, JSON.stringify(pass.checks))

  const failing = await runAssertions(page, [
    { id: 'missing-selector', selector: '#nope' },
    { id: 'missing-text', text: 'not on the page' },
    { id: 'wrong-title', expression: 'document.title', equals: 'something else' },
  ])
  check('a missing selector fails', failing.checks.find(item => item.id === 'missing-selector')?.status === 'fail')
  check('missing text fails', failing.checks.find(item => item.id === 'missing-text')?.status === 'fail')
  check('a wrong value fails', failing.checks.find(item => item.id === 'wrong-title')?.status === 'fail')
  check('the failing run is not ok', failing.ok === false)

  console.log('\nreal input')
  await page.click('#go')
  const clicked = await page.evaluate('document.getElementById("panel").textContent')
  check('a real click ran the handler', clicked === 'clicked', String(clicked))
  await page.type('#box', 'hello there')
  const typed = await page.evaluate('document.getElementById("box").value')
  check('typing reaches the input', typed === 'hello there', String(typed))

  console.log('\nscreenshot')
  const shot = await page.screenshot(join(shots, 'home.png'))
  check('the screenshot file exists', existsSync(shot))
  const bytes = existsSync(shot) ? readFileSync(shot).subarray(0, 4) : Buffer.alloc(0)
  check('it is a PNG', bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, bytes.toString('hex'))

  console.log('\nrevisiting the same URL')
  // Navigating to the URL the target is already on does not reliably fire a load
  // event; reading too early used to return the bare origin as the title.
  await page.navigate(`${base}/`)
  const first = await page.evaluate('document.title')
  check('the first visit has the real title', first === 'ui test', String(first))
  await page.navigate(`${base}/`)
  const second = await page.evaluate('document.title')
  check('a second visit to the same URL still has it', second === 'ui test', String(second))
  const href = await page.evaluate('location.href')
  check('the document is the requested one', href.startsWith(`${base}/`), href)

  console.log('\nconsole errors')
  await page.navigate(`${base}/error`)
  const broken = await runAssertions(page, [{ id: 'no-errors', noConsoleErrors: true }])
  check('a page error is caught', broken.ok === false)
  check('the message is reported', JSON.stringify(broken.checks).includes('boom'), JSON.stringify(broken.checks))

  console.log('\nunreachable URL')
  const startedAt = Date.now()
  let message = ''
  try {
    await page.navigate('http://127.0.0.1:1/?token=secret-token')
  } catch (error) {
    message = error.message
  }
  const elapsed = Date.now() - startedAt
  check('an unreachable page fails instead of waiting', message.includes('could not be loaded'), message || '(no error)')
  check('it fails fast', elapsed < 8000, `${elapsed}ms`)
  check('the message redacts the token', !message.includes('secret-token'), message)

  await page.close()
  page = undefined
} finally {
  if (page !== undefined) await page.close().catch(() => {})
  server.close()
  const killed = stopChrome(port)
  console.log(`\nbrowser stopped (${killed.length} process(es))`)
  rmSync(shots, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nUI TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nui ok')
}
