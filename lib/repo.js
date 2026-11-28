/**
 * Put a plugin project on GitHub: create the repository, or align the one it
 * already points at.
 *
 * Two situations, and they are not the same:
 *
 * - **create** — the directory has no `origin` yet. `git init`, declare the
 *   repository in `package.json` (so the first commit already carries it),
 *   `gh repo create ... --push`, then tag the topic.
 * - **update** — the directory already points at a GitHub repository. Do not
 *   create anything: read the visibility and change it only when it differs,
 *   add the topic (idempotent), and align `package.json`'s `repository` in its
 *   own commit. **It does not push** — publishing a commit is the user's call.
 *
 * Defaults worth knowing: a plugin repository is **public** and carries the
 * `dsh-plugin` topic, because that topic is what the plugin market discovers.
 * Defaulting to private would hide a plugin from the thing it was built for, so
 * the default is stated rather than inferred.
 *
 * Every shell call goes through one injectable runner (`options.exec`), so the
 * whole module is testable without touching GitHub or the local git config.
 *
 * Nothing here publishes to a registry; that is `lib/release.js`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRemote } from './market.js'

/** The topic the plugin market discovers repositories by. */
export const DEFAULT_TOPIC = 'dsh-plugin'

/** Visibilities `gh` accepts. */
const VISIBILITIES = ['public', 'private', 'internal']

