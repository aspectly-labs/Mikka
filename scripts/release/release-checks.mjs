// Evidence checks a release must pass, listed per target in the release policy (requiredChecks) on
// top of the mandatory ones in release-policy.mjs. A new check is added by implementing it here and
// listing it in the policy; the workflows only call `run <target>`. An unknown check fails the release.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MANDATORY_CHECKS, TARGETS } from './release-policy.mjs'

const SHA = /^[0-9a-f]{40}$/
export const ROUTE_GUARD = 'apps/desktop/src/main/bundled-routes.test.ts'

function fail(code) {
  throw new Error('releaseChecks:' + code)
}

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

/** The bundled-routes allowlist guard for this exact public + hosted pairing, with the hosted checkout present. */
export function desktopRouteGuard({ root = process.cwd(), env = process.env, run = execFileSync } = {}) {
  const git = (directory, args) => run('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (!SHA.test(env.MIKKA_DESKTOP_SOURCE ?? '') || !SHA.test(env.MIKKA_UI_OVERLAY_SHA ?? '')) fail('desktopPairingRequired')
  if (!existsSync(join(root, '.hosted-ui', 'core')) || !existsSync(join(root, ROUTE_GUARD))) fail('hostedCheckoutRequired')
  if (git(root, ['rev-parse', 'HEAD']) !== env.MIKKA_DESKTOP_SOURCE) fail('desktopSourceMismatch')
  if (git(join(root, '.hosted-ui'), ['rev-parse', 'HEAD']) !== env.MIKKA_UI_OVERLAY_SHA) fail('desktopOverlayMismatch')
  let tap
  try {
    tap = run(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', ROUTE_GUARD], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: env.PATH, HOME: env.HOME, CI: '1' },
    })
  } catch (error) {
    tap = String(error?.stdout ?? '')
    routeGuardSummary(tap)
    fail('desktopRouteGuardFailed')
  }
  return { publicSource: env.MIKKA_DESKTOP_SOURCE, overlaySha: env.MIKKA_UI_OVERLAY_SHA, ...routeGuardSummary(tap) }
}

/** A successful check run with this exact name on the released public commit. */
export async function publicCheckRun(check, sourceCommit, read) {
  if (!SHA.test(sourceCommit ?? '')) fail('sourceCommitRequired')
  const listing = await read(`commits/${sourceCommit}/check-runs?check_name=${encodeURIComponent(check.checkRun)}&filter=latest&per_page=100`)
  const runs = Array.isArray(listing?.check_runs) ? listing.check_runs : []
  if (!runs.some(item => item?.name === check.checkRun && item.head_sha === sourceCommit
    && item.status === 'completed' && item.conclusion === 'success')) fail('checkRunMissing')
  return { name: check.name, checkRun: check.checkRun, sourceCommit }
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
  if (command !== 'run' || !TARGETS.includes(target)) fail('usage')
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
