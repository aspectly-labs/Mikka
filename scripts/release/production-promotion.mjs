// Whether a Cloudflare application deployment run promoted production. A green pipeline-production job is not
// enough: a `not-ready` outcome (nothing staged to promote) also ends green. Promotion is the step-level evidence:
// "Promote and verify the staged service manifest" and "Upload production receipts" both succeeded.
// Shared by the Desktop release (cloudflare-promoted-web.mjs) and Production smoke (production-smoke.yml).
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const PROMOTION_STEPS = ['Promote and verify the staged service manifest', 'Upload production receipts']

export const isPipelineProductionPromoted = job => job?.name === 'pipeline-production'
  && job.status === 'completed' && job.conclusion === 'success'
  && Array.isArray(job.steps)
  && PROMOTION_STEPS.every(name => job.steps.some(step => step.name === name && step.status === 'completed' && step.conclusion === 'success'))

/** The jobs of one run attempt (GitHub's `jobs` listing) promoted production. */
export const promotedProduction = jobs => Array.isArray(jobs) && jobs.filter(job => job?.name === 'pipeline-production').length === 1
  && jobs.some(isPipelineProductionPromoted)

// production-smoke.yml: reads the triggering run attempt's jobs and writes `promoted=true|false`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT, GH_TOKEN, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env
  let promoted = false
  try {
    if (!/^[1-9][0-9]{0,15}$/.test(RUN_ID ?? '') || !/^[1-9][0-9]{0,3}$/.test(RUN_ATTEMPT ?? '')) throw new Error('run')
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100`, {
      headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const listing = await response.json()
    if (listing.total_count !== listing.jobs?.length) throw new Error('incomplete listing')
    promoted = promotedProduction(listing.jobs)
  } catch (error) {
    // Unreadable evidence means no smoke for this run; the daily smoke still runs.
    console.log(`::warning::could not read deployment run ${RUN_ID} attempt ${RUN_ATTEMPT}: ${error.message}`)
  }
  appendFileSync(GITHUB_OUTPUT, `promoted=${promoted}\n`)
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `Deployment run ${RUN_ID} attempt ${RUN_ATTEMPT} promoted production: ${promoted}\n`)
  console.log(`promoted=${promoted}`)
}
