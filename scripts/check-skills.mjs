// Verify the bundled skills' frontmatter parses and carries the fields the
// skill provider requires. Run with the DSH runtime (it reads `yaml` from the
// installation): $env:ELECTRON_RUN_AS_NODE=1; & $env:DSH_NODE_EXECUTABLE scripts/check-skills.mjs
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const installDir = process.env.DSH_INSTALL_DIR
const require = createRequire(join(installDir, '..', '..', 'noop.js'))
const YAML = require('yaml')

const repo = fileURLToPath(new URL('..', import.meta.url))
const skillsDir = join(repo, 'skills')
const NAME = /^[a-z0-9][a-z0-9._-]*$/

const problems = []
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join(skillsDir, entry.name, 'SKILL.md')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    problems.push(`${entry.name}: no SKILL.md`)
    continue
  }
  if (!text.startsWith('---\n')) {
    problems.push(`${entry.name}: SKILL.md does not start with frontmatter`)
    continue
  }
  const end = text.indexOf('\n---', 4)
  if (end < 0) {
    problems.push(`${entry.name}: frontmatter is not closed`)
    continue
  }
  let data
  try {
    data = YAML.parse(text.slice(4, end + 1))
  } catch (error) {
    problems.push(`${entry.name}: invalid YAML frontmatter: ${error.message}`)
    continue
  }
  if (typeof data?.name !== 'string' || !NAME.test(data.name)) problems.push(`${entry.name}: invalid or missing name`)
  if (data?.name !== entry.name) problems.push(`${entry.name}: frontmatter name is ${JSON.stringify(data?.name)}, expected the directory name`)
  if (typeof data?.description !== 'string' || data.description.length < 20) problems.push(`${entry.name}: description missing or too short`)
  console.log(`${entry.name}: ${data?.description?.length ?? 0}-char description`)
}

console.log(problems.length === 0 ? 'SKILLS OK' : `PROBLEMS:\n- ${problems.join('\n- ')}`)
process.exitCode = problems.length === 0 ? 0 : 1
