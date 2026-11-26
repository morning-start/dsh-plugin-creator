#!/usr/bin/env node
/**
 * CLI front over `lib/scaffold.js` — the same engine the `dsh_plugin_new` tool
 * uses. Useful when a plan already exists as JSON, or when nobody is talking to
 * an agent:
 *
 *   node scripts/new-bundle.mjs --config plan.json
 *   node scripts/new-bundle.mjs --name dsh-plugin-x --title "X" --description "..."
 *
 * Exit code 0 means the bundle was written and every structural check passed;
 * 1 means nothing was written, or a check failed.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scaffold } from '../lib/scaffold.js'

const VALUE_FLAGS = {
  'config': 'configPath',
  'dest': 'dest',
  'name': 'packageName',
  'title': 'title',
  'description': 'description',
  'title-zh': 'titleZh',
  'description-zh': 'descriptionZh',
  'row-id': 'rowId',
  'tool-name': 'toolName',
  'skill-name': 'skillName',
  'version': 'version',
  'recipe': 'recipe',
}

const BOOLEAN_FLAGS = {
  'dry-run': ['dryRun', true],
  'force': ['force', true],
  'with-skill': ['withSkill', true],
  'with-tool': ['withTool', true],
  'no-tool': ['withTool', false],
}

function printHelp() {
  console.log(`Create a DSH plugin bundle from the standard template.

  node scripts/new-bundle.mjs --config plan.json
  node scripts/new-bundle.mjs --name dsh-plugin-x --title "X" --description "..."

Fields (also accepted as keys in the --config JSON file):
  --dest <dir>            target directory (default: ./<package name>)
  --name <package>        npm package name, required
  --title <text>          Plugin Manager title, required
  --description <text>    what it does, required
  --title-zh <text>       Chinese title (adds locale/zh.json)
  --description-zh <text> Chinese description
  --row-id <id>           Loader row id (default: package name without dsh-plugin-)
  --tool-name <name>      example tool name (default: rowId with underscores)
  --skill-name <name>     skill directory name (default: rowId)
  --version <semver>      default 0.1.0
  --recipe <dir>          use another scheme (a directory holding recipe.json + templates)

Flags:
  --with-tool / --no-tool include the example tool (default: with)
  --with-skill            include SKILL.md and a skill-provider row
  --force                 write into a non-empty directory
  --dry-run               validate and list files, write nothing
  --help`)
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      printHelp()
      process.exit(0)
    }
    if (argument.startsWith('--') && BOOLEAN_FLAGS[argument.slice(2)] !== undefined) {
      const [key, value] = BOOLEAN_FLAGS[argument.slice(2)]
      options[key] = value
      continue
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument)
    if (match === null) throw new Error(`unknown argument: ${argument}`)
    const key = VALUE_FLAGS[match[1]]
    if (key === undefined) throw new Error(`unknown flag: --${match[1]}`)
    const value = match[2] ?? argv[(index += 1)]
    if (value === undefined) throw new Error(`--${match[1]} needs a value`)
    options[key] = value
  }
  return options
}

async function main() {
  const cli = parseArguments(process.argv.slice(2))
  const fromFile = cli.configPath === undefined
    ? {}
    : JSON.parse(await readFile(resolve(cli.configPath), 'utf8'))
  delete cli.configPath

  const result = await scaffold({ ...fromFile, ...cli })

  if (result.checks === undefined) {
    console.log(`Dry run — would create ${result.dest}`)
    for (const file of result.files) console.log(`  ${file}`)
  } else {
    console.log(`Created ${result.dest}`)
    for (const file of result.files) console.log(`  ${file}`)
    const { summary } = result.checks
    console.log(`\nCheck: ${summary.fail} fail, ${summary.warn} warn, ${summary.pass} pass`)
    for (const check of result.checks.checks) {
      if (check.status === 'pass') continue
      console.log(`  ${check.status.toUpperCase()} ${check.id}: ${check.message}`)
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nBefore shipping:')
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }

  if (result.checks !== undefined && !result.checks.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`new-bundle: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
