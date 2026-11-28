// Evidence checks a release must pass, listed per target in the release policy (requiredChecks) on
// top of the mandatory ones in release-policy.mjs. A new check is added by implementing it here and
// listing it in the policy; the workflows only call `run <target>`. An unknown check fails the release.
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MANDATORY_CHECKS, TARGETS } from './release-policy.mjs'

const SHA = /^[0-9a-f]{40}$/
// The product checkout owns what the guard runs (package.json `test:desktop-release-guard`); this check
// only binds it to the exact pairing and requires a complete, unskipped TAP result.
export const ROUTE_GUARD_SCRIPT = 'test:desktop-release-guard'
const GITHUB_ACTIONS_APP_ID = 15368
const PUBLIC_REPOSITORY_ID = 1427517699

function fail(code, check) {
  const error = new Error('releaseChecks:' + code)
  // The policy's own check name (validated as [a-z0-9-]), so a caller can say which check to wait for.
  if (check) error.check = check
  throw error
}

// A check run that finished without succeeding: a likely real failure, unlike one still queued or running.
const FINISHED_UNSUCCESSFUL = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])

/** Node's TAP summary. A skipped route-guard test is exactly the silent hole we are closing. */
export function routeGuardSummary(tap) {
  const count = name => {
    const match = new RegExp('^# ' + name + ' (\\d+)$', 'm').exec(tap)
    return match ? Number(match[1]) : NaN
  }
  const summary = { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
    cancelled: count('cancelled'), todo: count('todo') }
  if (!(summary.tests >= 3 && summary.pass === summary.tests && summary.fail === 0 && summary.skipped === 0
    && summary.cancelled === 0 && summary.todo === 0)) fail('desktopRouteGuardFailed')
  return summary
}

/** The UI API route contract (`scripts/ui-api-routes.test.mjs`) for this exact public + hosted pairing, with the official UI required. */
export function desktopRouteGuard({ root = process.cwd(), env = process.env, run = execFileSync } = {}) {
  const git = (directory, args, code) => {
    try { return run('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
    catch { fail(code) }
  }
  if (!SHA.test(env.MIKKA_DESKTOP_SOURCE ?? '') || !SHA.test(env.MIKKA_UI_OVERLAY_SHA ?? '')) fail('desktopPairingRequired')
  if (git(root, ['rev-parse', 'HEAD'], 'desktopSourceMismatch') !== env.MIKKA_DESKTOP_SOURCE) fail('desktopSourceMismatch')
  if (git(join(root, '.hosted-ui'), ['rev-parse', 'HEAD'], 'hostedCheckoutRequired') !== env.MIKKA_UI_OVERLAY_SHA) fail('desktopOverlayMismatch')
  let tap
  try {
    tap = run('pnpm', ['run', ROUTE_GUARD_SCRIPT], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: env.PATH, HOME: env.HOME, CI: '1', MIKKA_REQUIRE_OFFICIAL_UI: '1' },
    })
  } catch (error) {
    tap = String(error?.stdout ?? '')
    routeGuardSummary(tap)
    fail('desktopRouteGuardFailed')
  }
  return { publicSource: env.MIKKA_DESKTOP_SOURCE, overlaySha: env.MIKKA_UI_OVERLAY_SHA, ...routeGuardSummary(tap) }
}

/** A successful check run with this exact name on the released public commit, created by GitHub Actions
 * (app 15368) for a job of that name that itself succeeded, in a `push` run of exactly the listed workflow
 * file on main of this repository. A check run another app posts, a `pull_request` run (even from a branch
 * or fork named `main`), a fork's run, or a check pointing at a run whose real job was skipped never counts. */
