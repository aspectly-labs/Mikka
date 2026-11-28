// Stable, URL-safe identity for one production deployment across the web, API and worker images.
// A rerun gets a distinct identifier even when the source revision is unchanged.

import { pathToFileURL } from 'node:url'
import { envValue, runtimeEnv } from './env/runtime.mjs'

const MAX_LENGTH = 32
const ALLOWED = /^[A-Za-z0-9_-]+$/

export function isValidDeploymentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_LENGTH && ALLOWED.test(id)
}

/** `<sha prefix>-<run id>-<run attempt>`; the sha prefix shrinks before the run fields do. */
export function buildDeploymentId({ sha, runId, runAttempt }) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha ?? '')) throw new Error(`deployment id: expected a commit sha, got ${JSON.stringify(sha)}`)
  if (!/^\d+$/.test(String(runId ?? ''))) throw new Error(`deployment id: expected a numeric run id, got ${JSON.stringify(runId)}`)
  if (!/^\d+$/.test(String(runAttempt ?? ''))) throw new Error(`deployment id: expected a numeric run attempt, got ${JSON.stringify(runAttempt)}`)
  const suffix = `-${runId}-${runAttempt}`
  const shaLength = Math.min(12, MAX_LENGTH - suffix.length)
  if (shaLength < 7) throw new Error(`deployment id: run fields ${suffix} leave no room for the commit`)
  const id = `${sha.slice(0, shaLength).toLowerCase()}${suffix}`
  if (!isValidDeploymentId(id)) throw new Error(`deployment id: built an invalid id ${JSON.stringify(id)}`)
  return id
}

const RELEASE_ORDER = /^[0-9a-f]{7,12}-(\d{1,20})-(\d{1,10})$/

/** True when release `a` was built after release `b`. buildDeploymentId ids order by their
 * GitHub run id, then run attempt; the commit prefix carries no order. Undefined when either
 * id is not such a release id, so callers can treat an unknown order as "not newer". */
export function releaseBuiltAfter(a, b) {
  const left = RELEASE_ORDER.exec(a ?? ''), right = RELEASE_ORDER.exec(b ?? '')
  if (!left || !right) return undefined
  const [runA, attemptA] = [BigInt(left[1]), BigInt(left[2])], [runB, attemptB] = [BigInt(right[1]), BigInt(right[2])]
  return runA === runB ? attemptA > attemptB : runA > runB
}

/** The id selected by the release workflow, or undefined outside a release build. */
export function configuredDeploymentId(env = runtimeEnv()) {
  const id = env.MIKKA_DEPLOYMENT_ID
  if (!id) return undefined
  if (!isValidDeploymentId(id)) throw new Error(`MIKKA_DEPLOYMENT_ID ${JSON.stringify(id)} is not a valid release id`)
  return id
}

// `node lib/deployment-id.mjs` prints the id for this run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${buildDeploymentId({ sha: envValue('GITHUB_SHA'), runId: envValue('GITHUB_RUN_ID'), runAttempt: envValue('GITHUB_RUN_ATTEMPT') })}\n`)
}
