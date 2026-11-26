#!/usr/bin/env node
/**
 * CLI front over `lib/ui.js` — the same engine as the `dsh_plugin_ui` tool.
 *
 *   node scripts/ui.mjs shot <sandbox> [--path /] [--out file.png] [--size 1440x900]
 *   node scripts/ui.mjs assert <sandbox> --selector "#panel" --text "team view"
 *   node scripts/ui.mjs eval <sandbox> --expression "document.title"
 *   node scripts/ui.mjs close [--port 9222]
 *
 * A sandbox name is resolved to its recorded URL plus session token, so no token
 * has to be copied by hand. `--url <url>` drives any page instead.
 */

import { join, resolve } from 'node:path'
import { openPage, redact, runAssertions, stopChrome } from '../lib/ui.js'
import { Sandboxes } from '../lib/sandbox.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function repeated(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1])
  }
  return values
}

function targetUrl(name) {
  const explicit = flag('--url')
  if (explicit !== undefined) return explicit
  if (name === undefined) throw new Error('give a sandbox name, or --url <url>')
  const sandboxes = new Sandboxes(flag('--project') ?? process.cwd())
  const recorded = sandboxes.recordedUrl(name)
  if (recorded === undefined) throw new Error(`sandbox "${name}" has no recorded URL; start it first`)
  const base = new URL(recorded)
  const target = new URL(flag('--path') ?? '/', base.origin)
  if (!target.searchParams.has('token') && base.searchParams.has('token')) {
    target.searchParams.set('token', base.searchParams.get('token'))
  }
  return target.href
}

function assertionsFromFlags() {
  const assertions = []
  for (const selector of repeated('--selector')) assertions.push({ id: `selector ${selector}`, selector })
  for (const text of repeated('--text')) assertions.push({ id: `text ${JSON.stringify(text)}`, text })
  for (const expression of repeated('--expression')) assertions.push({ id: expression, expression })
  if (process.argv.includes('--no-console-errors')) assertions.push({ id: 'no console errors', noConsoleErrors: true })
  if (process.argv.includes('--no-network-failures')) assertions.push({ id: 'no network failures', noNetworkFailures: true })
  return assertions
}

async function main() {
  const command = process.argv[2]
  const name = process.argv[3] !== undefined && !process.argv[3].startsWith('--') ? process.argv[3] : undefined

  if (command === 'close') {
    const killed = stopChrome(flag('--port') === undefined ? undefined : Number(flag('--port')))
    console.log(killed.length === 0 ? 'No browser was listening on the CDP port.' : `Stopped ${killed.length} browser process(es).`)
    return
  }
  if (!['shot', 'assert', 'eval'].includes(command)) {
    console.log(`Look at and assert on a running page through headless Chrome.

  node scripts/ui.mjs shot <sandbox> [--path /] [--out file.png] [--size 1440x900]
  node scripts/ui.mjs assert <sandbox> --selector "#panel" --text "team view" --no-console-errors
  node scripts/ui.mjs eval <sandbox> --expression "document.title"
  node scripts/ui.mjs close [--port 9222]

  --url <url> drives any page instead of a sandbox. --click <selector> and
  --type "<selector>=<text>" act before the command runs.`)
    return
  }

  const options = {
    port: flag('--port') === undefined ? undefined : Number(flag('--port')),
    size: flag('--size'),
    settleMs: flag('--settle') === undefined ? undefined : Number(flag('--settle')),
  }
  const page = await openPage(targetUrl(name), options)
  try {
    const click = flag('--click')
    if (click !== undefined) await page.click(click)
    const type = flag('--type')
    if (type !== undefined) {
      const index = type.indexOf('=')
      if (index <= 0) throw new Error('--type wants "<selector>=<text>"')
      await page.type(type.slice(0, index), type.slice(index + 1))
    }

    if (command === 'shot') {
      const out = resolve(flag('--out') ?? join(process.cwd(), 'tmp', 'ui', `shot-${Date.now()}.png`))
      console.log(await page.screenshot(out))
      return
    }
    if (command === 'eval') {
      const expression = flag('--expression') ?? 'document.title'
      const value = await page.evaluate(expression)
      // The page may hand back its own URL, and that URL carries the session
      // token: redact before printing, like every other path in this tool.
      const text = redact(JSON.stringify(value, null, 2))
      console.log(text)
      return
    }
    const assertions = assertionsFromFlags()
    if (assertions.length === 0) throw new Error('assert needs at least one of --selector / --text / --expression / --no-console-errors')
    const result = await runAssertions(page, assertions)
    for (const check of result.checks) {
      console.log(`${check.status === 'pass' ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
    }
    console.log(`\n${result.summary.pass} pass, ${result.summary.fail} fail`)
    if (!result.ok) process.exitCode = 1
  } finally {
    await page.close().catch(() => {})
  }
}

main().then(() => {
  // The browser stays alive for the next check by design, so its socket and the
  // fetch keep-alive pool would hold this process open. The work is done.
  process.exit(process.exitCode ?? 0)
}).catch((error) => {
  console.error(`ui: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
