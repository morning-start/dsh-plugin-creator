/**
 * Plugin-market entry: build it, validate it, and check what only GitHub knows.
 *
 * The marketplace asks for one YAML file per plugin, and every field is a claim a
 * reviewer checks against the code. So the entry is generated from the package
 * itself — URL and name from the git remote, the line from `market.json` — and
 * validated against the published rules before it is submitted:
 *
 * - the filename must be the slug the URL produces;
 * - `category` must be one of the published values;
 * - `description.en` must be one line, non-empty, and end with a period;
 * - a description containing ": " must be quoted, or YAML reads a nested key.
 *
 * Two rules cannot be checked offline — repository age and the `dsh-plugin`
 * topic — so they are reported separately, as findings, instead of being
 * pretended into the validator.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The categories the marketplace accepts today. */
export const CATEGORIES = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
  'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
]

/** What a market entry may declare, in the order the file should read. */
const FIELD_ORDER = ['url', 'name', 'category', 'description', 'icon', 'tarball']

/**
 * Build the entry for a package directory.
 *
 * `market.json` holds the claims a human wrote — the one-line description, and
 * optionally the category, icon and tarball. Everything else comes from the
 * package and its git remote, so it cannot drift from the repository it names.
 */
export function buildEntry(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const market = readMarket(directory)
  const remote = readRemote(directory)

  if (remote === undefined) {
    throw new Error('no GitHub remote: an entry has to point at the repository itself (git remote get-url origin)')
  }

  const entry = {
    url: `https://github.com/${remote}`,
    name: remote,
    category: market.category ?? 'dev',
    description: {
      en: market.description?.en ?? firstSentence(readLocale(directory, 'en')),
      ...(market.description?.zh === undefined ? {} : { zh: market.description.zh }),
    },
    ...(market.icon === undefined ? {} : { icon: market.icon }),
    ...(market.tarball === undefined ? {} : { tarball: market.tarball }),
  }
  return { entry, source: market.path }
}

function readMarket(directory) {
  const path = join(directory, 'market.json')
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return { ...parsed, path }
}

/** `owner/repo` from the git remote, normalising ssh and https forms. */
export function readRemote(directory) {
  const run = spawnSync('git remote get-url origin', {
    cwd: directory,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  })
  if (run.status !== 0) return undefined
  const url = (run.stdout ?? '').trim()
  const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(url)
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

function readLocale(directory, language) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'locale', `${language}.json`), 'utf8'))
    return typeof parsed?.meta?.description === 'string' ? parsed.meta.description : ''
  } catch {
    return ''
  }
}

/** The first sentence, because a market line is one sentence and not a paragraph. */
function firstSentence(text) {
  const match = /^.*?[.。](?=\s|$)/.exec(String(text).trim())
  return match === null ? String(text).trim() : match[0]
}

/**
 * The filename the marketplace derives from `url`.
 * A subdirectory URL (`.../tree/main/packages/x`) gets `--packages-x`.
 */
export function entrySlug(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/[^/]+\/(.+))?$/.exec(String(url))
  if (match === null) return undefined
  const [, owner, repo, subdirectory] = match
  const base = `${owner}__${repo}`
  return subdirectory === undefined ? `${base}.yml` : `${base}--${subdirectory.replace(/\//g, '-')}.yml`
}

/**
 * Validate an entry against the published rules.
 * @returns {{ok: boolean, checks: {id: string, status: string, message: string}[], filename: string|undefined}}
 */
