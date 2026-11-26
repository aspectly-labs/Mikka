import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const API = 'https://api.github.com'
const REPO = 'aspectly-labs/Mikka'

export function waitedIssues(source = readFileSync('lib/feature-flags.ts', 'utf8')) {
  return [...source.matchAll(/waitsOn:\s*(\d+)/g)].map(match => Number(match[1]))
}

function blockedByPattern(issue) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])blocked\\s+by\\s+#${issue}\\b`, 'i')
}

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'mikka-waiting-issue-gate/1',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

export async function githubJson(path, { fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, method = 'GET', body } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { ...headers(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`)
  if (response.status === 204) return null
  return response.json()
}

export async function hasOpenFollowup(issue, options = {}) {
  const base = `/repos/${REPO}/issues/${issue}`
  const [subIssues, dependents] = await Promise.all([
    githubJson(`${base}/sub_issues?per_page=100`, options),
    githubJson(`${base}/dependencies/blocking?per_page=100`, options),
  ])
  if ((subIssues ?? []).some(row => row?.state === 'open')) return true
  if ((dependents ?? []).some(row => row?.state === 'open')) return true
  const query = encodeURIComponent(`repo:${REPO} is:issue is:open "blocked by #${issue}"`)
  const search = await githubJson(`/search/issues?q=${query}&per_page=100`, options)
  return (search?.items ?? []).some(row => row?.state === 'open' && blockedByPattern(issue).test(row?.body ?? ''))
}

export async function closedWaiterProblems(options = {}, issues = waitedIssues()) {
  const problems = []
  for (const issue of issues) {
    const row = await githubJson(`/repos/${REPO}/issues/${issue}`, options)
    if (!row) {
      problems.push(`#${issue}: waiter exists but the issue cannot be read`)
      continue
    }
    if (row.state === 'closed' && !(await hasOpenFollowup(issue, options))) {
      problems.push(`#${issue}: closed with no open follow-up while a feature flag waits on it`)
    }
  }
  return problems
}

export async function reopenClosedWaiterIfNeeded(issue, options = {}, issues = waitedIssues()) {
  if (!issues.includes(issue)) return { waited: false, reopened: false }
  if (await hasOpenFollowup(issue, options)) return { waited: true, reopened: false }
  const base = `/repos/${REPO}/issues/${issue}`
  await githubJson(`${base}/comments`, {
    ...options,
    method: 'POST',
    body: { body: 'This issue closed while a feature flag still waits on it and no open follow-up was found. Reopening so the follow-up is explicit.' },
  })
  await githubJson(base, { ...options, method: 'PATCH', body: { state: 'open' } })
  return { waited: true, reopened: true }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = await closedWaiterProblems()
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`waiting issue check passed (${waitedIssues().length} waiter(s))`)
}
