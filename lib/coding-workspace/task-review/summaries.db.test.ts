import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { and, inArray } from 'drizzle-orm'
import { runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { workspaceReadReceipt, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { checkpointReviewEvidence, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { takeCheckpoint } from '../../../packages/daemon/src/agents/checkpoint'
import { readWorkspaceDiffReceipt } from '../../../packages/daemon/src/coding-workspace/diff'
import type { JournalEntry } from '../../../packages/daemon/src/runs/journal'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../../tests/support/drop-test-database'
import { startGitHubAccessHttp } from '../../../tests/fakes/github-access-http.mjs'
import type { ReviewActor } from '../diff/authority'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(disposableDatabase(process.env, url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fullName = 'mikka-fixtures/task-review-summaries'
const remote = `https://github.com/${fullName}.git`
const reference = (snapshot: DiffSnapshot) => ({ snapshotId: snapshot.id, sourceVersion: snapshot.revision.version })

/** The bulk reader, both databases, Git evidence and masking are real. Only
 * Next's request context is supplied; no query, provider or daemon is mocked. */
test('Task review summaries preserve current source and tenant boundaries on PostgreSQL 17',
  { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 })
  const database = 'task_review_summaries_' + randomUUID().replaceAll('-', '') + '_e2e'
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Task review summaries require PostgreSQL 17')
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  const directory = await mkdtemp(join(tmpdir(), 'mikka-task-summary-db-'))
  const environment = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(),
    E2E_DATABASE_URL: target.toString(), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: 'http://127.0.0.1:3199', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-client-secret', GITHUB_APP_ID: '4840908' }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const tokens = new Map<string, { token: string; githubAccountId: string }>()
  const repositories = new Map<string, { id: string; full_name: string; private: boolean }>()
  const pulls = new Map<string, Record<string, unknown>>()
  const deniedUsers = new Set<string>(), failedRepositories = new Set<string>(), partialRepositories = new Set<string>()
  const providerErrors: unknown[] = []
  const summaryCalls: { repository: string; numbers: number[]; userId: string }[] = []
  let beforeSummary: ((call: typeof summaryCalls[number]) => Promise<void>) | undefined
  let activeSummaries = 0, maximumSummaries = 0
  const githubHttp = await startGitHubAccessHttp({
    getUser: request => {
      const entry = [...tokens.entries()].find(([, value]) => `Bearer ${value.token}` === request.headers.authorization)
      return entry && !deniedUsers.has(entry[0]) ? { id: entry[1].githubAccountId, login: 'summary-fixture' } : null
    },
    getRepositories: request => [...tokens.values()].some(value => `Bearer ${value.token}` === request.headers.authorization)
      ? [...repositories.values()] : [],
    onRequest: async (url, request, body) => {
      if (url.pathname !== '/graphql') return
      try {
        assert.equal(request.method, 'POST')
        const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> }
        assert.match(query, /^query\b/); assert.doesNotMatch(query, /\bmutation\b/)
        const entry = [...tokens.entries()].find(([, value]) => `Bearer ${value.token}` === request.headers.authorization)
        assert.ok(entry)
        const name = `${variables.owner}/${variables.name}`
        const aliases = [...query.matchAll(/([A-Za-z_][\w]*):\s*pullRequest\(number:\$([A-Za-z_][\w]*)\)/g)]
          .map(match => ({ name: match[1]!, number: Number(variables[match[2]!]) }))
        if (!aliases.length && Number.isInteger(variables.number)) aliases.push({ name: 'pullRequest', number: Number(variables.number) })
        assert.ok(aliases.length > 0 && aliases.length <= 20)
        const call = { repository: name, numbers: aliases.map(value => value.number), userId: entry[0] }
        summaryCalls.push(call)
        activeSummaries++; maximumSummaries = Math.max(maximumSummaries, activeSummaries)
        try {
          await beforeSummary?.(call)
          if (failedRepositories.has(name)) return Response.json({ message: 'synthetic unavailable' }, { status: 503 })
          return Response.json({ data: { repository: Object.fromEntries(aliases.map(value => [value.name, pulls.get(name + '#' + value.number) ?? null])) },
            ...(partialRepositories.has(name) ? { errors: [{ type: 'FORBIDDEN', message: 'synthetic partial data' }] } : {}) })
        } finally { activeSummaries-- }
      } catch (error) { providerErrors.push(error); return Response.json({ message: 'synthetic fixture failure' }, { status: 500 }) }
    },
  })
  mock.method(globalThis, 'fetch', githubHttp.routeFetch(globalThis.fetch))
  try {
    const migrations = new URL('../../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, migrations), 'utf8'))
    const next = await import('@/lib/server-runtime/server')
    mock.module('@/lib/server-runtime/server', { namedExports: { ...next, after() {} } })
    const apiContext = await import('../../../apps/api/src/context')
    mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => apiContext.currentRequestScope()?.headers ?? new Headers(), cookies: async () => ({
      get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {},
    }) } })
    mock.module('@/lib/intl/i18n-server', { namedExports: { getLocale: async () => 'en',
      getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
    const { taskReviewSummaries } = await import('./summaries')
    const { taskReviewSourceHint } = await import('./summary-selection')
    const { issueVisibility } = await import('../../issue-visibility')
    const { issues } = await import('../../db/schema')
    const { resolveRunWorktree } = await import('../identity')
    const { resolveReviewScope, withReviewTransaction } = await import('../diff/authority')
    const { prepareCheckpointReview, retainCheckpointReview } = await import('../diff/checkpoint')
    const { latestDiffSnapshot, readDiffSnapshot, retainDiffSnapshot, manifestRevision } = await import('../diff/store')
    const { validateDiffReceipt } = await import('../diff/receipt')
    const { secretMaskerFor } = await import('../../secrets/runtime')
    const { tokenWorkspace } = await import('../../tokens/principal')
    const { actingContext } = await import('../../activity-actor')
    const storage = await import('../../db'), db = storage.db
    appPool = storage.pool; workspacePool = (await import('../../workspace-db')).workspacePool
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd,
      '-c', 'user.name=Task summary fixture', '-c', 'user.email=task-summary@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()
    async function user() {
      const id = 'task-summary-' + randomUUID(), sessionId = randomUUID()
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
        [id, id + '@example.invalid'])
      await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [sessionId, randomUUID(), id])
      return { id, sessionId }
    }
    type User = Awaited<ReturnType<typeof user>>
    const owner = await user(), member = await user(), outsider = await user()
    const { saveGitHubConnection } = await import('../../github/connection')
    for (const person of [owner, member]) {
      const credential = { token: 'fixture-summary-' + randomUUID(), githubAccountId: String(4_000_000 + tokens.size) }
      tokens.set(person.id, credential)
      await saveGitHubConnection(person.id, { githubAccountId: credential.githubAccountId, githubLogin: 'summary-fixture' },
        { access_token: credential.token, expires_in: 3600 })
    }
    async function workspace() {
      const id = randomUUID(), teamId = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Task summary fixture\')', [id, owner.id])
      for (const who of [owner, member])
        await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')',
          [id, who.id, who.id + '@example.invalid', who === owner ? 'admin' : 'member'])
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task summary fixture\',$4)',
        [teamId, id, owner.id, 'T' + randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner.id])
      return { id, teamId }
    }
    type Workspace = Awaited<ReturnType<typeof workspace>>
    const actor = (who: User, workspaceId: string): ReviewActor => ({ userId: who.id, workspaceId,
      credential: { kind: 'session', id: who.sessionId } })
    async function task(where: Workspace) {
      const id = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Task summary fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\',\'workspace\')',
        [id, owner.id, where.id])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [id, where.teamId, where.id, owner.id])
      return id
    }
    async function fixture(where?: Workspace, fixtureRemote = remote) {
      where ??= await workspace()
      const runId = randomUUID(), repoId = randomUUID(), taskId = await task(where),
        deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
      const repository = join(directory, runId, 'repository'), worktree = join(directory, runId, 'checkout')
      await mkdir(repository, { recursive: true })
      await git(repository, 'init', '--initial-branch=main')
      await git(repository, 'config', 'core.autocrlf', 'false')
      await git(repository, 'remote', 'add', 'origin', fixtureRemote)
      for (const path of ['alpha.txt', 'beta.txt']) await writeFile(join(repository, path), 'before ' + path + '\nstable\n')
      await git(repository, 'add', '--all'); await git(repository, 'commit', '-qm', 'summary base')
      await git(repository, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      const baseSha = await git(worktree, 'rev-parse', 'HEAD')
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Task summary fixture\',\'local\')', [deviceId, owner.id])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,\'codex\',$4)',
        [agentId, owner.id, 'Task summary ' + runId, deviceId])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',
        [repoId, owner.id, deviceId, remoteKey(fixtureRemote), fixtureRemote])
      await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
        [tokenId, owner.id, hash(randomUUID())])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,\'running\',$8,now()+interval \'10 minutes\',$9)',
      [runId, owner.id, taskId, agentId, deviceId, repoId, tokenId, worktree,
        { executionIdentity: { workspaceId: where.id }, repositoryAdmission: { workspaceId: where.id, remoteKey: remoteKey(fixtureRemote) } }])
      const who = actor(owner, where.id)
      const identity = (await resolveRunWorktree(pool, pool, who, runId, repoId)).identity
      const entry: JournalEntry = { assignment: runAssignmentSchema.parse({ runId, issueId: taskId, repoId, deviceId,
        remoteUrl: fixtureRemote, baseBranch: 'main', harness: 'codex', prompt: 'Read this task.', kind: 'implement' }),
      state: 'running', sessionId: null, worktree, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() }
      for (const path of ['alpha.txt', 'beta.txt']) await writeFile(join(worktree, path), 'after ' + path + '\nstable\n')
      return { where, taskId, runId, repoId, deviceId, tokenId, agentId, repository, worktree, baseSha, who, identity, entry }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function checkpoint(f: Fixture) {
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const proof = checkpointReviewEvidence.parse(captured.checkpoint.review)
      assert.equal(proof.reason, null); assert.ok(proof.blobs.length > 0)
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const prepared = prepareCheckpointReview(captured.checkpoint, f.repoId, mask)
      assert.equal(prepared.reason, null)
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId, async (tx, scope) => {
        await retainCheckpointReview(tx, scope, prepared, new Date(captured.checkpoint.takenAt), mask)
        const { rows: [saved] } = await tx.query<{ snapshotId: string; reason: string | null }>(
          'SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])
        assert.ok(saved?.snapshotId); assert.equal(saved.reason, null)
        return readDiffSnapshot(tx, scope, saved.snapshotId)
      }, { live: f.identity })
    }
    const stop = (f: Fixture) => pool.query('UPDATE agent_runs SET status=\'stopped\',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1', [f.runId])
    async function working(f: Fixture) {
      const request = { kind: 'diff_snapshot' as const, source: 'working' as const }
      const command: WorkspaceReadCommand = { id: randomUUID(), identity: f.identity, request,
        expiresAt: new Date(Date.now() + 15_000).toISOString() }
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(command, f.entry, f.repository))
      const result = validateDiffReceipt(request, receipt, mask)
      assert.ok(result?.ok && result.kind === 'diff_snapshot')
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainDiffSnapshot(tx, scope, { revision: result.revision, files: result.files }, mask), { live: f.identity })
    }
    async function extraRun(f: Pick<Fixture, 'where' | 'taskId'>, who: User, seconds: number, kind = 'implement') {
      const id = randomUUID(), agentId = randomUUID()
      await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,\'codex\')', [agentId, who.id, 'Other summary thread ' + id])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",kind,status,"createdAt","agentDefinition") ' +
        'VALUES($1,$2,$3,$4,$5,\'stopped\',clock_timestamp()+$6*interval \'1 second\',$7)',
      [id, who.id, f.taskId, agentId, kind, seconds, { executionIdentity: { workspaceId: f.where.id } }])
      return id
    }
    async function factoryCheck(f: Fixture, stage: 'review' | 'verify' | 'monitor', seconds: number) {
      const runId = await extraRun(f, owner, seconds), taskId = randomUUID(), attemptId = randomUUID(), sourceEventId = randomUUID()
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,\'{"text":"Summary fixture"}\')',
          [sourceEventId, owner.id, f.taskId])
        await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason) ' +
          'VALUES($1,$2,$3,$4,$5,$6,\'running\',1,$7,\'Summary check fixture\')',
        [taskId, owner.id, f.taskId, sourceEventId, { issueId: f.taskId, sourceEventId, eventId: randomUUID(), rationale: 'Fixture' }, stage, attemptId])
        await tx.query('INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output) ' +
          'VALUES($1,$2,$3,1,1,\'running\',$4,\'Summary check fixture\',$5)', [attemptId, taskId, stage, runId, { requestEpoch: sourceEventId }])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      return runId
    }
    const read = (f: Fixture, userId = owner.id, workspaceId = f.where.id) => taskReviewSummaries(userId, [f.taskId], workspaceId)
    async function publish(f: Pick<Fixture, 'identity' | 'runId' | 'taskId'>, number: number) {
      const name = f.identity.repositoryKey.slice('v2/github.com/'.length)
      if (!repositories.has(name)) repositories.set(name, { id: String(8_000_000 + repositories.size), full_name: name, private: true })
      pulls.set(name + '#' + number, { number, headRefOid: 'b'.repeat(40), baseRefOid: 'a'.repeat(40), state: 'OPEN', reviewDecision: null,
        repository: { fullDatabaseId: repositories.get(name)!.id, nameWithOwner: name },
        changedFiles: 9, additions: 42, deletions: 7, isDraft: false, mergeable: 'MERGEABLE',
        commits: { nodes: [{ commit: { oid: 'b'.repeat(40), statusCheckRollup: null } }] } })
      await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest")
        VALUES($1,$2,$3,$4,$5,'mikka/summary-fixture','published',$6)`,
      [f.runId, owner.id, f.taskId, `https://github.com/${name}.git`, f.identity.repositoryKey, { url: `https://github.com/${name}/pull/${number}` }])
    }
    async function copyPublication(f: Fixture, number: number) {
      const taskId = await task(f.where), runId = randomUUID()
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition")
        SELECT $2,"userId",$3,"agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","leaseExpiresAt","agentDefinition"
        FROM agent_runs WHERE id=$1`, [f.runId, runId, taskId])
      const copy = { taskId, runId, identity: { ...f.identity, runId } }
      await publish(copy, number)
      return copy
    }
    async function archive(f: Fixture, number: number) {
      const name = f.identity.repositoryKey.slice('v2/github.com/'.length), repositoryId = repositories.get(name)!.id
      const sourceAccess = { kind: 'github' as const, repositoryId, pullRequestNumber: number, pullRequestBaseSha: 'a'.repeat(40), manifestComplete: true as const }
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      return withReviewTransaction(pool, pool, f.who, f.runId, f.repoId, (tx, scope) => retainDiffSnapshot(tx, scope, {
        revision: manifestRevision('pull_request', 'a'.repeat(40), 'b'.repeat(40), null, [], sourceAccess), files: [], sourceAccess,
        pullRequest: { number, url: `https://github.com/${name}/pull/${number}`, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), state: 'open' },
      }, mask), { live: f.identity })
    }
    async function sourceHints(ids: string[], userId = owner.id) {
      const visibility = await issueVisibility(userId, false, undefined, db, { onlyIssueIds: ids, withIdentifierTeams: true })
      const rows = await db.select({ id: issues.id, codingReview: taskReviewSourceHint }).from(issues)
        .where(and(inArray(issues.id, ids), visibility.predicate))
      return new Map(rows.map(row => [row.id, row.codingReview]))
    }

    await t.test('published PR metadata is live for the current viewer without creating an archive', async () => {
      const f = await fixture()
      await publish(f, 7)
      const value = (await read(f, member.id)).get(f.taskId)
      assert.equal(value?.pr?.number, 7)
      assert.equal(value?.pr?.state, 'open')
      assert.equal(value?.files, 9); assert.equal(value?.additions, 42); assert.equal(value?.deletions, 7)
      assert.equal(value?.reviewRef, null); assert.equal(value?.nativeMergeTarget, null)
      assert.equal(value?.checks?.total, 0)
      assert.equal(summaryCalls.at(-1)?.userId, member.id, 'read authority belongs to the viewer, not the Run owner')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_snapshots WHERE "runId"=$1', [f.runId])).rows[0].n, 0)
    })

    await t.test('changed HEAD, base, lifecycle and checks never borrow retained PR metadata or grant a native merge', async () => {
      const f = await fixture()
      await publish(f, 8)
      const stored = await archive(f, 8)
      const value = pulls.get(fullName + '#8')!
      value.headRefOid = 'c'.repeat(40); value.baseRefOid = 'd'.repeat(40); value.state = 'MERGED'; value.changedFiles = 17
      value.commits = { nodes: [{ commit: { oid: 'c'.repeat(40), statusCheckRollup: { contexts: {
        totalCount: 124, checkRunCount: 124, statusContextCount: 0,
        checkRunCountsByState: [{ count: 122, state: 'SUCCESS' }, { count: 2, state: 'FAILURE' }], statusContextCountsByState: [],
      } } } }] }
      const summary = (await read(f)).get(f.taskId)
      assert.equal(summary?.pr?.state, 'merged'); assert.equal(summary?.pr?.headSha, 'c'.repeat(40))
      assert.equal(summary?.files, 17); assert.equal(summary?.checks?.total, 124); assert.equal(summary?.checks?.failed, 2)
      assert.equal(summary?.reviewRef, null); assert.equal(summary?.mergeTarget, null); assert.equal(summary?.nativeMergeTarget, null)
      const retained = await readDiffSnapshot(pool, await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId), stored.id)
      assert.equal(retained.revision.headSha, 'b'.repeat(40)); assert.equal(retained.pullRequest?.state, 'open')
    })

    await t.test('45 task cards deduplicate 22 exact PRs into two documents and constant SQL work', async t => {
      const f = await fixture(), ids = [f.taskId]
      await publish(f, 1000)
      for (let index = 1; index < 45; index++) ids.push((await copyPublication(f, 1000 + index % 22)).taskId)
      const query = t.mock.method(appPool!, 'query')
      const oneStart = query.mock.callCount()
      assert.equal((await read(f, member.id)).size, 1)
      const sqlOne = query.mock.callCount() - oneStart
      const start = summaryCalls.length, httpStart = githubHttp.requests.length, manyStart = query.mock.callCount()
      const summaries = await taskReviewSummaries(member.id, [...ids, ids[0]!, ids[1]!], f.where.id)
      const sqlMany = query.mock.callCount() - manyStart
      assert.equal(summaries.size, 45)
      assert.equal(sqlMany, sqlOne, 'source, masks, visibility and association use bounded bulk SQL, never per-card reads')
      const calls = summaryCalls.slice(start)
      assert.equal(calls.length, 2); assert.deepEqual(calls.map(call => call.numbers.length), [20, 2])
      assert.equal(new Set(calls.flatMap(call => call.numbers)).size, 22)
      assert.ok(calls.every(call => call.userId === member.id))
      const requests = githubHttp.requests.slice(httpStart)
      assert.equal(requests.filter(request => request.pathname === '/user').length, 1)
      assert.equal(requests.filter(request => request.pathname === '/repos/' + fullName).length, 1)
      console.log('bulk_summary_bounds=' + JSON.stringify({ tasks: summaries.size, sqlOne, sqlMany, graphql: calls.length, uniquePulls: 22 }))
    })

    await t.test('repository reads have at most four concurrent documents and independent complete results', async () => {
      const where = await workspace(), ids: string[] = []
      for (let index = 0; index < 6; index++) {
        const f = await fixture(where, `https://github.com/mikka-fixtures/bulk-concurrency-${index}.git`)
        await publish(f, 1); ids.push(f.taskId)
      }
      maximumSummaries = 0
      beforeSummary = async () => { await new Promise(resolve => setTimeout(resolve, 40)) }
      try { assert.equal((await taskReviewSummaries(member.id, ids, where.id)).size, 6) }
      finally { beforeSummary = undefined }
      assert.ok(maximumSummaries > 1 && maximumSummaries <= 4)
    })

    await t.test('unavailable and partial GraphQL batches stay unknown while another repo and working source survive', async () => {
      const where = await workspace(), bad = await fixture(where), good = await fixture(where, 'https://github.com/mikka-fixtures/bulk-healthy.git'),
        workingTask = await fixture(where)
      await publish(bad, 9); await archive(bad, 9); await publish(good, 1); await working(workingTask)
      for (const denied of [failedRepositories, partialRepositories]) {
        denied.add(fullName)
        try {
          const result = await taskReviewSummaries(member.id, [bad.taskId, good.taskId, workingTask.taskId], where.id)
          assert.equal(result.has(bad.taskId), false, 'an archive cannot turn an incomplete or failed response into live status')
          assert.equal(result.get(good.taskId)?.pr?.number, 1)
          assert.equal(result.get(workingTask.taskId)?.files, 2)
          assert.equal(result.get(workingTask.taskId)?.additions, null)
        } finally { denied.delete(fullName) }
      }
    })

    await t.test('in-flight member revocation and publication changes suppress only invalidated sources', async () => {
      const where = await workspace(), first = await fixture(where), second = await fixture(where)
      await publish(first, 10); await publish(second, 11)
      const ids = [first.taskId, second.taskId]
      beforeSummary = async () => { await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [where.id, member.id]) }
      try { assert.equal((await taskReviewSummaries(member.id, ids, where.id)).size, 0) }
      finally {
        beforeSummary = undefined
        await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [where.id, member.id])
      }
      beforeSummary = async () => { await pool.query('UPDATE run_publications SET "pullRequest"=$2 WHERE "runId"=$1',
        [first.runId, { url: `https://github.com/${fullName}/pull/12` }]) }
      try {
        const result = await taskReviewSummaries(member.id, ids, where.id)
        assert.equal(result.has(first.taskId), false); assert.equal(result.get(second.taskId)?.pr?.number, 11)
      } finally { beforeSummary = undefined }
      deniedUsers.add(member.id)
      const start = summaryCalls.length
      try { assert.equal((await read(second, member.id)).size, 0) } finally { deniedUsers.delete(member.id) }
      assert.equal(summaryCalls.length, start, 'a revoked viewer never borrows the owner credential')
      assert.equal((await read(second, owner.id)).get(second.taskId)?.pr?.number, 11)
    })

    await t.test('one shared deadline prevents a second batch after the first response exhausts the budget', async t => {
      const f = await fixture(), ids = [f.taskId]
      await publish(f, 2000)
      for (let index = 1; index < 22; index++) ids.push((await copyPublication(f, 2000 + index)).taskId)
      const start = summaryCalls.length, realNow = Date.now.bind(Date)
      let elapsed = 0
      t.mock.method(Date, 'now', () => realNow() + elapsed)
      beforeSummary = async () => { elapsed = 31_000 }
      try { assert.equal((await taskReviewSummaries(member.id, ids, f.where.id)).size, 0) }
      finally { beforeSummary = undefined }
      assert.equal(summaryCalls.length - start, 1)
    })

    await t.test('changed Task links or a replacement Run during GitHub I/O cannot borrow the previous source', async () => {
      const where = await workspace(), elsewhere = await workspace()
      const moved = await fixture(where), replaced = await fixture(where), unchanged = await fixture(where)
      await publish(moved, 31); await publish(replaced, 32); await publish(unchanged, 33)
      beforeSummary = async () => {
        const tx = await pool.connect()
        try {
          await tx.query('BEGIN')
          await tx.query('UPDATE mikka_team_issues SET "teamId"=$2,"workspaceId"=$3 WHERE "issueId"=$1',
            [moved.taskId, elsewhere.teamId, elsewhere.id])
          // The Task's database-enforced workspace stays immutable. Recheck
          // the separate Team association after the external response too.
          await tx.query('COMMIT')
        } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
        await extraRun(replaced, owner, 10)
      }
      try {
        const result = await taskReviewSummaries(member.id, [moved.taskId, replaced.taskId, unchanged.taskId], where.id)
        assert.deepEqual([...result.keys()], [unchanged.taskId])
        assert.equal(result.get(unchanged.taskId)?.pr?.number, 33)
      } finally { beforeSummary = undefined }
      assert.equal((await read(moved, member.id, elsewhere.id)).size, 0, 'the old Run remains bound to its original workspace')
      assert.equal((await read(replaced, member.id)).size, 0, 'the newest noncoding Run cannot use its predecessor PR')
    })

    await t.test('mobile and citation callers expose current PR metadata without an archived diff', async () => {
      const f = await fixture()
      await publish(f, 34)
      const { mobileTask } = await import('../../mobile-tasks')
      const { citationSources } = await import('../../coordinator/store')
      const mobile = await mobileTask({ id: member.id }, f.taskId, f.where.id)
      assert.equal(mobile?.task.review?.pr?.number, 34)
      assert.equal(mobile?.task.review?.reviewRef, null)
      const current = pulls.get(fullName + '#34')!
      current.state = 'CLOSED'
      const citations = await citationSources(member.id, [`[[issue:${f.taskId}]]`])
      const source = citations[f.taskId]
      assert.ok(source?.kind === 'issue')
      assert.equal(source.review?.pr?.state, 'closed')
      assert.equal(source.review?.nativeMergeTarget, null)
      assert.doesNotMatch(JSON.stringify([mobile, citations]), /"repositoryKey"|"worktreePath"|"sourceAccess"/)
    })

    await t.test('caller payloads recheck authority after GitHub without holding workspace locks', async t => {
      const { actAs } = await import('../../acting-user')
      const { enterprisePrincipal } = await import('../../enterprise/principal')
      const { auth } = await import('../../auth')
      const { GET: detail } = await import('../../../app/api/mobile/tasks/[id]/route')
      const { GET: list } = await import('../../../app/api/mobile/tasks/route')
      const { TASK_PRESENTATION_PARAM, TASK_PRESENTATION_VERSION } = await import('../../mobile-task-refresh')
      const { getTaskPresentations } = await import('../../../app/actions/task-domain')
      const { citationSources } = await import('../../coordinator/store')
      const { ActionFailureError } = await import('../../action-error')
      const authContext = await auth.$context
      const session = await authContext.internalAdapter.createSession(member.id)
      assert.ok(session)
      for (const name of ['detail', 'work detail', 'list', 'projected list', 'presentations', 'citations'] as const) {
        for (const providerFails of [false, true]) await t.test(name + (providerFails ? ' with unavailable GitHub' : ''), async () => {
          const f = await fixture(), title = 'Private caller payload ' + randomUUID()
          await pool.query('UPDATE issues SET title=$2 WHERE id=$1', [f.taskId, title])
          await publish(f, 3000 + summaryCalls.length)
          const reader = { id: member.id, [tokenWorkspace]: f.where.id,
            [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.id } }
          const api = async (path: string, handler: (request: Request) => Promise<Response>) => {
            const request = new Request('http://127.0.0.1:3199/mikka' + path, { headers: {
              authorization: 'Bearer ' + session.token, 'x-mikka-workspace-id': f.where.id, 'x-mikka-locale': 'en',
            } })
            const scope = apiContext.createRequestScope(request)
            try {
              const response = await apiContext.runRequestScope(scope, () => handler(request))
              return { status: response.status, body: await response.json() }
            } finally { await scope.after.finish() }
          }
          const invoke = async () => {
            if (name === 'detail' || name === 'work detail') return api('/api/mobile/tasks/' + f.taskId + (name === 'work detail' ? '?work=1' : ''),
              request => detail(request, { params: Promise.resolve({ id: f.taskId }) }))
            if (name === 'list' || name === 'projected list') return api('/api/mobile/tasks' + (name === 'projected list'
              ? `?${TASK_PRESENTATION_PARAM}=${TASK_PRESENTATION_VERSION}` : ''), request => list(request))
            if (name === 'presentations') return actAs(reader, () => getTaskPresentations({ workspaceId: f.where.id, issueIds: [f.taskId], includeReview: true }))
            return citationSources(reader, [`[[issue:${f.taskId}]] [[run:${f.runId}]]`])
          }
          const control = await invoke()
          assert.ok(JSON.stringify(control).includes(f.taskId), 'the original caller returns the authorized task')
          let writes = 0, lockFailure: unknown
          beforeSummary = async () => {
            const tx = await pool.connect()
            try {
              await tx.query('BEGIN')
              await tx.query("SET LOCAL lock_timeout='500ms'")
              await tx.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
              await tx.query('COMMIT'); writes++
            } catch (error) { await tx.query('ROLLBACK'); lockFailure = error }
            finally { tx.release() }
          }
          if (providerFails) failedRepositories.add(fullName)
          let value: unknown
          try {
            try { value = await invoke() }
            catch (error) {
              if (!(error instanceof ActionFailureError) || !['workspaceAccessDenied', 'issueNotFound'].includes(error.code)) throw error
              value = { error: error.code }
            }
          } finally {
            beforeSummary = undefined; failedRepositories.delete(fullName)
            await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
          }
          assert.equal(lockFailure, undefined, 'membership revocation must commit while the real GitHub HTTP request is pending')
          assert.equal(writes, 1)
          assert.ok(!JSON.stringify(value).includes(f.taskId), 'the entire revoked task is absent, not only its review')
          assert.ok(!JSON.stringify(value).includes(title), 'no old title survives the final authorization read')
        })
      }
    })

    await t.test('chat payloads recheck their own Bot workspace after citation provider I/O', async t => {
      const { auth } = await import('../../auth')
      const { actAs } = await import('../../acting-user')
      const { enterprisePrincipal } = await import('../../enterprise/principal')
      const { chatViewState } = await import('../../coordinator/store')
      const { pollCoordinatorChat } = await import('../../../app/actions/coordinator')
      const { ActionFailureError } = await import('../../action-error')
      const { WorkspaceError } = await import('../../workspace-error')
      const session = await (await auth.$context).internalAdapter.createSession(member.id)
      assert.ok(session)
      for (const name of ['chat view', 'full poll', 'unchanged poll'] as const) {
        for (const providerFails of [false, true]) await t.test(name + (providerFails ? ' with unavailable GitHub' : ''), async () => {
          const f = await fixture(), botId = randomUUID(), privateText = 'Private chat payload ' + randomUUID()
          await publish(f, 5000 + summaryCalls.length)
          await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Citation fixture\')',
            [botId, member.id, f.where.id])
          await pool.query('INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,$2,$3,1,$4)',
            [randomUUID(), member.id, botId, { role: 'assistant', content: [{ type: 'text', text: `${privateText} [[issue:${f.taskId}]] [[run:${f.runId}]]` }] }])
          const reader = { id: member.id, [tokenWorkspace]: f.where.id,
            [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.id } }
          const request = async <T,>(work: () => Promise<T>): Promise<T> => {
            const scope = apiContext.createRequestScope(new Request('http://127.0.0.1:3199/mikka', { headers: {
              authorization: 'Bearer ' + session.token, 'x-mikka-workspace-id': f.where.id, 'x-mikka-locale': 'en',
            } }))
            try { return await apiContext.runRequestScope(scope, () => actAs(reader, work)) }
            finally { await scope.after.finish() }
          }
          const initial = await request(() => pollCoordinatorChat(botId))
          assert.ok(!('unchanged' in initial) && initial.version && initial.continuation)
          assert.ok(JSON.stringify(initial).includes(privateText))
          const known = initial.version
          const held = { ...initial.continuation, sourceIds: Object.keys(initial.sources), artifactIds: [] }
          const invoke = () => request(async () => name === 'chat view'
            ? await chatViewState(member.id, 200, botId)
            : name === 'full poll' ? await pollCoordinatorChat(botId) : await pollCoordinatorChat(botId, known, held))
          const control = await invoke()
          if (name === 'unchanged poll') assert.ok('unchanged' in control && control.unchanged)
          else assert.ok(JSON.stringify(control).includes(privateText))
          const start = summaryCalls.length, revokeOn = name === 'full poll' ? 2 : 1
          let writes = 0, lockFailure: unknown
          beforeSummary = async () => {
            if (summaryCalls.length - start !== revokeOn) return
            const tx = await pool.connect()
            try {
              await tx.query('BEGIN')
              await tx.query("SET LOCAL lock_timeout='500ms'")
              await tx.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
              await tx.query('COMMIT'); writes++
            } catch (error) { await tx.query('ROLLBACK'); lockFailure = error }
            finally { tx.release() }
          }
          if (providerFails) failedRepositories.add(fullName)
          let value: unknown, denied = false
          try {
            try { value = await invoke() }
            catch (error) {
              if (!(error instanceof ActionFailureError || error instanceof WorkspaceError)
                || !['workspaceAccessDenied', 'botNotFound'].includes(error.code)) throw error
              denied = true
            }
          } finally {
            beforeSummary = undefined; failedRepositories.delete(fullName)
            await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
          }
          assert.equal(lockFailure, undefined, 'the chat reader never holds a membership lease across GitHub')
          assert.equal(writes, 1, 'the intended provider read reached the revocation barrier')
          assert.equal(denied, true, 'revoked Bot workspace authority refuses the whole response, including an unchanged poll')
          assert.equal(value, undefined, 'no previously read transcript or Bot metadata survives revocation')
        })
      }
    })

    await t.test('title and delivery callers keep their existing projection without fetching GitHub review metadata', async () => {
      const f = await fixture(); await publish(f, 4000)
      const { citationSources } = await import('../../coordinator/store')
      const { resolveMessageReferencesBatch } = await import('../../message-references')
      const { getThreadName } = await import('../../../app/actions/agents')
      const { mobileThreads } = await import('../../mobile-threads')
      const { actAs } = await import('../../acting-user')
      const { enterprisePrincipal } = await import('../../enterprise/principal')
      const { auth } = await import('../../auth')
      const session = await (await auth.$context).internalAdapter.createSession(owner.id)
      assert.ok(session)
      const reader = { id: owner.id, [tokenWorkspace]: f.where.id,
        [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.id } }
      const text = `[[issue:${f.taskId}]] [[run:${f.runId}]]`
      const complete = await citationSources(reader, [text])
      for (const source of Object.values(complete)) {
        if (source.kind === 'issue') delete source.review
        else if (source.issue) delete source.issue.review
      }
      const start = summaryCalls.length
      assert.deepEqual(await citationSources(reader, [text], [], { includeReview: false }), complete)
      const references = await resolveMessageReferencesBatch({ userId: owner.id, workspaceId: f.where.id }, [text])
      assert.equal(references[0]?.length, 2); assert.ok(references[0]?.every(reference => !reference.unavailable))
      const scope = apiContext.createRequestScope(new Request('http://127.0.0.1:3199/mikka', { headers: {
        authorization: 'Bearer ' + session.token, 'x-mikka-workspace-id': f.where.id, 'x-mikka-locale': 'en',
      } }))
      try {
        await apiContext.runRequestScope(scope, async () => {
          const name = await getThreadName(f.runId)
          assert.ok(name?.includes('Task summary fixture'))
          const threads = await actAs(reader, () => mobileThreads(owner.id, 60, undefined, f.where.id))
          assert.ok(threads.threads.some(thread => thread.id === f.runId))
        })
      } finally { await scope.after.finish() }
      assert.equal(summaryCalls.length, start, 'these existing caller contracts never expose or fetch review metadata')
    })

    for (const unavailable of [false, true]) await t.test(`mixed local summaries revalidate Run changes after ${unavailable ? 'failed' : 'successful'} GitHub I/O`, async () => {
      const where = await workspace(), pull = await fixture(where), local = await fixture(where),
        stopped = await fixture(where), unchanged = await fixture(where)
      await publish(pull, unavailable ? 36 : 35)
      await working(local); await checkpoint(stopped); await stop(stopped)
      const kept = await working(unchanged)
      beforeSummary = async () => {
        await extraRun(local, owner, 10)
        await extraRun(stopped, owner, 10)
      }
      if (unavailable) failedRepositories.add(fullName)
      try {
        const result = await taskReviewSummaries(member.id,
          [pull.taskId, local.taskId, stopped.taskId, unchanged.taskId], where.id)
        assert.equal(result.has(local.taskId), false, 'a replaced working Run cannot return its old review reference')
        assert.equal(result.has(stopped.taskId), false, 'a replaced checkpoint Run cannot return its old review reference')
        assert.equal(result.has(pull.taskId), !unavailable)
        assert.deepEqual(result.get(unchanged.taskId)?.reviewRef, reference(kept))
      } finally { beforeSummary = undefined; failedRepositories.delete(fullName) }
    })

    await t.test('one bulk read returns each same-owner Task with its own immutable reference and shared viewer permissions', async () => {
      const where = await workspace(), fixtures: Fixture[] = [], snapshots: DiffSnapshot[] = []
      for (let index = 0; index < 3; index++) {
        const f = await fixture(where); fixtures.push(f); snapshots.push(await checkpoint(f)); await stop(f)
      }
      const ids = fixtures.map(f => f.taskId), own = await taskReviewSummaries(owner.id, [...ids, ids[0]!, 'invalid'], where.id)
      const shared = await taskReviewSummaries(member.id, ids, where.id)
      assert.equal(own.size, 3); assert.equal(shared.size, 3)
      for (const [index, f] of fixtures.entries()) {
        const value = own.get(f.taskId); assert.ok(value)
        assert.deepEqual(value.reviewRef, reference(snapshots[index]!)); assert.equal(value.taskId, f.taskId)
        assert.equal(value.files, 2); assert.equal(value.additions, 2); assert.equal(value.deletions, 2)
        assert.equal(value.countsKnown, true); assert.equal(value.checks, null); assert.equal(value.running, false)
        assert.equal(value.permissions.canSend, true)
        assert.deepEqual(shared.get(f.taskId)?.reviewRef, value.reviewRef)
        assert.equal(shared.get(f.taskId)?.permissions.canSend, false); assert.equal(shared.get(f.taskId)?.permissions.canTerminal, false)
      }
      const serialized = JSON.stringify([...own.values()])
      for (const field of ['base64', 'blobs', 'patch', 'repositoryKey', 'tokenHash', 'worktreePath'])
        assert.ok(!serialized.includes('"' + field + '"'), 'summary never returns private field ' + field)
      assert.ok(!serialized.includes('after alpha.txt'))
    })

    await t.test('current source follows the persisted Task owner and excludes newer viewer, group and Factory check Runs', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await extraRun(f, member, 10)
      await extraRun(f, owner, 20, 'group_chat')
      for (const [index, stage] of (['review', 'verify', 'monitor'] as const).entries()) await factoryCheck(f, stage, 30 + index)
      for (const userId of [owner.id, member.id]) assert.deepEqual((await read(f, userId)).get(f.taskId)?.reviewRef, reference(snapshot))
    })

    await t.test('private source hints keep an old Task-owner repository visible through shared mobile and citation reads', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await pool.query('UPDATE agent_runs SET "createdAt"=now()-interval \'45 days\' WHERE id=$1', [f.runId])
      const viewerRunId = await extraRun(f, member, 0)
      const plainTaskId = await task(f.where)
      await extraRun({ where: f.where, taskId: plainTaskId }, owner, 0)
      const hints = await sourceHints([f.taskId, plainTaskId], member.id)
      assert.equal(hints.get(f.taskId), true, 'the owner repository is older than the viewer list window')
      assert.equal(hints.get(plainTaskId), false, 'another Task repository cannot satisfy the correlated SELECT')

      const { newestTaskRuns } = await import('../../task-block-runs')
      const decorations = await newestTaskRuns(member.id, [f.taskId, plainTaskId], f.where.id)
      const selected = decorations.find(row => row.issueId === f.taskId)
      assert.equal(selected?.runId, viewerRunId, 'the existing list decoration still follows its own viewer window')
      assert.equal(selected?.codingReview, true, 'the independent Task-owner hint does not follow the viewer Run')
      assert.equal(decorations.find(row => row.issueId === plainTaskId)?.codingReview, false)

      const { mobileTask } = await import('../../mobile-tasks')
      const detail = await mobileTask({ id: member.id }, f.taskId, f.where.id)
      assert.ok(detail)
      assert.deepEqual(detail.task.review?.reviewRef, reference(snapshot))
      assert.doesNotMatch(JSON.stringify(detail), /"codingReview"|"repositoryKey"|"worktreePath"/)

      const { citationSources } = await import('../../coordinator/store')
      const direct = await citationSources(member.id, [`[[issue:${f.taskId}]]`, `[[issue:${plainTaskId}]]`])
      const coding = direct[f.taskId], plain = direct[plainTaskId]
      assert.ok(coding?.kind === 'issue' && plain?.kind === 'issue')
      assert.deepEqual(coding.review?.reviewRef, reference(snapshot))
      assert.equal(Object.hasOwn(plain, 'review'), false, 'noncoding citations keep their prior public shape')
      const runOnly = await citationSources(member.id, [`[[run:${f.runId}]]`])
      assert.deepEqual(Object.keys(runOnly), [f.runId], 'a run-only citation does not add a direct Task source')
      const run = runOnly[f.runId]; assert.ok(run?.kind === 'run')
      assert.deepEqual(run.issue?.review?.reviewRef, reference(snapshot))
      assert.doesNotMatch(JSON.stringify([direct, runOnly]), /"codingReview"|"ownerId"|"repositoryKey"|"worktreePath"/)
    })

    await t.test('a first coding Run without retained binding or snapshot still exposes an honest empty summary entry', async () => {
      const f = await fixture()
      const retained = async () => (await pool.query('SELECT (SELECT count(*)::int FROM coding_workspace_bindings WHERE "runId"=$1) AS bindings,' +
        '(SELECT count(*)::int FROM coding_workspace_snapshots WHERE "runId"=$1) AS snapshots', [f.runId])).rows[0]
      assert.deepEqual(await retained(), { bindings: 0, snapshots: 0 })
      assert.equal((await sourceHints([f.taskId])).get(f.taskId), true, 'an unretained first repository Run remains a candidate')
      const value = (await read(f)).get(f.taskId); assert.ok(value)
      assert.equal(value.taskId, f.taskId); assert.equal(value.reviewRef, null); assert.equal(value.running, true)
      assert.equal(value.files, null); assert.equal(value.additions, null); assert.equal(value.deletions, null)
      assert.equal(value.countsKnown, false); assert.equal(value.checks, null)
      assert.equal(value.permissions.canSend, false); assert.equal(value.permissions.canTerminal, true)
      assert.deepEqual(await retained(), { bindings: 0, snapshots: 0 }, 'card reads never create source evidence')
    })

    await t.test('lazy working manifests keep unknown additions, deletions and checks null', async () => {
      const f = await fixture(), snapshot = await working(f)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND patch IS NULL',
        [snapshot.id])).rows[0].n, 2)
      const value = (await read(f)).get(f.taskId); assert.ok(value)
      assert.deepEqual(value.reviewRef, reference(snapshot)); assert.equal(value.files, 2)
      assert.equal(value.countsKnown, false); assert.equal(value.additions, null); assert.equal(value.deletions, null)
      assert.equal(value.checks, null); assert.equal(value.running, true)
    })

    await t.test('retained checkpoint summaries survive physical device and repository cleanup', async () => {
      const f = await fixture(), snapshot = await checkpoint(f); await stop(f)
      await pool.query('DELETE FROM devices WHERE id=$1', [f.deviceId])
      assert.equal((await pool.query('SELECT 1 FROM device_repos WHERE id=$1', [f.repoId])).rowCount, 0)
      const run = (await pool.query('SELECT "deviceId","deviceRepoId" FROM agent_runs WHERE id=$1', [f.runId])).rows[0]
      assert.deepEqual(run, { deviceId: null, deviceRepoId: null })
      for (const userId of [owner.id, member.id]) {
        assert.equal((await sourceHints([f.taskId], userId)).get(f.taskId), true, 'retained binding survives device/repository removal')
        const value = (await read(f, userId)).get(f.taskId); assert.ok(value)
        assert.deepEqual(value.reviewRef, reference(snapshot)); assert.equal(value.files, 2); assert.equal(value.running, false)
      }
    })

    await t.test('foreign workspace, suspended member, outsider and removed Team link disclose no summary', async () => {
      const f = await fixture(); await checkpoint(f); await stop(f)
      const elsewhere = await workspace()
      assert.equal((await read(f, member.id)).size, 1)
      assert.equal((await read(f, owner.id, elsewhere.id)).size, 0)
      assert.equal((await read(f, outsider.id)).size, 0)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.where.id, member.id])
      assert.equal((await read(f, member.id)).size, 0)
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      assert.equal((await read(f)).size, 0)
      assert.equal((await taskReviewSummaries(owner.id, [f.taskId])).size, 0, 'owner fallback cannot revive an unlinked Team Task')
    })

    await t.test('moving a Task between workspaces cannot move its frozen summary authority', async () => {
      const f = await fixture(); await checkpoint(f); await stop(f)
      const elsewhere = await workspace()
      await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [f.taskId])
      await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)',
        [f.taskId, elsewhere.teamId, elsewhere.id, owner.id])
      for (const userId of [owner.id, member.id]) {
        assert.equal((await read(f, userId)).size, 0)
        assert.equal((await read(f, userId, elsewhere.id)).size, 0)
        assert.equal((await taskReviewSummaries(userId, [f.taskId])).size, 0)
      }
    })

    await t.test('explicit and ambient PAT workspace pins override a caller-selected workspace', async () => {
      const a = await fixture(), b = await fixture()
      const snapshot = await checkpoint(a); await checkpoint(b); await stop(a); await stop(b)
      const ids = [a.taskId, b.taskId]
      const explicit = await taskReviewSummaries({ id: owner.id, [tokenWorkspace]: a.where.id }, ids, b.where.id)
      const ambient = await actingContext.run({ userId: owner.id, tokenWorkspaceId: a.where.id },
        () => taskReviewSummaries(owner.id, ids, b.where.id))
      for (const result of [explicit, ambient]) {
        assert.equal(result.size, 1); assert.deepEqual(result.get(a.taskId)?.reviewRef, reference(snapshot)); assert.equal(result.has(b.taskId), false)
        assert.equal(result.get(a.taskId)?.permissions.canSend, false); assert.equal(result.get(a.taskId)?.permissions.canTerminal, false)
      }
      const unrelatedActor = await actingContext.run({ userId: outsider.id, tokenWorkspaceId: b.where.id },
        () => taskReviewSummaries(owner.id, ids, a.where.id))
      assert.equal(unrelatedActor.size, 1); assert.equal(unrelatedActor.has(a.taskId), true)
      assert.equal(unrelatedActor.get(a.taskId)?.permissions.canTerminal, true, 'another identity cannot attach its ambient PAT scope')
      const { citationSources } = await import('../../coordinator/store')
      const citations = await actingContext.run({ userId: owner.id, tokenWorkspaceId: a.where.id }, () => citationSources(owner.id,
        [`[[issue:${a.taskId}]]`, `[[issue:${b.taskId}]]`, `[[run:${b.runId}]]`]))
      assert.deepEqual(Object.keys(citations), [a.taskId], 'the combined direct/run Task read retains the ambient PAT workspace pin')
      assert.doesNotMatch(JSON.stringify(citations), /"codingReview"/)
    })

    await t.test('no Run, noncoding current Run and group-only Tasks have no Review entry or old-source fallback', async () => {
      const where = await workspace(), noRun = await task(where), plain = await task(where), groupOnly = await task(where)
      await extraRun({ where, taskId: plain }, owner, 0)
      await extraRun({ where, taskId: groupOnly }, owner, 0, 'group_chat')
      const previous = await fixture(where); await checkpoint(previous); await stop(previous)
      await extraRun(previous, owner, 10)
      const hints = await sourceHints([noRun, plain, groupOnly, previous.taskId])
      for (const id of [noRun, plain, groupOnly]) assert.equal(hints.get(id), false)
      assert.equal(hints.get(previous.taskId), true, 'the conservative prefilter is not current-source authority')
      const result = await taskReviewSummaries(owner.id, [noRun, plain, groupOnly, previous.taskId], where.id)
      assert.equal(result.size, 0)
      for (const id of [noRun, plain, groupOnly, previous.taskId]) assert.equal(result.get(id) ?? null, null)
    })

    await t.test('the latest unusable checkpoint never falls back to an older complete checkpoint summary', async () => {
      const f = await fixture(), good = await checkpoint(f)
      await writeFile(join(f.worktree, 'alpha.txt'), 'new checkpoint without review evidence\n')
      const captured = await takeCheckpoint({ repoPath: f.repository, worktree: f.worktree, baseCommit: f.baseSha, repoId: f.repoId })
      assert.ok(captured)
      const mask = await secretMaskerFor({ workspaceId: f.where.id, ownerId: owner.id })
      const unavailable = prepareCheckpointReview({ ...captured.checkpoint, review: undefined }, f.repoId, mask)
      assert.equal(unavailable.reason, 'missing_evidence')
      await withReviewTransaction(pool, pool, f.who, f.runId, f.repoId,
        (tx, scope) => retainCheckpointReview(tx, scope, unavailable, new Date(captured.checkpoint.takenAt), mask), { live: f.identity })
      await stop(f)
      assert.deepEqual((await pool.query('SELECT "snapshotId",reason FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1', [f.runId])).rows,
        [{ snapshotId: null, reason: 'missing_evidence' }])
      const scope = await resolveReviewScope(pool, pool, f.who, f.runId, f.repoId)
      assert.equal((await latestDiffSnapshot(pool, scope, 'checkpoint'))?.id, good.id, 'the old valid snapshot remains retained')
      for (const userId of [owner.id, member.id]) {
        const value = (await read(f, userId)).get(f.taskId); assert.ok(value)
        assert.equal(value.reviewRef, null); assert.equal(value.files, null); assert.equal(value.countsKnown, false)
        assert.equal(value.additions, null); assert.equal(value.deletions, null); assert.equal(value.checks, null)
        assert.equal(value.permissions.canSend, false)
      }
    })
  } finally {
    mock.restoreAll()
    await githubHttp.close()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
    assert.deepEqual(providerErrors, [])
  }
})
