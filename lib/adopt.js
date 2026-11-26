/**
 * Adopt: bring an existing plugin project up to the standard, without rewriting it.
 *
 * The rule that keeps this honest is the split between what a machine may decide
 * and what a person must:
 *
 * - **auto** — deterministic, idempotent, never overwrites: a `repository` field
 *   derived from the git remote, the release workflow, a starter `checks.json`
 *   containing only rules the project already satisfies, `.gitignore` entries,
 *   a `market.json` draft.
 * - **decide** — a real choice the project owner has to make (which preset a tool
 *   belongs to, whether it needs a client half).
 * - **manual** — report only: patch drift after a DSH upgrade, locale keys that
 *   disagree, a missing detail page.
 *
 * Nothing here reformats code or rewrites a manifest field the user wrote.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectBundle } from './bundle-check.js'
import { readRemote } from './market.js'
import { covers, runRules } from './rules.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** Files a standard plugin project carries, and what their absence costs. */
const STANDARD = [
  { path: 'checks.json', why: 'without it the project has no self-check: nothing catches a broken doc link or a drifted locale key' },
  { path: '.github/workflows/release.yml', why: 'without it a tag cuts nothing: no npm publish, no GitHub Release, no marketplace tarball' },
  { path: 'market.json', why: 'without it the marketplace entry has to be written by hand and drifts from the package' },
]

/** A working tree with uncommitted changes cannot be rolled back. */
export function workingTreeState(directory) {
  const inside = spawnSync('git rev-parse --is-inside-work-tree', {
    cwd: directory, encoding: 'utf8', shell: true, windowsHide: true,
  })
  if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
    return { git: false, clean: false, detail: 'not a git work tree' }
  }
  const status = spawnSync('git status --porcelain', {
    cwd: directory, encoding: 'utf8', shell: true, windowsHide: true,
  })
  const dirty = (status.stdout ?? '').trim().split('\n').filter(line => line.length > 0)
  return {
    git: true,
    clean: dirty.length === 0,
    detail: dirty.length === 0 ? 'clean' : `${dirty.length} uncommitted path(s)`,
    paths: dirty.map(line => line.slice(3)),
  }
}

/**
 * Audit a directory: the bundle check plus the standard-file inventory.
 * Read-only; the caller decides what to do with it.
 */
export async function auditProject(directory) {
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) {
    // Monorepos keep the plugin in a subdirectory; say so instead of throwing ENOENT.
    throw new Error(`not a plugin package: ${directory} has no package.json (a monorepo's plugin usually lives in a subdirectory such as plugin/)`)
  }
  const bundle = await inspectBundle(directory)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const remote = readRemote(directory)

  const present = []
  const missing = []
  for (const item of STANDARD) {
    (existsSync(join(directory, item.path)) ? present : missing).push(item)
  }

  const gaps = []
  if (manifest.repository === undefined && remote !== undefined) {
    gaps.push({ id: 'manifest:repository', detail: 'package.json has no repository field; npm cannot link the package back to the repository' })
  }
  const gitignore = existsSync(join(directory, '.gitignore')) ? readFileSync(join(directory, '.gitignore'), 'utf8') : undefined
  const wanted = ['node_modules/', 'tmp/']
  const absentEntries = gitignore === undefined
    ? wanted
    : wanted.filter(entry => !gitignore.split(/\r?\n/).some(line => line.trim() === entry))
  if (absentEntries.length > 0) {
    gaps.push({ id: 'gitignore:entries', detail: `.gitignore does not ignore ${absentEntries.join(' and ')}` })
  }

  return {
    directory,
    manifest,
    remote,
    bundle,
    present,
    missing,
    gaps,
    tree: workingTreeState(directory),
  }
}

/**
 * Turn an audit into a plan. Pure: no writes, so `--dry-run` and `--json` are free.
 */
