import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { actAs } from '@/lib/acting-user'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { attachFactoryQuestionTaskLabels } from './issue-labels'
import { dbUrl, seedIssue, seedPersonalWorkspace, seedTeam, seedUser, seedWorkspace } from '../../../tests/support/workspace-admin-db'
import { measured } from '../../../tests/helpers/read-metrics'

test('attachFactoryQuestionTaskLabels batches authorized issue labels in O(1) SQL without leaking hidden or cross-workspace tasks', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const app = new Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 3000 })
  const workspace = new Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 3000 })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previous = { app: globals.mikkaPool, workspace: globals.workspacePool }
  globals.mikkaPool = app
  globals.workspacePool = workspace
  const users: string[] = []

  t.after(async () => {
    try {
      if (users.length) {
        await pool.query('delete from issues where "userId"=any($1::text[])', [users])
        await pool.query('delete from issue_prefixes where "userId"=any($1::text[])', [users])
        await workspace.query('delete from resource_access_policies where "ownerId"=any($1::text[])', [users])
        await workspace.query('delete from mikka_workspaces where "userId"=any($1::text[])', [users])
        await pool.query('delete from "user" where id=any($1::text[])', [users])
      }
    } finally {
      globals.mikkaPool = previous.app
      globals.workspacePool = previous.workspace
      await Promise.all([app.end(), workspace.end(), pool.end()])
    }
  })

  const owner = await seedUser(pool, 'fq-owner'); users.push(owner)
  const peer = await seedUser(pool, 'fq-peer'); users.push(peer)
  const outsider = await seedUser(pool, 'fq-outsider'); users.push(outsider)
  const personalWs = await seedPersonalWorkspace(workspace, owner)
  const teamWs = await seedWorkspace(workspace, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const team = await seedTeam(workspace, teamWs.id, owner)

  const seededIds: string[] = []
  const seededIdentifiers = new Map<string, string>()
  for (let i = 0; i < 12; i++) {
    const id = await seedIssue(pool, owner, teamWs.id)
    const updated = await pool.query<{ issuedIdentifier: string | null }>('update issues set title=$2 where id=$1 returning "issuedIdentifier"', [id, `Batch task ${i}`])
    seededIdentifiers.set(id, updated.rows[0]?.issuedIdentifier ?? '')
    await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, team.id, teamWs.id, owner])
    seededIds.push(id)
  }

  // Personal task in another workspace (must NOT be leaked when acting in teamWs)
  const personalTaskId = await seedIssue(pool, owner, personalWs)
  await pool.query('update issues set title=$2 where id=$1', [personalTaskId, 'Secret personal task'])

  // Deleted (tombstoned) task in teamWs (must NOT be labelled)
  const deletedTaskId = await seedIssue(pool, owner, teamWs.id)
  await pool.query('update issues set title=$2,content=$3 where id=$1', [
    deletedTaskId,
    'Tombstoned task',
    JSON.stringify({ type: 'doc', attrs: { mikka: { deletedAt: '2026-11-28T00:00:00Z' } }, content: [] }),
  ])
  await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [deletedTaskId, team.id, teamWs.id, owner])

  // Private task owned by owner inside teamWs: visible to owner, hidden from peer via resource_access_policies
  const unlinkedTaskId = await seedIssue(pool, owner, teamWs.id)
  await pool.query('update issues set title=$2 where id=$1', [unlinkedTaskId, 'Owner private task'])
  await workspace.query(
    `insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
     values('task',$1,$2,$3,'private','created')
     on conflict (kind, id) do update set visibility='private'`,
    [unlinkedTaskId, teamWs.id, owner],
  )

  const makeQuestion = (issueId: string | null) => ({
    questionId: randomUUID(),
    reference: issueId ? { binding: { issueId } } : {},
  })

  const asReader = (userId: string, workspaceId: string) => Object.defineProperties({ id: userId }, {
    [tokenWorkspace]: { value: workspaceId },
    [enterprisePrincipal]: { value: { kind: 'session', sessionId: `sess-${userId}` } },
  })

  const expectedLabel = (id: string, title: string) => [seededIdentifiers.get(id), title].filter(Boolean).join(' ')

  // 1 issue vs 12 issues execute the exact same bounded SQL statement count (O(1), zero N+1).
  const one = await actAs(asReader(owner, teamWs.id), () => measured(() => attachFactoryQuestionTaskLabels([makeQuestion(seededIds[0]!)])))
  const twelve = await actAs(asReader(owner, teamWs.id), () => measured(() => attachFactoryQuestionTaskLabels(seededIds.map(makeQuestion))))

  assert.equal(one.statements, twelve.statements, `expected O(1) SQL count: 1 issue=${one.statements}, 12 issues=${twelve.statements}`)
  assert.ok(twelve.statements <= 6, `expected bounded SQL statements <= 6, got ${twelve.statements}`)
  assert.equal(twelve.value[0]?.task, expectedLabel(seededIds[0]!, 'Batch task 0'))
  assert.equal(twelve.value[11]?.task, expectedLabel(seededIds[11]!, 'Batch task 11'))
  assert.equal(twelve.value[0]?.issueId, seededIds[0])

  // ACL isolation: peer sees team task, NEVER sees owner's private task, cross-workspace task, or deleted task.
  const peerQuestions = [
    makeQuestion(seededIds[0]!),
    makeQuestion(unlinkedTaskId),
    makeQuestion(personalTaskId),
    makeQuestion(deletedTaskId),
    makeQuestion(null),
  ]
  const peerResult = await actAs(asReader(peer, teamWs.id), () => attachFactoryQuestionTaskLabels(peerQuestions))
  assert.equal(peerResult[0]?.task, expectedLabel(seededIds[0]!, 'Batch task 0'))
  assert.equal(peerResult[1]?.task, '', 'private task title must not leak to peer')
  assert.equal(peerResult[2]?.task, '', 'cross-workspace task title must not leak')
  assert.equal(peerResult[3]?.task, '', 'tombstoned task title must not leak')
  assert.equal(peerResult[4]?.task, '')
  assert.equal(peerResult[4]?.issueId, null)

  // Outsider sees nothing in teamWs.
  const outsiderResult = await actAs(asReader(outsider, teamWs.id), () => attachFactoryQuestionTaskLabels([makeQuestion(seededIds[0]!)]))
  assert.equal(outsiderResult[0]?.task, '', 'outsider must not read team task title')
})
