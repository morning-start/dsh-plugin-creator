/**
 * Bundle scaffolder: render `templates/bundle/` into a new plugin package.
 *
 * Pure string work plus file writes — no model judgment, no dependencies. The
 * CLI (`scripts/new-bundle.mjs`) and the `dsh_plugin_new` tool are thin fronts
 * over this one implementation, so a bundle generated either way is identical.
 *
 * Selection, not conditionals: the template directory holds one file per
 * variant (`index.js.tpl` vs `index.min.js.tpl`, `cordis.patch.yml.tpl` vs
 * `cordis.patch.skill.yml.tpl`). The engine picks files; it never evaluates
 * template logic.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectBundle } from './bundle-check.js'

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/bundle/', import.meta.url))

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const ROW_ID = /^[a-z][a-z0-9-]*$/
const TOOL_NAME = /^[a-z][a-z0-9_]*$/
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/**
 * Create one bundle package.
 * @param {object} options - see `normalize`; only `dest`, `packageName`, `title`, and `description` are required.
 * @returns {Promise<{dest: string, files: string[], warnings: string[], checks: object}>}
 */
export async function scaffold(options) {
  const plan = normalize(options)
  await prepareDestination(plan)

  const files = new Map()
  files.set('package.json', json(manifest(plan)))
  files.set('locale/en.json', json({ meta: { title: plan.title, description: plan.description } }))
  if (plan.titleZh !== undefined || plan.descriptionZh !== undefined) {
    files.set('locale/zh.json', json({
      meta: {
        title: plan.titleZh ?? plan.title,
        description: plan.descriptionZh ?? plan.description,
      },
    }))
  }
  files.set('cordis.patch.yml', await renderTemplate(
    plan.withSkill ? 'cordis.patch.skill.yml.tpl' : 'cordis.patch.yml.tpl',
    plan,
  ))
  files.set('index.js', await renderTemplate(plan.withTool ? 'index.js.tpl' : 'index.min.js.tpl', plan))
  if (plan.withTool) files.set('tools/example.js', await renderTemplate('tools-example.js.tpl', plan))
  if (plan.withSkill) files.set(`skills/${plan.skillName}/SKILL.md`, await renderTemplate('skill.md.tpl', plan))
  files.set('README.md', await renderTemplate('README.md.tpl', plan))
  files.set('icon.svg', await readTemplate('icon.svg'))
  files.set('.gitignore', await readTemplate('gitignore.txt'))
  files.set('.gitattributes', await readTemplate('gitattributes.txt'))

  if (plan.dryRun) {
    return {
      dest: plan.dest,
      files: [...files.keys()].sort(),
      warnings: warningsFor(plan),
      checks: undefined,
    }
  }

  const written = []
  for (const [relative, content] of files) {
    const path = join(plan.dest, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    written.push(relative)
  }

  return {
    dest: plan.dest,
    files: written.sort(),
    warnings: warningsFor(plan),
    checks: await inspectBundle(plan.dest),
  }
}

function normalize(options) {
  if (options === null || typeof options !== 'object') throw new Error('scaffold: options must be an object')
  const dest = String(options.dest ?? '').trim()
  if (dest.length === 0) throw new Error('scaffold: dest is required (the directory to create)')

  const packageName = String(options.packageName ?? '').trim()
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`scaffold: invalid packageName ${JSON.stringify(packageName)}; use a lowercase npm name such as "dsh-plugin-my-thing" or "@scope/my-thing"`)
  }

  const title = singleLine(String(options.title ?? ''))
  if (title.length === 0) throw new Error('scaffold: title is required (the name users see in Plugin Manager)')

  const description = String(options.description ?? '').trim()
  if (description.length === 0) throw new Error('scaffold: description is required (what the plugin does, in the user\'s language)')

  const version = String(options.version ?? '0.1.0').trim()
  if (!VERSION.test(version)) throw new Error(`scaffold: invalid version ${JSON.stringify(version)}`)

  const rowId = String(options.rowId ?? deriveRowId(packageName)).trim()
  if (!ROW_ID.test(rowId)) {
    throw new Error(`scaffold: invalid rowId ${JSON.stringify(rowId)}; use lowercase letters, digits, and hyphens, starting with a letter`)
  }

  const withTool = options.withTool !== false
  const withSkill = options.withSkill === true

  const toolName = String(options.toolName ?? rowId.replace(/-/g, '_')).trim()
  if (withTool && !TOOL_NAME.test(toolName)) {
    throw new Error(`scaffold: invalid toolName ${JSON.stringify(toolName)}; use lowercase letters, digits, and underscores`)
  }

  const skillName = String(options.skillName ?? rowId).trim()
  if (withSkill && !ROW_ID.test(skillName)) {
    throw new Error(`scaffold: invalid skillName ${JSON.stringify(skillName)}; use lowercase letters, digits, and hyphens`)
  }

  const titleZh = optionalLine(options.titleZh)
  const descriptionZh = optionalText(options.descriptionZh)

  return {
    dest: resolve(isAbsolute(dest) ? dest : dest),
    packageName,
    title,
    description,
    version,
    rowId,
    toolName,
    skillName,
    withTool,
    withSkill,
    titleZh,
    descriptionZh,
    force: options.force === true,
    dryRun: options.dryRun === true,
    // README-only prose, composed here so the template stays free of logic.
    summary: summaryFor({ rowId, toolName, skillName, withTool, withSkill }),
    verify: verifyFor({ toolName, skillName, withTool, withSkill }),
  }
}

