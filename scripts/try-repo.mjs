// Tests for lib/repo.js: the create / update split, and the promises that make
// it safe — update never pushes, and nothing is created when an origin exists.
//
//   node scripts/try-repo.mjs
//
// Every shell call is injected, so this touches neither GitHub nor the real git
// config; the only real git use is `git init` / `git remote add` to give
// readRemote something to read.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepository, DEFAULT_TOPIC, inspectRepository, planRepository, updateRepository } from '../lib/repo.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const work = join(repo, 'tmp', 'test-repo')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A runner that records every command and answers from a scripted map. */
function fakeExec(answers = {}) {
  const calls = []
  const exec = (command, directory) => {
    calls.push(command)
    for (const [pattern, answer] of Object.entries(answers)) {
      if (!command.includes(pattern)) continue
      if (typeof answer === 'string') return { status: 0, stdout: answer, stderr: '' }
      return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

function project(name, { git = false, remote, commits = false, version = '0.1.0' } = {}) {
  const directory = join(work, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`)
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    if (commits) {
      execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: directory })
    }
    if (remote !== undefined) {
      execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${remote}.git`], { cwd: directory })
    }
  }
  return directory
}

rmSync(work, { recursive: true, force: true })

try {
  console.log('\nthe topic is the one the market discovers')
  check('the default topic is dsh-plugin', DEFAULT_TOPIC === 'dsh-plugin', DEFAULT_TOPIC)

  console.log('\nplan: create, when the directory has no origin')
  const fresh = project('fresh-plugin')
  const createPlan = planRepository(fresh, { owner: 'morning-start', exec: fakeExec() })
  check('it plans a create', createPlan.action === 'create', createPlan.action)
  check('the target is owner/repo from package.json', createPlan.target === 'morning-start/fresh-plugin', createPlan.target)
  check('it defaults to public', createPlan.visibility === 'public', createPlan.visibility)
  check('it plans git init', createPlan.steps.includes('git init'), JSON.stringify(createPlan.steps))
  check('it creates and pushes in one gh call',
    createPlan.steps.some(step => step === 'gh repo create morning-start/fresh-plugin --public --source . --remote origin --push'),
    JSON.stringify(createPlan.steps))
  check('it adds the topic', createPlan.steps.some(step => /--add-topic dsh-plugin/.test(step)), JSON.stringify(createPlan.steps))
  check('it aligns package.json before pushing',
    createPlan.steps[1].startsWith('# package.json repository'), JSON.stringify(createPlan.steps.slice(0, 2)))

  const noOwner = planRepository(fresh, { exec: fakeExec() })
  check('create without an owner is refused', /needs an owner/.test(noOwner.problem ?? ''), noOwner.problem)

  const noCommits = project('no-commits', { git: true })
  const blocked = planRepository(noCommits, { owner: 'o', repo: 'r', exec: fakeExec({ 'rev-parse --verify HEAD': { status: 1 } }) })
  check('create without commits is refused', /no commits yet/.test(blocked.problem ?? ''), blocked.problem)

  const withCommits = project('with-commits', { git: true, commits: true })
  check('an explicit repo overrides package.json name',
    planRepository(withCommits, { owner: 'o', repo: 'chosen', exec: fakeExec() }).target === 'o/chosen')

  console.log('\ncreate: applying')
  const toCreate = project('create-me', { git: true, commits: true })
  const execCreate = fakeExec()
  const created = createRepository(toCreate, { owner: 'morning-start', exec: execCreate })
  check('it reports success', created.ok === true, JSON.stringify(created.steps))
  check('it runs gh repo create once', execCreate.calls.filter(call => call.includes('gh repo create')).length === 1, JSON.stringify(execCreate.calls))
  check('it passes --public --source . --remote origin --push',
    execCreate.calls.some(call => /--public --source \. --remote origin --push$/.test(call)), JSON.stringify(execCreate.calls))
  check('it adds the topic afterwards',
    execCreate.calls.some(call => /gh repo edit morning-start\/create-me --add-topic dsh-plugin$/.test(call)), JSON.stringify(execCreate.calls))
  const createdManifest = JSON.parse(readFileSync(join(toCreate, 'package.json'), 'utf8'))
  check('package.json now declares the repository',
    createdManifest.repository?.url === 'git+https://github.com/morning-start/create-me.git', JSON.stringify(createdManifest.repository))

  const alreadyOrigin = project('already-origin', { git: true, commits: true, remote: 'owner/there' })
  let createRefusal = ''
  try {
    createRepository(alreadyOrigin, { owner: 'o', exec: fakeExec() })
  } catch (error) {
    createRefusal = error.message
  }
  check('create refuses a directory that already has an origin', /use update/.test(createRefusal), createRefusal)

  console.log('\nplan: update, when the directory already points at a repo')
  const existing = project('existing', { git: true, commits: true, remote: 'owner/existing' })
  const state = inspectRepository(existing, fakeExec({
    'gh repo view': JSON.stringify({ visibility: 'PRIVATE', description: 'old', repositoryTopics: [{ name: 'other' }] }),
  }))
  check('it reads the remote', state.remote === 'owner/existing', state.remote)
  check('it reads the current visibility', state.remoteState?.visibility === 'private', state.remoteState?.visibility)

  const updatePlan = planRepository(existing, {
    exec: fakeExec({
      'gh repo view': JSON.stringify({ visibility: 'PRIVATE', description: 'old', repositoryTopics: [{ name: 'other' }] }),
    }),
  })
  check('it plans an update', updatePlan.action === 'update', updatePlan.action)
  check('it plans no git init and no create',
    !updatePlan.steps.some(step => /git init|repo create/.test(step)), JSON.stringify(updatePlan.steps))
  check('it flips the visibility to public',
    updatePlan.steps.some(step => /--visibility public/.test(step)), JSON.stringify(updatePlan.steps))
  check('it adds the missing topic',
    updatePlan.steps.some(step => /--add-topic dsh-plugin/.test(step)), JSON.stringify(updatePlan.steps))
  check('it aligns package.json', updatePlan.changes.repository === true)

  const clean = project('clean', { git: true, commits: true, remote: 'owner/clean' })
  writeFileSync(join(clean, 'package.json'), `${JSON.stringify({
    name: 'clean',
    version: '0.1.0',
    repository: { type: 'git', url: 'git+https://github.com/owner/clean.git' },
  }, null, 2)}\n`)
  const cleanPlan = planRepository(clean, {
    exec: fakeExec({ 'gh repo view': JSON.stringify({ visibility: 'PUBLIC', repositoryTopics: [{ name: 'dsh-plugin' }] }) }),
  })
  check('a fully aligned project plans nothing', cleanPlan.steps.length === 0, JSON.stringify(cleanPlan.steps))

  console.log('\nupdate: applying')
  const toUpdate = project('update-me', { git: true, commits: true, remote: 'owner/update-me' })
  const execUpdate = fakeExec({ 'gh repo view': JSON.stringify({ visibility: 'PRIVATE', repositoryTopics: [] }) })
  const updated = updateRepository(toUpdate, { exec: execUpdate })
  check('it reports success', updated.ok === true, JSON.stringify(updated.steps))
  check('it changes the visibility', updated.applied.includes('visibility'), JSON.stringify(updated.applied))
  check('it adds the topic', execUpdate.calls.some(call => /--add-topic dsh-plugin/.test(call)), JSON.stringify(execUpdate.calls))

  // The whole point of the update path: it prepares, it does not publish.
  check('it never pushes', !execUpdate.calls.some(call => call.includes('git push')), JSON.stringify(execUpdate.calls))
  check('it does not create a repository', !execUpdate.calls.some(call => call.includes('repo create')), JSON.stringify(execUpdate.calls))
  check('it says the commit was not pushed',
    updated.steps.some(step => /not pushed/.test(step.detail ?? '')), JSON.stringify(updated.steps))
  const updatedManifest = JSON.parse(readFileSync(join(toUpdate, 'package.json'), 'utf8'))
  check('package.json now declares the repository',
    updatedManifest.repository?.url === 'git+https://github.com/owner/update-me.git', JSON.stringify(updatedManifest.repository))

  const noCommit = project('no-commit', { git: true, commits: true, remote: 'owner/no-commit' })
  const execNoCommit = fakeExec({ 'gh repo view': JSON.stringify({ visibility: 'PUBLIC', repositoryTopics: [{ name: 'dsh-plugin' }] }) })
  const skipped = updateRepository(noCommit, { exec: execNoCommit, commit: false })
  check('commit: false leaves the change staged for the user',
    skipped.committed === false && !execNoCommit.calls.some(call => /git commit/.test(call)), JSON.stringify(execNoCommit.calls))

  const nothingToDo = project('nothing', { git: true, commits: true, remote: 'owner/nothing' })
  writeFileSync(join(nothingToDo, 'package.json'), `${JSON.stringify({
    name: 'nothing',
    version: '0.1.0',
    repository: { type: 'git', url: 'git+https://github.com/owner/nothing.git' },
  }, null, 2)}\n`)
  const execNothing = fakeExec({ 'gh repo view': JSON.stringify({ visibility: 'PUBLIC', repositoryTopics: [{ name: 'dsh-plugin' }] }) })
  const untouched = updateRepository(nothingToDo, { exec: execNothing })
  check('an aligned project runs no write command',
    untouched.unchanged === true && !execNothing.calls.some(call => call.includes('repo edit')), JSON.stringify(execNothing.calls))

  let updateRefusal = ''
  try {
    updateRepository(project('no-origin-update'), { exec: fakeExec() })
  } catch (error) {
    updateRefusal = error.message
  }
  check('update refuses a directory without an origin', /use create/.test(updateRefusal), updateRefusal)

  console.log('\ndry runs change nothing')
  const dryTarget = project('dry', { git: true, commits: true, remote: 'owner/dry' })
  const before = readFileSync(join(dryTarget, 'package.json'), 'utf8')
  const dryExec = fakeExec({ 'gh repo view': JSON.stringify({ visibility: 'PRIVATE', repositoryTopics: [] }) })
  const dry = updateRepository(dryTarget, { exec: dryExec, dryRun: true })
  check('a dry run reports the steps', dry.dryRun === true && dry.steps.length > 0, JSON.stringify(dry.steps))
  check('a dry run issues no write command', !dryExec.calls.some(call => call.includes('repo edit')), JSON.stringify(dryExec.calls))
  check('a dry run leaves package.json alone', readFileSync(join(dryTarget, 'package.json'), 'utf8') === before)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nREPO TEST FAILURES:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('\nrepo ok')
}