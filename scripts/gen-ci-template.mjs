#!/usr/bin/env node
/**
 * Emit the bundle template from this repository's own release workflow.
 *
 * One source: `.github/workflows/release.yml` is the file people copy into other
 * plugins, and the template a generated plugin receives is the same text with the
 * `${{ … }}` escapes the template engine needs. `checks.json` runs this and
 * compares, so the two cannot drift apart.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(repo, '.github', 'workflows', 'release.yml'), 'utf8')

// The template engine treats `{{name}}` as a placeholder; `\{{` renders a literal
// `{{`, so Actions contexts survive rendering.
process.stdout.write(source.replace(/\$\{\{/g, '$\\{{'))
