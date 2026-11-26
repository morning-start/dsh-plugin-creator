/**
 * Ship: one command for the whole post-push release, in the order that survived
 * contact with the real registry.
 *
 * The order is the point. Publishing is followed immediately by the GitHub
 * Release, and the registry check runs last as advisory, because a brand-new
 * version can take longer to become visible than any reasonable wait — and a
 * slow cache must not hold up the tarball people install from. The 0.1.x releases
 * were cut by hand in the other order and the release artifact was the casualty.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGithubRelease, inspectRelease, packRelease, publishRelease, verifyPublished } from './release.js'

/**
 * @param {string} directory
 * @param {{dryRun?: boolean, confirmed?: boolean, skipNpm?: boolean, draft?: boolean,
 *   tag?: string, gitTag?: string, outDir?: string, waitSeconds?: number,
 *   readiness?: () => object, packer?: Function, publisher?: Function,
 *   releaseCreator?: Function, verifier?: Function}} options
 */
export async function shipRelease(directory, options = {}) {
  const steps = []
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const gitTag = options.gitTag ?? `v${manifest.version}`
  const dryRun = options.dryRun === true

  // 1. Readiness. A package that cannot be installed has no business being tagged.
  // inspectRelease is async (it asks the packer what ships), so this has to await
  // even when the caller injected a synchronous fixture.
  const readiness = await (options.readiness ?? (() => inspectRelease(directory)))()
  const count = status => readiness.checks.filter(check => check.status === status).length
  steps.push({
    step: 'check',
    ok: readiness.ok === true,
    detail: `${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail`,
  })
  if (readiness.ok !== true) {
    const failed = readiness.checks.filter(check => check.status === 'fail').map(check => check.id)
    return { ok: false, steps, failedAt: 'check', failedChecks: failed, version: manifest.version, gitTag }
  }

  // 2. Pack. The artifact is what everything after this point refers to.
  const packer = options.packer ?? (target => packRelease(target, options.outDir ?? join(target, 'tmp', 'release')))
  let packed
  try {
    packed = packer(directory)
  } catch (error) {
    steps.push({ step: 'pack', ok: false, detail: error.message })
    return { ok: false, steps, failedAt: 'pack', version: manifest.version, gitTag }
  }
  steps.push({ step: 'pack', ok: true, detail: packed.tarball })

  // 3. Publish, when this package goes to a registry at all.
  if (options.skipNpm === true) {
    steps.push({ step: 'publish', ok: true, detail: 'skipped: --skip-npm' })
  } else if (dryRun && options.publisher === undefined) {
    // A dry run must not need credentials: `npm publish --dry-run` still checks
    // auth, which turns "show me the plan" into "configure a token first".
    steps.push({ step: 'publish', ok: true, detail: `dry run: would publish ${manifest.name}@${manifest.version}` })
  } else {
    const publisher = options.publisher ?? publishRelease
    let published
    try {
      published = publisher(directory, {
        tag: options.tag,
        confirmed: options.confirmed,
        dryRun,
        access: options.access,
        otp: options.otp,
      })
    } catch (error) {
      steps.push({ step: 'publish', ok: false, detail: error.message })
      return { ok: false, steps, failedAt: 'publish', version: manifest.version, gitTag }
    }
    steps.push({
      step: 'publish',
      ok: published.ok === true,
      detail: published.ok === true
        ? (published.dryRun === true ? 'dry run: nothing was published' : `+ ${manifest.name}@${manifest.version}`)
        : String(published.output ?? '').split('\n').slice(-1)[0],
    })
    if (published.ok !== true) {
      return { ok: false, steps, failedAt: 'publish', version: manifest.version, gitTag, output: published.output }
    }
  }

  // 4. Release, before any registry waiting: the tarball is what people install.
  const releaseCreator = options.releaseCreator ?? createGithubRelease
  let released
  try {
    released = releaseCreator(directory, {
      tag: gitTag,
      tarball: packed.tarball,
      draft: options.draft,
      notesFile: options.notesFile,
      dryRun,
    })
  } catch (error) {
    steps.push({ step: 'release', ok: false, detail: error.message })
    return { ok: false, steps, failedAt: 'release', version: manifest.version, gitTag }
  }
  steps.push({
    step: 'release',
    ok: released.ok === true,
    detail: released.dryRun === true ? released.command : (released.url ?? String(released.output ?? '').split('\n').slice(-1)[0]),
  })
  if (released.ok !== true) {
    return { ok: false, steps, failedAt: 'release', version: manifest.version, gitTag, output: released.output }
  }

  // 5. Registry visibility, advisory. A slow cache is not a failed release.
  const verifier = options.verifier ?? verifyPublished
  const waitSeconds = options.waitSeconds ?? 300
  let visible
  try {
    visible = await verifier(manifest.name, manifest.version, {
      tag: options.tag,
      registry: options.registry,
      attempts: Math.max(1, Math.ceil(waitSeconds / 15)),
      intervalMs: 15_000,
    })
  } catch (error) {
    visible = { ok: false, findings: [{ id: 'npm:reachable', status: 'warn', message: error.message }] }
  }
  steps.push({
    step: 'verify',
    ok: visible.ok === true,
    advisory: true,
    detail: visible.ok === true
      ? 'the registry serves this version'
      : `${(visible.findings ?? []).filter(item => item.status !== 'pass').map(item => item.message).join('; ') || 'not visible yet'}`,
  })

  return {
    ok: true,
    steps,
    version: manifest.version,
    gitTag,
    tarball: packed.tarball,
    url: released.url,
    installable: visible.ok === true,
  }
}