async function prepareDestination(plan) {
  let entries = []
  try {
    entries = await readdir(plan.dest)
  } catch {
    // Missing directory: the writes below create it.
  }
  if (entries.length > 0 && !plan.force) {
    throw new Error(`scaffold: ${plan.dest} already exists and is not empty; pass force: true to write into it anyway`)
  }
}

function manifest(plan) {
  const files = ['index.js']
  if (plan.withTool) files.push('tools')
  if (plan.withSkill) files.push('skills')
  files.push('cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md')
  return {
    name: plan.packageName,
    version: plan.version,
    private: true,
    type: 'module',
    description: singleLine(plan.description),
    exports: {
      '.': './index.js',
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
      './package.json': './package.json',
    },
    files,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
}

function summaryFor({ rowId, toolName, skillName, withTool, withSkill }) {
  const parts = []
  if (withTool) {
    parts.push(`One Host plugin row (\`${rowId}\`) that registers the \`${toolName}\` tool, visible in every preset.`)
  } else {
    parts.push(`One Host plugin row (\`${rowId}\`) that registers nothing yet.`)
  }
  if (withSkill) {
    parts.push(`A skill provider mounting \`skills/${skillName}/SKILL.md\`. The provider is scoped to this package, but the skill catalog is deployment-wide: every preset's sessions list it.`)
  }
  return parts.join(' ')
}

function verifyFor({ toolName, skillName, withTool, withSkill }) {
  const parts = []
  if (withTool) parts.push(`call \`${toolName}\` and see the message come back`)
  if (withSkill) parts.push(`the \`${skillName}\` skill appears in a session's skill catalog`)
  if (parts.length === 0) return 'the row is active and the plugin loads without a diagnostic (nothing is user-visible yet)'
  return parts.join(', and ')
}

function warningsFor(plan) {
  const warnings = []
  if (plan.description.length < 40) {
    warnings.push('description is short: Plugin Manager shows it verbatim, so say what the plugin does and how to trigger it')
  }
  if (plan.withSkill) {
    warnings.push('a skill provider mounted at Host scope lists its skill in every preset; move the row into one preset to scope it')
  }
  warnings.push('icon.svg is a placeholder: replace it, or the row shows generic artwork next to the real plugins')
  if (!plan.withTool) warnings.push('withTool is off: index.js registers nothing, so the bundle installs without a visible effect')
  return warnings
}

async function readTemplate(name) {
  return await readFile(join(TEMPLATE_DIR, name), 'utf8')
}

async function renderTemplate(name, plan) {
  const text = await readTemplate(name)
  return render(text, {
    packageName: plan.packageName,
    rowId: plan.rowId,
    title: plan.title,
    description: plan.description,
    toolName: plan.toolName,
    skillName: plan.skillName,
    version: plan.version,
    summary: plan.summary,
    verify: plan.verify,
  })
}

/** Replace `{{token}}` scalars, then fail loud on anything left over. */
function render(text, tokens) {
  let output = text
  for (const [key, value] of Object.entries(tokens)) {
    output = output.split(`{{${key}}}`).join(value)
  }
  const leftovers = [...new Set([...output.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map(match => match[1]))]
  if (leftovers.length > 0) {
    throw new Error(`scaffold: template left unresolved placeholders: ${leftovers.join(', ')} (this is a bug in the template, not in your input)`)
  }
  return output
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function deriveRowId(packageName) {
  const base = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName
  return base
    .replace(/^dsh-plugin-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function singleLine(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function optionalLine(value) {
  if (value === undefined || value === null) return undefined
  const text = singleLine(String(value))
  return text.length === 0 ? undefined : text
}

function optionalText(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text.length === 0 ? undefined : text
}
