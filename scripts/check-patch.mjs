// Structural check of the bundle patch: parse it with the same YAML library DSH
// uses, then compare our Creator-mode override with the shipped declaration.
// Run with plain node; `yaml` resolves from the DSH installation.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const installDir = process.env.DSH_INSTALL_DIR
const packagesDir = join(installDir, '..')
const modulesDir = join(packagesDir, '..')
const require = createRequire(join(modulesDir, 'noop.js'))
const YAML = require('yaml')

const repo = process.argv[2]
const shippedPath = join(packagesDir, 'dsh-web-app/presets/cordis.patch.yml')

const jsTag = { tag: '!!js', resolve: (value) => ({ __js: value }) }
const options = { customTags: [jsTag] }

const shipped = YAML.parse(readFileSync(shippedPath, 'utf8'), options)
const ours = YAML.parse(readFileSync(join(repo, 'cordis.patch.yml'), 'utf8'), options)

const shippedRow = shipped[0].insert.find((row) => row.id === 'preset-cordis')
const oursRow = ours.find((row) => row.id === 'preset-cordis')
const inserted = ours.find((row) => row.insert)?.insert ?? []

const problems = []
if (shippedRow === undefined) problems.push('shipped patch has no preset-cordis row')
if (oursRow === undefined) problems.push('our patch has no preset-cordis override')
if (!inserted.some((row) => row.id === 'powerful-host')) problems.push('no powerful-host insert row')

if (shippedRow && oursRow) {
  if (oursRow.config.id !== shippedRow.config.id) problems.push('preset id differs')
  if (oursRow.config.order !== shippedRow.config.order) problems.push('preset order differs')
  const shippedIds = shippedRow.config.plugins.map((row) => row.id)
  const ourIds = oursRow.config.plugins.map((row) => row.id)
  const added = ourIds.filter((id) => !shippedIds.includes(id))
  const lost = shippedIds.filter((id) => !ourIds.includes(id))
  if (lost.length > 0) problems.push(`dropped shipped rows: ${lost.join(', ')}`)
  if (added.join(',') !== 'powerful-tools,powerful-skills') {
    problems.push(`unexpected added rows: ${added.join(', ') || '(none)'}`)
  }
  // Order of the shipped rows must be preserved.
  const keptOrder = ourIds.filter((id) => shippedIds.includes(id))
  if (keptOrder.join(',') !== shippedIds.join(',')) problems.push('shipped row order changed')
  console.log(`shipped plugins: ${shippedIds.length}`)
  console.log(`our plugins:     ${ourIds.length}`)
  console.log(`added:           ${added.join(', ')}`)

  // The deep plan-mode section must survive byte-for-byte.
  const shippedSection = shippedRow.config.plugins.find((row) => row.id === 'planning')
    ?.config?.[0]?.config?.section
  const ourSection = oursRow.config.plugins.find((row) => row.id === 'planning')
    ?.config?.[0]?.config?.section
  if (shippedSection !== ourSection) problems.push('plan-mode section text differs from the shipped one')
  else console.log('plan-mode section: identical')
}

console.log(problems.length === 0 ? 'PATCH OK' : `PROBLEMS:\n- ${problems.join('\n- ')}`)
process.exitCode = problems.length === 0 ? 0 : 1