export async function planAdoption(directory, audit = undefined) {
  const state = audit ?? await auditProject(directory)
  const { manifest, remote, tree } = state
  const actions = []
  const decisions = []
  const manual = []

  // --- auto: deterministic and safe -----------------------------------------
  if (manifest.repository === undefined && remote !== undefined) {
    actions.push({
      id: 'add-repository',
      path: 'package.json',
      detail: `add repository: git+https://github.com/${remote}.git (from the git remote)`,
      payload: { repository: { type: 'git', url: `git+https://github.com/${remote}.git` } },
    })
  }

  if (!existsSync(join(directory, '.github/workflows/release.yml'))) {
    const conflict = rootFileConflict(directory, manifest, '.github/workflows/release.yml')
    if (conflict !== undefined) {
      decisions.push({ id: 'ci:files-listed', detail: conflict })
    } else {
      actions.push({
        id: 'add-ci-workflow',
        path: '.github/workflows/release.yml',
        detail: 'add the tag-driven release workflow (check, pack, publish, GitHub Release)',
        payload: { source: join(packageRoot, 'templates/bundle/github-release.yml.tpl') },
      })
    }
  }

  if (!existsSync(join(directory, 'checks.json'))) {
    const rules = await starterRules(directory, manifest)
    actions.push({
      id: 'add-checks-json',
      path: 'checks.json',
      detail: `add checks.json with ${rules.length} rule(s) this project already satisfies`,
      payload: { rules, name: manifest.name },
    })
  }

  if (state.gaps.some(gap => gap.id === 'gitignore:entries')) {
    const gitignore = existsSync(join(directory, '.gitignore')) ? readFileSync(join(directory, '.gitignore'), 'utf8') : ''
    const wanted = ['node_modules/', 'tmp/']
    const missing = wanted.filter(entry => !gitignore.split(/\r?\n/).some(line => line.trim() === entry))
    actions.push({
      id: 'append-gitignore',
      path: '.gitignore',
      detail: `append ${missing.join(' and ')} to .gitignore`,
      payload: { entries: missing, create: gitignore.length === 0 },
    })
  }

  if (!existsSync(join(directory, 'market.json')) && remote !== undefined) {
    const conflict = rootFileConflict(directory, manifest, 'market.json')
    if (conflict !== undefined) {
      decisions.push({ id: 'market:files-listed', detail: conflict })
    } else {
    actions.push({
      id: 'add-market-json',
      path: 'market.json',
      detail: 'add a market.json draft (category dev; the description is derived and needs a human read)',
      payload: { description: derivedLine(directory, manifest) },
    })
    }
  }

  // --- decide: a person has to choose ---------------------------------------
  for (const item of state.bundle.checks.filter(check => check.status === 'fail')) {
    decisions.push({ id: item.id, detail: item.message })
  }

  // --- manual: report only ---------------------------------------------------
  if (existsSync(join(directory, 'cordis.patch.yml'))) {
    manual.push({
      id: 'patch:drift',
      detail: 'cordis.patch.yml overrides a shipped preset; after a DSH upgrade the copied block may be stale. Re-sync and diff it before the next release.',
    })
  }
  if (state.missing.length > 0) {
    for (const item of state.missing.filter(entry => !actions.some(action => action.path === entry.path))) {
      manual.push({ id: `standard:${item.path}`, detail: item.why })
    }
  }

  return {
    directory,
    actions,
    decisions,
    manual,
    tree,
    blocked: tree.git === true && tree.clean === false
      ? `working tree is dirty (${tree.detail}): commit or stash first, or pass --force`
      : undefined,
  }
}

/** Candidate rules, kept only when the project already passes them. */
async function starterRules(directory, manifest) {
  const candidates = [
    { id: 'docs:links', type: 'doc-links', exclude: ['\\.dsh-memory/'] },
    { id: 'bundle:entry', type: 'file-exists', path: 'index.js' },
    {
      id: 'bundle:patch',
      type: 'json-field',
      path: 'package.json',
      field: 'dsh.bundle.patch',
      equals: './cordis.patch.yml',
    },
  ]
  if (existsSync(join(directory, 'locale'))) {
    candidates.push({ id: 'locale:parity', type: 'locale-parity' })
  }
  const { checks } = await runRules(directory, candidates)
  const passing = new Set(checks.filter(check => check.status === 'pass').map(check => check.id))
  return candidates.filter(rule => passing.has(rule.id))
}

/**
 * Would adding a file at the package root break the project's own rules?
 *
 * A project that declares `files-listed` treats `package.json#files` as an
 * allowlist: every tracked file must be covered or excluded. Writing market.json
 * into such a project turns its self-check red, which is exactly what
 * normalisation must never do.
 */
function rootFileConflict(directory, manifest, fileName) {
  const checksPath = join(directory, 'checks.json')
  if (!existsSync(checksPath)) return undefined
  let rules
  try {
    rules = JSON.parse(readFileSync(checksPath, 'utf8')).rules ?? []
  } catch {
    return undefined
  }
  for (const rule of rules) {
    if (rule.type !== 'files-listed') continue
    if ((rule.exclude ?? []).some(pattern => covers(pattern, fileName))) return undefined
    if ((manifest.files ?? []).some(pattern => covers(pattern, fileName))) return undefined
    return `checks.json's "${rule.id}" rule requires every file to be in package.json "files"; ${fileName} is not, so adding it would turn the project's own self-check red`
  }
  return undefined
}

/** A one-line draft, marked as a draft: the marketplace line is a claim. */
function derivedLine(directory, manifest) {
  const en = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'locale', 'en.json'), 'utf8'))
      return typeof parsed?.meta?.description === 'string' ? parsed.meta.description : ''
    } catch {
      return ''
    }
  })()
  const text = en.length > 0 ? en : String(manifest.description ?? '')
  const first = /^.*?[.。](?=\s|$)/.exec(text.trim())
  const line = first === null ? text.trim() : first[0]
  return line.length === 0 ? 'TODO: one sentence on what this plugin does, ending with a period.' : line
}

