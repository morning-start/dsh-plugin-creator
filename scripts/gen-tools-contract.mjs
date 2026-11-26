#!/usr/bin/env node
/**
 * Generate the machine-readable contract of this bundle's tools.
 *
 *   node scripts/gen-tools-contract.mjs            # print to stdout
 *   node scripts/gen-tools-contract.mjs --write    # write docs/contracts/tools.json
 *
 * The contract is what a consumer can rely on: each tool's name, description,
 * parameter schema, and required fields — as the Host would see them. It is
 * committed, so a change to a tool shows up as a diff, and `checks.json` runs
 * this generator to prove the committed copy is not stale.
 *
 * Mounting the plugin on a stub context is the same trick `try-tool.mjs` uses; it
 * is the only way to read tool definitions without a Host.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../tools/index.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const target = join(repo, 'docs', 'contracts', 'tools.json')

const registered = new Map()
const ctx = {
  effect: body => body(),
  get: () => undefined,
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    guard: () => () => {},
  },
}

apply(ctx)

const tools = [...registered.values()]
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output?.schema,
  }))

const contract = {
  generatedBy: 'scripts/gen-tools-contract.mjs',
  note: 'Generated from tools/index.js. Do not edit by hand; run the generator and commit the diff.',
  count: tools.length,
  tools,
}

const content = `${JSON.stringify(contract, null, 2)}\n`

if (process.argv.includes('--write')) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  console.log(`wrote ${target}`)
} else {
  process.stdout.write(content)
}
