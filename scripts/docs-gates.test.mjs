import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderGenerated } from './docs-generated.mjs'
import { validatePendingRegister, pendingLintProblems } from './pending-decisions.mjs'
import { closedWaiterProblems, reopenClosedWaiterIfNeeded, waitedIssues } from './check-waiting-issues.mjs'

function githubMock(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    const key = parsed.pathname + parsed.search
    calls.push({ key, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const value = routes[key] ?? (parsed.pathname === '/search/issues' ? { items: [] } : null)
    return { ok: value !== null, status: value === null ? 404 : 200, json: async () => value }
  }
  return { fetchImpl, calls }
}

test('stale generated block counterexample is rewritten by docs generation', () => {
  const stale = '<!-- generated:feature-flags -->\nwrong\n<!-- /generated:feature-flags -->'
  const generated = renderGenerated(stale)
  assert.notEqual(generated, stale)
  assert.match(generated, /mikka-cloud-computer/)
})

test('pending register validates and unregistered pending text counterexample fails', async () => {
  assert.deepEqual(validatePendingRegister(), [])
  assert.deepEqual(await pendingLintProblems(), [])
  const root = await mkdtemp(join(tmpdir(), 'mikka-pending-lint-'))
  try {
    const alex = 'Al' + 'ex'
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs/decisions'), '', { flag: 'wx' }).catch(() => {})
    await writeFile(join(root, 'example.md'), `pending ${alex}\n`)
    const problems = await pendingLintProblems(root)
    assert.ok(problems.some(problem => problem.includes('example.md:1')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('closed waiter with no follow-up fails; blocked-by and dependency follow-ups pass', async () => {
  const issue = 999999
  const base = `/repos/aspectly-labs/Mikka/issues/${issue}`
  const closed = {
    [base]: { state: 'closed' },
    [`${base}/sub_issues?per_page=100`]: [],
    [`${base}/dependencies/blocking?per_page=100`]: [],
  }
  const noFollowup = githubMock(closed)
  assert.deepEqual(await closedWaiterProblems({ fetchImpl: noFollowup.fetchImpl, token: 'x' }, [issue]), [`#${issue}: closed with no open follow-up while a feature flag waits on it`])

  const dependent = githubMock({ ...closed, [`${base}/dependencies/blocking?per_page=100`]: [{ state: 'open' }] })
  assert.deepEqual(await closedWaiterProblems({ fetchImpl: dependent.fetchImpl, token: 'x' }, [issue]), [])

  const searchKey = `/search/issues?q=${encodeURIComponent('repo:aspectly-labs/Mikka is:issue is:open "blocked by #999999"')}&per_page=100`
  const bodyFollowup = githubMock({ ...closed, [searchKey]: { items: [{ state: 'open', body: 'Blocked by #999999\nFollow up.' }] } })
  assert.deepEqual(await closedWaiterProblems({ fetchImpl: bodyFollowup.fetchImpl, token: 'x' }, [issue]), [])
})

test('feature flags expose waitsOn metadata without a completed #172 waiter', () => {
  assert.equal(waitedIssues().includes(172), false)
})

test('closed issue action reopens only a registered waiter with no follow-up', async () => {
  assert.equal((await reopenClosedWaiterIfNeeded(123456)).reopened, false)
  const issue = 999999
  const base = `/repos/aspectly-labs/Mikka/issues/${issue}`
  const mock = githubMock({
    [`${base}/sub_issues?per_page=100`]: [],
    [`${base}/dependencies/blocking?per_page=100`]: [],
    [`${base}/comments`]: { id: 1 },
    [base]: { state: 'closed' },
  })
  const result = await reopenClosedWaiterIfNeeded(issue, { fetchImpl: mock.fetchImpl, token: 'x' }, [issue])
  assert.equal(result.reopened, true)
  assert.ok(mock.calls.some(call => call.key === `${base}/comments` && call.method === 'POST'))
  assert.ok(mock.calls.some(call => call.key === base && call.method === 'PATCH' && call.body?.state === 'open'))
})
