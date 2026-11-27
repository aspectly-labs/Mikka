// Gate for moving the npm `latest` dist-tag of the daemon (publish-daemon.yml workflow_dispatch).
// Automatic main pushes publish to `next` only. A promoter (config/release-promoters.json; the job `if`
// already refused anyone else before any secret) dispatches with `staged_run`: a successful automatic
// push run of this workflow that published the same daemon inputs to `next`. This dispatch then rebuilds
// main, re-runs the same checks and publishes with the `latest` tag.
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkedReleasePolicy, isPromoter, isPromoterLogin, readReleasePolicy, requireCommittedPromoters } from './release-policy.mjs'

const SHA = /^[0-9a-f]{40}$/
const DECIMAL = /^[1-9][0-9]{0,15}$/
export const WORKFLOW = '.github/workflows/publish-daemon.yml'
// The push `paths` filter of publish-daemon.yml: anything that goes into the npm package.
export const DAEMON_INPUTS = Object.freeze(['packages/daemon/**', 'packages/protocol/**', 'packages/config/**', 'package.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**', 'LICENSE', 'scripts/release/**', 'config/release-security.json',
  '.github/workflows/publish-daemon.yml'])

function fail(code) {
  throw new Error('daemonPromotion:' + code)
}

export const isDaemonInput = path => typeof path === 'string' && DAEMON_INPUTS.some(pattern =>
  pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern)

/** Every check before npm publication: who dispatched (against the authoritative private promoters, which
 * must equal the public gate copy), which main workflow runs, and the staged run's evidence. */
export async function verifyDaemonPromotion({ env = process.env, read, policy = () => readReleasePolicy({
  owner: env.MIKKA_OPERATIONS_OWNER, token: env.MIKKA_OPERATIONS_READ_TOKEN }) } = {}) {
  let checked
  try {
    checked = checkedReleasePolicy((await policy()).policy)
    requireCommittedPromoters(checked)
  } catch (error) {
    fail(error?.message === 'releasePolicy:promotersDiverged' ? 'promotersDiverged' : 'policyUnreadable')
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !isPromoter(checked, { id: env.GITHUB_ACTOR_ID, login: env.GITHUB_ACTOR })
    || !isPromoterLogin(checked, env.GITHUB_TRIGGERING_ACTOR)) fail('dispatchNeedsPromoter')
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== env.GITHUB_REPOSITORY + '/' + WORKFLOW + '@refs/heads/main'
    || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA || !SHA.test(env.GITHUB_SHA ?? '')) fail('workflowIdentity')
  if (!DECIMAL.test(env.STAGED_RUN ?? '')) fail('stagedRunRequired')
  const run = await read(`actions/runs/${env.STAGED_RUN}`)
  if (run?.path !== WORKFLOW || run.event !== 'push' || run.head_branch !== 'main' || run.status !== 'completed'
    || run.conclusion !== 'success' || String(run.id) !== env.STAGED_RUN || !SHA.test(run.head_sha ?? '')) fail('stagedRunUnsuccessful')
  const jobs = await read(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
  const publish = (jobs?.jobs ?? []).filter(job => job.name === 'publish')
  if (publish.length !== 1 || publish[0].conclusion !== 'success' || !publish[0].steps?.some(step =>
    step.name === 'Publish with npm trusted publishing and provenance' && step.conclusion === 'success')) fail('stagedRunNotPublished')
  // The staged build is part of main and nothing that goes into the package changed since.
  const compared = await read(`compare/${run.head_sha}...${env.GITHUB_SHA}`)
  if (!['identical', 'ahead'].includes(compared?.status) || compared.merge_base_commit?.sha !== run.head_sha) fail('stagedRunOffMain')
  if (!Array.isArray(compared.files) || compared.files.length >= 300
    || compared.files.some(file => isDaemonInput(file?.filename) || isDaemonInput(file?.previous_filename))) fail('daemonInputsChanged')
  return { stagedRun: String(run.id), stagedSource: run.head_sha, source: env.GITHUB_SHA }
}

async function publicRead(path) {
  const response = await fetch('https://api.github.com/repositories/1427517699/' + path, {
    headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    cache: 'no-store', signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) { await response.body?.cancel(); fail('githubReadFailed') }
  return response.json()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await verifyDaemonPromotion({ read: publicRead })
    console.log(JSON.stringify(result))
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `\n### Daemon promotion to latest\n\nStaged run ${result.stagedRun} (${result.stagedSource}); publishing ${result.source} to \`latest\`.\n`)
  } catch (error) {
    console.error(/^daemonPromotion:[A-Za-z]+$/.test(error?.message ?? '') ? error.message : 'daemonPromotion:failed')
    process.exitCode = 1
  }
}