/** The real runner: a shell command in a directory. */
function run(command, directory) {
  return spawnSync(command, {
    cwd: directory,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function git(directory, args, exec = run) {
  return exec(`git ${args}`, directory)
}

function gh(directory, args, exec = run) {
  return exec(`gh ${args}`, directory)
}

/** Whether `gh` is installed and authenticated, with a message worth reading. */
export function ghReady(exec = run) {
  const version = exec('gh --version', process.cwd())
  if (version.status !== 0) {
    return { ok: false, message: 'gh is not installed: install GitHub CLI and run `gh auth login`' }
  }
  const auth = exec('gh auth status', process.cwd())
  if (auth.status !== 0) {
    const detail = `${auth.stderr ?? auth.stdout ?? ''}`.trim().split('\n')[0]
    return { ok: false, message: `gh is not authenticated: run \`gh auth login\` (${detail})` }
  }
  return { ok: true }
}

/** The `package.json` value that matches a GitHub `owner/repo`. */
function repositoryField(remote) {
  return { type: 'git', url: `git+https://github.com/${remote}.git` }
}

/** Normalise a manifest `repository` field to a url string. */
function repositoryUrl(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.url === 'string') return value.url
  return undefined
}

/** Shell-quote a value for the `gh` calls below. */
function quote(value) {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * Read what is true right now, without changing anything.
 *
 * @param {string} directory - the project directory.
 * @param {Function} [exec] - runner; defaults to a real shell.
 */
export function inspectRepository(directory, exec = run) {
  const initialised = existsSync(join(directory, '.git'))
  const remote = initialised ? readRemote(directory) : undefined
  const hasCommits = initialised && git(directory, 'rev-parse --verify HEAD', exec).status === 0
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

  let remoteUrl
  if (initialised) {
    const shown = git(directory, 'remote get-url origin', exec)
    if (shown.status === 0) remoteUrl = `${shown.stdout ?? ''}`.trim()
  }

  let remoteState
  if (remote !== undefined) {
    const view = gh(directory, `repo view ${remote} --json visibility,description,repositoryTopics`, exec)
    if (view.status === 0) {
      try {
        const parsed = JSON.parse(view.stdout ?? '{}')
        remoteState = {
          visibility: parsed.visibility === undefined ? undefined : `${parsed.visibility}`.toLowerCase(),
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
          topics: Array.isArray(parsed.repositoryTopics)
            ? parsed.repositoryTopics.map(topic => topic?.name ?? topic).filter(name => typeof name === 'string')
            : [],
        }
      } catch {
        remoteState = undefined
      }
    }
  }

  return { initialised, remote, remoteUrl, hasCommits, remoteState, manifestRepository: manifest.repository }
}

/**
 * Work out what would change, without changing it.
 *
 * @param {string} directory
 * @param {{owner?: string, repo?: string, visibility?: string, topic?: string,
 *   description?: string, exec?: Function}} options
 */
export function planRepository(directory, options = {}) {
  const exec = options.exec ?? run
  const state = inspectRepository(directory, exec)
  const visibility = options.visibility ?? 'public'
  const topic = options.topic ?? DEFAULT_TOPIC
  if (!VISIBILITIES.includes(visibility)) {
    throw new Error(`visibility must be one of ${VISIBILITIES.join(' / ')} (got ${JSON.stringify(options.visibility)})`)
  }

  if (state.remote === undefined) {
    const problems = []
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const name = options.repo ?? (typeof manifest.name === 'string'
      ? manifest.name.replace(/^@[^/]+\//, '')
      : undefined)
    if (options.owner === undefined) problems.push('create needs an owner: pass owner (the GitHub account or organisation)')
    if (name === undefined) problems.push('create needs a repository name: pass repo, or set package.json name')
    if (state.initialised && state.hasCommits === false) {
      problems.push('the repository has no commits yet; `gh repo create --push` needs one')
    }
    const target = options.owner === undefined || name === undefined ? undefined : `${options.owner}/${name}`
    const descriptionPart = options.description === undefined ? '' : ' --description <description>'
    return {
      action: 'create',
      target,
      visibility,
      topic,
      description: options.description,
      problem: problems.length === 0 ? undefined : problems.join('; '),
      steps: target === undefined
        ? []
        : [
          state.initialised ? '# git is already initialised' : 'git init',
          `# package.json repository -> git+https://github.com/${target}.git`,
          `gh repo create ${target} --${visibility} --source . --remote origin --push`,
          `gh repo edit ${target} --add-topic ${topic}${descriptionPart}`,
        ],
      changes: { repository: true, visibility: false, topic: true, description: options.description !== undefined },
      state,
    }
  }

  const aligned = repositoryField(state.remote)
  const changes = {
    repository: repositoryUrl(state.manifestRepository) !== aligned.url,
    visibility: state.remoteState?.visibility !== undefined && state.remoteState.visibility !== visibility,
    topic: state.remoteState !== undefined && !state.remoteState.topics.includes(topic),
    description: options.description !== undefined && state.remoteState?.description !== options.description,
  }

  const steps = []
  if (changes.visibility) {
    steps.push(`gh repo edit ${state.remote} --visibility ${visibility} --accept-visibility-change-consequences`)
  }
  const editParts = []
  if (changes.topic) editParts.push(`--add-topic ${topic}`)
  if (changes.description) editParts.push('--description <description>')
  if (editParts.length > 0) steps.push(`gh repo edit ${state.remote} ${editParts.join(' ')}`)
  if (changes.repository) steps.push('# package.json repository -> the git remote, committed on its own (not pushed)')

  return {
    action: 'update',
    target: state.remote,
    visibility,
    topic,
    description: options.description,
    problem: undefined,
    steps,
    changes,
    state,
  }
}

/**
 * Create the GitHub repository for a directory that has no origin yet.
 *
 * @param {string} directory
 * @param {{owner: string, repo?: string, visibility?: string, topic?: string,
 *   description?: string, dryRun?: boolean, exec?: Function}} options
 */
export function createRepository(directory, options = {}) {
  const exec = options.exec ?? run
  const plan = planRepository(directory, options)
  if (plan.action !== 'create') {
    throw new Error(`${directory} already points at ${plan.target}; use update instead of create`)
  }
  if (plan.problem !== undefined) throw new Error(plan.problem)
  if (plan.target === undefined) throw new Error('create needs a target repository')

  const steps = []
  const applied = []

  if (!plan.state.initialised) {
    const init = options.dryRun === true ? { status: 0 } : git(directory, 'init', exec)
    steps.push({ step: 'git init', ok: init.status === 0 })
    if (init.status !== 0) return { ok: false, failedAt: 'git init', steps, applied, plan }
    applied.push('git init')
  }

  // Declare the repository before the first push, so the commit that lands on
  // GitHub already links back to itself.
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const aligned = repositoryField(plan.target)
  if (repositoryUrl(manifest.repository) !== aligned.url) {
    if (options.dryRun !== true) {
      manifest.repository = aligned
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
    applied.push('package.json repository')
    steps.push({ step: 'package.json repository', ok: true, detail: aligned.url })
  }

  const createArgs = `repo create ${plan.target} --${plan.visibility} --source . --remote origin --push`
  const descriptionPart = options.description === undefined ? '' : ` --description ${quote(options.description)}`

  if (options.dryRun === true) {
    steps.push({ step: `gh ${createArgs}`, ok: true, detail: 'dry run' })
    steps.push({ step: `gh repo edit ${plan.target} --add-topic ${plan.topic}${descriptionPart}`, ok: true, detail: 'dry run' })
    return { ok: true, dryRun: true, steps, applied, plan, url: `https://github.com/${plan.target}` }
  }

  const created = gh(directory, createArgs, exec)
  const createdOk = created.status === 0
  steps.push({ step: `gh ${createArgs}`, ok: createdOk, detail: `${created.stderr ?? ''}`.trim() })
  if (!createdOk) {
    return {
      ok: false,
      failedAt: 'gh repo create',
      steps,
      applied,
      plan,
      output: `${created.stderr ?? created.stdout ?? ''}`.trim(),
    }
  }

  const edit = gh(directory, `repo edit ${plan.target} --add-topic ${plan.topic}${descriptionPart}`, exec)
  const editOk = edit.status === 0
  steps.push({ step: `gh repo edit ${plan.target} --add-topic ${plan.topic}`, ok: editOk, detail: `${edit.stderr ?? ''}`.trim() })

  return {
    ok: editOk,
    failedAt: editOk ? undefined : 'gh repo edit',
    steps,
    applied,
    plan,
    url: `https://github.com/${plan.target}`,
  }
}

/**
 * Align an existing GitHub-backed directory: visibility, topic, description,
 * and `package.json`'s `repository` — the last one in its own commit, never
 * pushed.
 *
 * @param {string} directory
 * @param {{visibility?: string, topic?: string, description?: string, dryRun?: boolean,
 *   commit?: boolean, exec?: Function}} options
 */
export function updateRepository(directory, options = {}) {
  const exec = options.exec ?? run
  const plan = planRepository(directory, options)
  if (plan.action !== 'update') {
    throw new Error(`no GitHub origin in ${directory}; use create with an owner and repo`)
  }

  const url = `https://github.com/${plan.target}`
  if (plan.steps.length === 0) {
    return { ok: true, steps: [], applied: [], plan, unchanged: true, url }
  }
  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      steps: plan.steps.map(step => ({ step, ok: true, detail: 'dry run' })),
      applied: [],
      plan,
      url,
    }
  }

  const steps = []
  const applied = []

  if (plan.changes.visibility) {
    const edit = gh(directory, `repo edit ${plan.target} --visibility ${plan.visibility} --accept-visibility-change-consequences`, exec)
    const ok = edit.status === 0
    steps.push({ step: `visibility -> ${plan.visibility}`, ok, detail: `${edit.stderr ?? ''}`.trim() })
    if (!ok) return { ok: false, failedAt: 'visibility', steps, applied, plan, url }
    applied.push('visibility')
  }

  if (plan.changes.topic || plan.changes.description) {
    const parts = []
    if (plan.changes.topic) parts.push(`--add-topic ${plan.topic}`)
    if (plan.changes.description) parts.push(`--description ${quote(String(options.description))}`)
    const edit = gh(directory, `repo edit ${plan.target} ${parts.join(' ')}`, exec)
    const ok = edit.status === 0
    steps.push({ step: parts.join(' '), ok, detail: `${edit.stderr ?? ''}`.trim() })
    if (!ok) return { ok: false, failedAt: 'gh repo edit', steps, applied, plan, url }
    applied.push(plan.changes.topic ? 'topic' : 'description')
  }

  let committed = false
  if (plan.changes.repository) {
    const manifestPath = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.repository = repositoryField(plan.target)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    applied.push('package.json repository')
    steps.push({ step: 'package.json repository', ok: true, detail: repositoryField(plan.target).url })
    if (options.commit !== false) {
      const add = git(directory, 'add package.json', exec)
      const commit = add.status === 0
        ? git(directory, 'commit -m "chore(repo): point package.json at the GitHub remote"', exec)
        : add
      committed = commit.status === 0
      steps.push({
        step: 'commit repository',
        ok: committed,
        detail: committed
          ? 'committed locally; not pushed — pushing is your call'
          : 'wrote package.json but could not commit (dirty index or no git identity); commit it yourself',
      })
    }
  }

  return { ok: true, steps, applied, committed, plan, url }
}