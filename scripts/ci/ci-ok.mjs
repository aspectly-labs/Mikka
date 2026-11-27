// The single aggregate verdict of CI (.github/workflows/ui-policy.yml, job `ci-ok`, check name `CI OK`).
// The job needs every other CI job. For each one the workflow states whether it was expected to run on this event
// and selection (`CI_OK_EXPECT_<JOB>`, the job's own `if:`). An expected job must succeed; an unexpected one must have
// been skipped. Failure and cancellation always fail, and a skip is accepted only where the selector or the event
// left the job out. Plain Node, no dependencies: it runs before any install.
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const EXPECT_PREFIX = 'CI_OK_EXPECT_'
export const expectationKey = job => EXPECT_PREFIX + job.toUpperCase().replaceAll('-', '_')

/** Every problem with these needs (`toJSON(needs)`) against the expectations in `env`; empty means CI is OK. */
export function problems(needs, env) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs) || !Object.keys(needs).length) return ['needs: missing or empty']
  const found = []
  const keys = new Set()
  for (const [job, value] of Object.entries(needs)) {
    const key = expectationKey(job)
    keys.add(key)
    const expected = env[key]
    const result = value?.result
    if (expected !== 'true' && expected !== 'false') { found.push(`${job}: no expectation (${key}=${expected ?? 'unset'})`); continue }
    if (expected === 'true' && result !== 'success') found.push(`${job}: ${result ?? 'no result'} (selected, must succeed)`)
    if (expected === 'false' && result !== 'skipped') found.push(`${job}: ${result ?? 'no result'} (not selected, must be skipped)`)
  }
  // An expectation without a need is a job the aggregate forgot to wait for.
  for (const key of Object.keys(env).filter(key => key.startsWith(EXPECT_PREFIX)).sort())
    if (!keys.has(key)) found.push(`${key}: expectation for a job the aggregate does not need`)
  return found
}

export function report(needs, env) {
  const found = problems(needs, env)
  const rows = Object.entries(needs ?? {}).map(([job, value]) => `| ${job} | ${env[expectationKey(job)] === 'true' ? 'yes' : env[expectationKey(job)] === 'false' ? 'no' : '?'} | ${value?.result ?? '?'} |`)
  const summary = ['## CI OK', '', '| Job | Selected | Result |', '| --- | --- | --- |', ...rows, '',
    found.length ? `**Failed:**\n\n${found.map(line => `- ${line}`).join('\n')}` : 'Every selected job succeeded; every other job was skipped by selection.', ''].join('\n')
  return { ok: found.length === 0, problems: found, summary }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let needs
  try { needs = JSON.parse(process.env.CI_OK_NEEDS ?? '') } catch { needs = null }
  const { ok, problems: found, summary } = report(needs, process.env)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  for (const line of found) console.log(`::error::${line}`)
  console.log(ok ? 'CI OK' : `CI failed: ${found.length} problem(s)`)
  process.exitCode = ok ? 0 : 1
}
