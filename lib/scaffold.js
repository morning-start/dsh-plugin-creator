/**
 * The `bundle` scheme: what a DSH plugin package looks like.
 *
 * Everything about *what* gets generated is data in `templates/bundle/recipe.json`
 * — variables, variants, files, and the invariants the output must satisfy. This
 * module supplies only the parts that need computation (derived names and the
 * prose in the README), then hands off to the generic engine in `lib/generate.js`
 * and adds the deep structural check in `lib/bundle-check.js`.
 *
 * That split is the whole point: adding a new scheme means adding a directory
 * with a recipe, its templates, and its rules — not another generator.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectBundle } from './bundle-check.js'
import { generate, loadRecipe } from './generate.js'

export const DEFAULT_TEMPLATE_DIR = fileURLToPath(new URL('../templates/bundle/', import.meta.url))

/** Cached so a batch of generations reads the recipe once. */
let cachedRecipe

export async function bundleRecipe(directory = DEFAULT_TEMPLATE_DIR) {
  if (cachedRecipe !== undefined && cachedRecipe.directory === resolve(directory)) return cachedRecipe
  const recipe = await loadRecipe(resolve(directory))
  if (resolve(directory) === resolve(DEFAULT_TEMPLATE_DIR)) cachedRecipe = recipe
  return recipe
}

/**
 * Create one bundle package.
 * @param {object} options - recipe variables plus `dest`, `force`, `dryRun`, `recipe`.
 * @returns {Promise<{dest: string, files: string[], warnings: string[], checks: object|undefined}>}
 */
export async function scaffold(options) {
  if (options === null || typeof options !== 'object') throw new Error('scaffold: options must be an object')
  const recipe = await bundleRecipe(options.recipe === undefined ? DEFAULT_TEMPLATE_DIR : String(options.recipe))

  const generated = await generate({
    recipe,
    dest: options.dest,
    values: options,
    derivations: DERIVATIONS,
    rules: recipe.rules ?? [],
    force: options.force === true,
    dryRun: options.dryRun === true,
  })

  if (generated.checks === undefined) {
    return { dest: generated.dest, files: generated.files, warnings: generated.warnings, checks: undefined }
  }

  const bundle = await inspectBundle(generated.dest)
  return {
    dest: generated.dest,
    files: generated.files,
    warnings: generated.warnings,
    checks: mergeChecks(bundle, generated.checks),
  }
}

/** One verdict list, two sources: the scheme's own rules and the deep bundle check. */
function mergeChecks(bundle, recipeChecks) {
  const checks = [...(bundle?.checks ?? []), ...(recipeChecks?.checks ?? [])]
  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return { ok: summary.fail === 0, target: bundle?.target, summary, checks }
}

/**
 * Computed values. A recipe names one of these with `"derive": "<name>"`; the
 * engine calls it with the values resolved so far.
 */
const DERIVATIONS = {
  rowId: values => deriveRowId(String(values.packageName ?? '')),
  toolName: values => String(values.rowId ?? '').replace(/-/g, '_'),
  skillName: values => String(values.rowId ?? ''),

  // README prose lives here rather than in the template: the template stays free
  // of conditionals, and the sentence is composed once.
  summary: (values) => {
    const parts = []
    if (values.withTool) {
      parts.push(`One Host plugin row (\`${values.rowId}\`) that registers the \`${values.toolName}\` tool, visible in every preset.`)
    } else {
      parts.push(`One Host plugin row (\`${values.rowId}\`) that registers nothing yet.`)
    }
    if (values.withSkill) {
      parts.push(`A skill provider mounting \`skills/${values.skillName}/SKILL.md\`. The provider is scoped to this package, but the skill catalog is deployment-wide: every preset's sessions list it.`)
    }
    return parts.join(' ')
  },

  verify: (values) => {
    const parts = []
    if (values.withTool) parts.push(`call \`${values.toolName}\` and see the message come back`)
    if (values.withSkill) parts.push(`the \`${values.skillName}\` skill appears in a session's skill catalog`)
    if (parts.length === 0) return 'the row is active and the plugin loads without a diagnostic (nothing is user-visible yet)'
    return parts.join(', and ')
  },

  // Pre-formatted so it renders at the right indentation inside package.json.
  manifestFiles: (values) => {
    const files = ['index.js']
    if (values.withTool) files.push('tools')
    if (values.withSkill) files.push('skills')
    files.push('cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md')
    return JSON.stringify(files, null, 2).split('\n').join('\n  ')
  },

  localeTitleZh: values => values.titleZh ?? values.title,
  localeDescriptionZh: values => values.descriptionZh ?? values.description,

  warnings: (values) => {
    const warnings = []
    if (String(values.description ?? '').length < 40) {
      warnings.push('description is short: Plugin Manager shows it verbatim, so say what the plugin does and how to trigger it')
    }
    if (values.withSkill) {
      warnings.push('a skill provider mounted at Host scope lists its skill in every preset; move the row into one preset to scope it')
    }
    warnings.push('icon.svg is a placeholder: replace it, or the row shows generic artwork next to the real plugins')
    if (!values.withTool) warnings.push('withTool is off: index.js registers nothing, so the bundle installs without a visible effect')
    return warnings
  },
}

function deriveRowId(packageName) {
  const base = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName
  return base
    .replace(/^dsh-plugin-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
