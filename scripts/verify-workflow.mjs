// Parse the release workflow with the same YAML library DSH uses, so a broken
// indentation cannot reach CI unnoticed. Run via the DSH runtime:
//   $env:ELECTRON_RUN_AS_NODE=1; & $env:DSH_NODE_EXECUTABLE scripts/verify-workflow.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const installDir = process.env.DSH_INSTALL_DIR
const require = createRequire(join(installDir, '..', '..', 'noop.js'))
const YAML = require('yaml')

const problems = []
for (const relative of ['.github/workflows/release.yml', 'templates/bundle/github-release.yml.tpl']) {
  // The template carries `$\{{` escapes that only make sense to the template
  // engine; unescape them first so this compares the real text.
  const text = readFileSync(join(repo, relative), 'utf8').replace(/\$\\(\{\{)/g, '$$$1')
  let document
  try {
    document = YAML.parse(text)
  } catch (error) {
    problems.push(`${relative}: ${error.message}`)
    continue
  }
  const triggers = document?.on ?? {}
  const tags = triggers?.push?.tags ?? []
  if (!tags.includes('v*')) problems.push(`${relative}: on.push.tags does not include v*`)
  if (!document?.jobs?.release?.steps?.length) problems.push(`${relative}: no release job steps`)
  if (document?.permissions?.['id-token'] !== 'write') problems.push(`${relative}: permissions.id-token is not write`)
  if (typeof document?.concurrency?.group !== 'string') problems.push(`${relative}: no concurrency group`)
  console.log(`${relative}: ${document?.jobs?.release?.steps?.length ?? 0} steps, group ${JSON.stringify(document?.concurrency?.group)}`)
}

console.log(problems.length === 0 ? 'WORKFLOW OK' : `PROBLEMS:\n- ${problems.join('\n- ')}`)
process.exitCode = problems.length === 0 ? 0 : 1