/**
 * Insert one top-level field into a JSON document without reformatting the rest.
 *
 * The indentation is taken from the file, so a 4-space manifest stays 4-space and
 * a single-line manifest stays single-line. The result is re-parsed by the caller
 * (and by the tests) to prove it is still valid JSON.
 */
function insertField(source, key, value) {
  const close = source.lastIndexOf('}')
  const head = source.slice(0, close)
  const tail = source.slice(close)
  const trimmed = head.replace(/[\s,]+$/, '')
  const needsComma = !trimmed.endsWith('{')
  const singleLine = !head.includes('\n')
  const indent = singleLine ? '' : ((source.match(/\n([ \t]+)"/) ?? [])[1] ?? '  ')
  const rendered = singleLine
    ? JSON.stringify(value)
    : JSON.stringify(value, null, indent.length).replace(/\n/g, `\n${indent}`)
  const separator = singleLine ? '' : `\n${indent}`
  return `${trimmed}${needsComma ? ',' : ''}${separator}"${key}": ${rendered}${singleLine ? '' : '\n'}${tail}`
}

/** Render the release workflow: the template escapes Actions contexts for the generator. */
function renderWorkflow(templatePath) {
  return readFileSync(templatePath, 'utf8').replaceAll('$\\{{', '${{')
}

/**
 * Apply the auto actions. Every write is create-only: an existing file is left
 * exactly as it was, byte for byte.
 */
export async function applyAdoption(directory, plan, options = {}) {
  const dryRun = options.dryRun === true
  if (plan.blocked !== undefined && options.force !== true) {
    throw new Error(`adopt: ${plan.blocked}`)
  }
  const applied = []
  const skipped = []

  for (const action of plan.actions) {
    const target = join(directory, action.path)
    if (action.id !== 'add-repository' && action.id !== 'append-gitignore' && existsSync(target)) {
      skipped.push({ id: action.id, path: action.path, reason: 'already exists; not overwritten' })
      continue
    }
    if (dryRun) {
      applied.push({ id: action.id, path: action.path, dryRun: true })
      continue
    }
    switch (action.id) {
      case 'add-repository': {
        const source = readFileSync(join(directory, 'package.json'), 'utf8')
        const manifest = JSON.parse(source)
        if (manifest.repository !== undefined) {
          skipped.push({ id: action.id, path: action.path, reason: 'repository is already declared' })
          break
        }
        // Insert the field instead of re-serialising: reformatting a manifest the
        // owner wrote is a change they did not ask for, and it buries the one line
        // that actually changed in a diff of the whole file.
        writeFileSync(join(directory, 'package.json'), insertField(source, 'repository', action.payload.repository), 'utf8')
        applied.push({ id: action.id, path: action.path, detail: `repository: ${action.payload.repository.url}` })
        break
      }
      case 'add-ci-workflow': {
        const body = renderWorkflow(action.payload.source)
        const dir = join(directory, '.github', 'workflows')
        execFileSync(process.execPath, ['-e', 'require("fs").mkdirSync(process.argv[1],{recursive:true})', dir], { windowsHide: true })
        writeFileSync(target, body, 'utf8')
        applied.push({ id: action.id, path: action.path, detail: 'tag-driven release workflow' })
        break
      }
      case 'add-checks-json': {
        const body = {
          version: 1,
          description: `Project checks for ${action.payload.name}. Run them with the dsh_project_check tool, or with scripts/check-project.mjs from dsh-plugin-creator.`,
          rules: action.payload.rules,
        }
        writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
        applied.push({ id: action.id, path: action.path, detail: `${action.payload.rules.length} rule(s)` })
        break
      }
      case 'append-gitignore': {
        const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
        const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
        writeFileSync(target, `${existing}${prefix}${action.payload.entries.join('\n')}\n`, 'utf8')
        applied.push({ id: action.id, path: action.path, detail: action.payload.entries.join(', ') })
        break
      }
      case 'add-market-json': {
        const body = {
          category: 'dev',
          description: { en: action.payload.description },
          _note: 'The marketplace reads description.en as a claim about this package. Read it before submitting, and add description.zh if you work in Chinese.',
        }
        writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
        applied.push({ id: action.id, path: action.path, detail: 'draft: read the description before submitting' })
        break
      }
      default:
        skipped.push({ id: action.id, path: action.path, reason: 'unknown action' })
    }
  }

  return { directory: relative(process.cwd(), directory) || '.', applied, skipped, dryRun }
}

/** audit → plan → apply, the shape both fronts call. */
export async function adopt(directory, options = {}) {
  const plan = await planAdoption(directory)
  if (options.planOnly === true) return { plan, applied: undefined }
  const result = await applyAdoption(directory, plan, options)
  return { plan, result }
}