export async function publicCheckRun(check, sourceCommit, read) {
  if (!SHA.test(sourceCommit ?? '')) fail('sourceCommitRequired')
  const listing = await read(`commits/${sourceCommit}/check-runs?check_name=${encodeURIComponent(check.checkRun)}&filter=latest&per_page=100`)
  const runs = Array.isArray(listing?.check_runs) ? listing.check_runs : []
  for (const item of runs) {
    if (item?.name !== check.checkRun || item.head_sha !== sourceCommit || item.status !== 'completed'
      || item.conclusion !== 'success' || item.app?.id !== GITHUB_ACTIONS_APP_ID) continue
    const ids = /^https:\/\/github\.com\/[^/]+\/Mikka\/actions\/runs\/([1-9][0-9]{0,15})\/job\/([1-9][0-9]{0,15})$/.exec(item.details_url ?? '')
    if (!ids) continue
    const [, runId, jobId] = ids
    const [origin, job] = await Promise.all([read(`actions/runs/${runId}`), read(`actions/jobs/${jobId}`)])
    if (origin?.path === check.workflow && origin.event === 'push' && origin.head_branch === 'main'
      && origin.head_sha === sourceCommit && String(origin.id) === runId
      && origin.repository?.id === PUBLIC_REPOSITORY_ID && origin.head_repository?.id === PUBLIC_REPOSITORY_ID
      && origin.status === 'completed' && origin.conclusion === 'success'
      && String(job?.id) === jobId && String(job.run_id) === runId && job.name === check.checkRun && job.head_sha === sourceCommit
      && job.status === 'completed' && job.conclusion === 'success')
      return { name: check.name, checkRun: check.checkRun, workflow: check.workflow, sourceCommit }
  }
  // Nothing counts. Say whether GitHub Actions already finished this check unsuccessfully on the commit
  // (checkRunFailed), or it is still queued, running or absent (checkRunMissing). Either refuses.
  const finished = runs.some(item => item?.name === check.checkRun && item.head_sha === sourceCommit && item.app?.id === GITHUB_ACTIONS_APP_ID
    && item.status === 'completed' && FINISHED_UNSUCCESSFUL.has(item.conclusion))
  fail(finished ? 'checkRunFailed' : 'checkRunMissing', check.name)
}

const builtins = { 'desktop-route-guard': desktopRouteGuard }

/** Run every check for `target`. The mandatory checks hold even if the projection omitted them. */
export async function runReleaseChecks(target, { checks, sourceCommit, read, builtin = builtins, env = process.env, root } = {}) {
  if (!TARGETS.includes(target) || !Array.isArray(checks)) fail('checksRequired')
  const names = new Set(checks.map(check => check?.name))
  for (const mandatory of MANDATORY_CHECKS[target]) if (!names.has(mandatory.name)) fail('mandatoryCheckMissing')
  const results = []
  for (const check of checks) {
    if (check?.kind === 'builtin') {
      const implementation = builtin[check.name]
      if (typeof implementation !== 'function') fail('unknownCheck')
      results.push({ name: check.name, ...await implementation({ env, root }) })
    } else if (check?.kind === 'check-run' && target !== 'mobile') {
      if (typeof read !== 'function') fail('checkRunReaderRequired')
      results.push(await publicCheckRun(check, sourceCommit, read))
    } else fail('unknownCheck')
  }
  return results
}

async function publicActionsRead(path) {
  const token = process.env.GITHUB_TOKEN
  if (!token) fail('actionsTokenRequired')
  const response = await fetch('https://api.github.com/repositories/1427517699/' + path, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    cache: 'no-store', signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) { await response.body?.cancel(); fail('checkRunReadFailed') }
  return response.json()
}

async function main() {
  const [command, target] = process.argv.slice(2)
  if (command !== 'run' || !TARGETS.includes(target) || process.argv.length !== 4) fail('usage')
  let projection
  try { projection = JSON.parse(process.env.MIKKA_RELEASE_POLICY ?? '') } catch { fail('policyRequired') }
  const results = await runReleaseChecks(target, { checks: projection?.requiredChecks,
    sourceCommit: process.env.MIKKA_RELEASE_SOURCE, read: publicActionsRead })
  console.log(JSON.stringify({ target, results }))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '\n### Release evidence checks (' + target + ')\n\n' + results.map(result => '- `' + result.name + '` passed').join('\n') + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(/^releaseChecks:[A-Za-z]+$/.test(error?.message ?? '') ? error.message : 'releaseChecks:failed')
    process.exitCode = 1
  })
}
