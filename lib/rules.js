/**
 * Declarative structure checks.
 *
 * A scheme's recipe declares the invariants its output must satisfy, and this
 * module runs them. Keeping the rules as data — rather than a hand-written
 * validator per scheme — is what lets "开发规范化" grow by adding a scheme
 * instead of adding code.
 *
 * The result shape matches `lib/bundle-check.js` on purpose: one renderer, one
 * vocabulary (pass / warn / fail), so a caller can concatenate both.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { render, test } from './generate.js'

const SKIP = new Set(['node_modules', '.git'])

/**
 * @param {string} root - the generated directory.
 * @param {object[]} rules - see the types below.
 * @param {object} [values] - recipe values, for `{{placeholder}}` in rule fields.
 * @returns {Promise<{ok: boolean, summary: {pass: number, warn: number, fail: number}, checks: object[]}>}
 */
export async function runRules(root, rules, values = {}) {
  const checks = []
  for (const rule of rules) {
    if (rule.when !== undefined && !test(rule.when, values)) continue
    const level = rule.level === 'warn' ? 'warn' : 'fail'
    let result
    try {
      result = await runRule(root, rule, values)
    } catch (error) {
      result = { passed: false, message: `${rule.type} threw: ${error.message}` }
    }
    checks.push({
      id: rule.id ?? rule.type,
      status: result.passed ? 'pass' : level,
      message: result.message,
    })
  }
  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return { ok: summary.fail === 0, summary, checks }
}

async function runRule(root, rule, values) {
  const at = (value) => render(String(value), values)
  switch (rule.type) {
    case 'file-exists': {
      const path = at(rule.path)
      return { passed: await exists(join(root, path)), message: rule.message ?? `${path} exists` }
    }
    case 'file-absent': {
      const path = at(rule.path)
      return { passed: !(await exists(join(root, path))), message: rule.message ?? `${path} is absent` }
    }
    case 'placeholder-free': {
      const files = await walk(root)
      const offenders = []
      for (const file of files) {
        const text = await readFile(join(root, file), 'utf8')
        const leftover = /\{\{([A-Za-z0-9_]+)(?:\|[a-z]+)?\}\}/.exec(text)
        if (leftover !== null) offenders.push(`${file} ({{${leftover[1]}}})`)
      }
      return {
        passed: offenders.length === 0,
        message: offenders.length === 0 ? 'no unresolved placeholders' : `unresolved placeholders in: ${offenders.join(', ')}`,
      }
    }
    case 'files-listed': {
      const manifestPath = rule.manifest ?? 'package.json'
      const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
      const listed = Array.isArray(manifest.files) ? manifest.files : []
      const excluded = Array.isArray(rule.exclude) ? rule.exclude : []
      const files = await walk(root)
      const uncovered = files.filter(file => file !== manifestPath
        && !excluded.some(pattern => covers(pattern, file))
        && !listed.some(pattern => covers(pattern, file)))
      return {
        passed: uncovered.length === 0,
        message: uncovered.length === 0
          ? `every generated file is inside ${manifestPath} "files"`
          : `not covered by ${manifestPath} "files": ${uncovered.join(', ')}`,
      }
    }
    case 'json-field': {
      const path = at(rule.path)
      let parsed
      try {
        parsed = JSON.parse(await readFile(join(root, path), 'utf8'))
      } catch (error) {
        return { passed: false, message: `${path} is not readable JSON: ${error.message}` }
      }
      const value = rule.field.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), parsed)
      const ok = rule.equals === undefined ? value !== undefined : JSON.stringify(value) === JSON.stringify(rule.equals)
      return {
        passed: ok,
        message: ok ? `${path} has ${rule.field}` : `${path} is missing ${rule.field}${rule.equals === undefined ? '' : ` (expected ${JSON.stringify(rule.equals)})`}`,
      }
    }
    case 'frontmatter-name': {
      const path = at(rule.path)
      let text
      try {
        text = await readFile(join(root, path), 'utf8')
      } catch {
        return { passed: false, message: `${path} does not exist` }
      }
      const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      if (block === null) return { passed: false, message: `${path} has no frontmatter` }
      const match = /^name:\s*(.+)$/m.exec(block[1])
      if (match === null) return { passed: false, message: `${path} frontmatter has no name` }
      const actual = match[1].trim().replace(/^["']|["']$/g, '')
      const expected = at(rule.equals ?? '')
      return {
        passed: expected === '' || actual === expected,
        message: expected === '' ? `${path} frontmatter name is ${actual}` : `${path} frontmatter name is ${actual} (expected ${expected})`,
      }
    }
    default:
      throw new Error(`unknown rule type "${rule.type}"`)
  }
}

/** Every file under `root`, as posix-style relative paths, sorted. */
export async function walk(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await walk(root, relative))
    else files.push(relative)
  }
  return files.sort()
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    try {
      await readdir(path)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Does a `package.json` `files` entry cover a generated path?
 *
 * Entries are the npm forms: an exact file, a directory (covers everything under
 * it), or a single-level glob such as `locale/*.json`.
 */
export function covers(pattern, path) {
  if (pattern === path) return true
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  if (!pattern.includes('*')) return path.startsWith(`${pattern}/`)
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`).test(path)
}