export function validateEntry(entry) {
  const checks = []
  const add = (id, status, message) => checks.push({ id, status, message })

  const filename = entry.url === undefined ? undefined : entrySlug(entry.url)
  add('market:url', filename === undefined ? 'fail' : 'pass',
    filename === undefined
      ? `url must be https://github.com/<owner>/<repo>, got ${JSON.stringify(entry.url)}`
      : `url resolves to the entry file ${filename}`)

  add('market:name', typeof entry.name === 'string' && entry.name.length > 0 ? 'pass' : 'fail',
    typeof entry.name === 'string' && entry.name.length > 0
      ? `name: ${entry.name}`
      : 'name is the link text and must be present, as owner/repo')

  add('market:category', CATEGORIES.includes(entry.category) ? 'pass' : 'fail',
    CATEGORIES.includes(entry.category)
      ? `category: ${entry.category}`
      : `category ${JSON.stringify(entry.category)} is not one of: ${CATEGORIES.join(' ')}`)

  const en = entry.description?.en
  if (typeof en !== 'string' || en.trim().length === 0) {
    add('market:description-en', 'fail', 'description.en is required')
  } else if (en.includes('\n')) {
    add('market:description-en', 'fail', 'description.en must be a single line')
  } else if (!/[.。]$/.test(en.trim())) {
    add('market:description-en', 'fail', `description.en must end with a period: ${JSON.stringify(en.slice(-40))}`)
  } else {
    add('market:description-en', 'pass', `description.en: ${en.length} characters, one line, ends with a period`)
  }

  // The marketplace reads the file as data, not as prose: a copied example comment
  // becomes part of the entry.
  const zh = entry.description?.zh
  if (zh !== undefined && (typeof zh !== 'string' || zh.trim().length === 0)) {
    add('market:description-zh', 'fail', 'description.zh is present but empty')
  } else if (zh !== undefined) {
    add('market:description-zh', 'pass', `description.zh: ${zh.length} characters`)
  } else {
    add('market:description-zh', 'warn', 'no description.zh: a maintainer will add one, which is their work rather than a reason to bounce the entry')
  }

  if (entry.icon !== undefined) {
    const raster = /^https:\/\/(?:raw\.githubusercontent\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com|github\.com)\/.+\.(?:png|jpe?g|webp)$/i.test(entry.icon)
    add('market:icon', raster ? 'pass' : 'fail',
      raster
        ? 'icon is a GitHub-hosted raster image'
        : 'icon must be a GitHub-hosted png/jpg/jpeg/webp; vectors and third-party hosts are refused')
  }

  if (entry.tarball !== undefined) {
    const hosted = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download\/.+\.tgz$/.test(entry.tarball)
    add('market:tarball', hosted ? 'pass' : 'fail',
      hosted
        ? 'tarball is a GitHub release asset'
        : 'tarball must be an https .tgz under github.com/<owner>/<repo>/releases/download/')
    // `latest/download/` resolves the tag but takes the filename literally, so a
    // version in the asset name rots the link at the next release.
    if (hosted && entry.tarball.includes('/releases/latest/download/') && /\d+\.\d+\.\d+/.test(entry.tarball)) {
      add('market:tarball-rot', 'warn', 'a versioned filename under latest/download/ 404s at the next release; drop the version from the asset name or pin the tag')
    }
  }

  const failed = checks.filter(check => check.status === 'fail').length
  return { ok: failed === 0, checks, filename }
}

/** Render the entry as the YAML file the marketplace expects. */
export function renderEntry(entry) {
  const lines = []
  for (const field of FIELD_ORDER) {
    const value = entry[field]
    if (value === undefined) continue
    if (field === 'description') {
      lines.push('description:')
      for (const language of ['en', 'zh']) {
        if (value[language] === undefined) continue
        // Always quoted: the published example does it, and a ": " inside the
        // line is otherwise read as a nested key.
        lines.push(`  ${language}: ${quote(value[language])}`)
      }
      continue
    }
    lines.push(`${field}: ${needsQuote(value) ? quote(value) : value}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Plain scalars for the fields the published example leaves plain — `url`,
 * `name`, `category` — so the file reads like the ones already in the list.
 */
function needsQuote(value) {
  const text = String(value)
  return /^[\s'"[\]{}#&*!|>%@`-]/.test(text)
    || /:\s/.test(text)
    || /\s#/.test(text)
    || /[\s]$/.test(text)
}

/** Quote when the value would otherwise parse as something else. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The rules that only GitHub can answer: repository age and the `dsh-plugin`
 * topic. Reported as findings, never folded into the offline validator.
 */
export function checkRepository(ownerRepo) {
  const findings = []
  const view = spawnSync(`gh repo view ${ownerRepo} --json createdAt,repositoryTopics,isArchived,visibility`, {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  })
  if (view.status !== 0) {
    findings.push({ id: 'repo:reachable', status: 'warn', message: `could not read ${ownerRepo} with gh: ${(view.stderr ?? '').trim().split('\n')[0]}` })
    return findings
  }
  let data
  try {
    data = JSON.parse(view.stdout)
  } catch {
    findings.push({ id: 'repo:reachable', status: 'warn', message: 'gh returned something that is not JSON' })
    return findings
  }

  const ageDays = (Date.now() - new Date(data.createdAt).getTime()) / 86_400_000
  findings.push(ageDays >= 1
    ? { id: 'repo:age', status: 'pass', message: `repository is ${ageDays.toFixed(1)} days old` }
    : { id: 'repo:age', status: 'fail', message: `repository is ${ageDays.toFixed(1)} days old; the gate requires 1 day and re-runs itself later` })

  const topics = (data.repositoryTopics ?? []).map(topic => topic.name)
  findings.push(topics.includes('dsh-plugin')
    ? { id: 'repo:topic', status: 'pass', message: 'the dsh-plugin topic is set' }
    : { id: 'repo:topic', status: 'fail', message: `the dsh-plugin topic is not set (topics: ${topics.join(', ') || 'none'})` })

  if (data.isArchived === true) {
    findings.push({ id: 'repo:archived', status: 'fail', message: 'the repository is archived; the list removes archived entries' })
  }
  return findings
}
