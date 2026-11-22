import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Agent settings DB tests require an isolated loopback *_e2e* database')
const dbTest = available ? test : test.skip

const ownerId = `pod3-skill-owner-${randomUUID()}`
const peerId = `pod3-skill-peer-${randomUUID()}`
const workspaceId = randomUUID()
let currentActor: string | null = null

let pool: (typeof import('@/lib/db'))['pool']
let workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let skillsRoute: typeof import('@/app/api/skills/route')
let shareRoute: typeof import('@/app/api/skills/share/route')

function jsonReq(path: string, method = 'GET', body?: unknown, origin = 'https://mikka.acme.test') {
  return new Request(`https://mikka.acme.test${path}`, {
    method,
    headers: {
      origin,
      'Content-Type': 'application/json',
      cookie: 'better-auth.session_token=synthetic-browser-session',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

before(async () => {
  if (!available) return
  mock.module('@/lib/api-auth', {
    namedExports: {
      auth: { api: { getSession: async () => (currentActor ? { user: { id: currentActor } } : null) } },
    },
  })
  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  skillsRoute = await import('@/app/api/skills/route')
  shareRoute = await import('@/app/api/skills/share/route')

  for (const id of [ownerId, peerId]) {
    await pool.query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, true, now(), now())',
      [id, `${id}@acme.test`],
    )
  }
  await workspacePool.query(
    'INSERT INTO mikka_workspaces (id, "userId", name, kind) VALUES ($1, $2, \'Pod3 Team\', \'team\')',
    [workspaceId, ownerId],
  )
  await workspacePool.query(
    `INSERT INTO mikka_workspace_members ("workspaceId", "userId", name, email, role, status)
     VALUES ($1, $2, 'Owner', $3, 'admin', 'active'), ($1, $4, 'Peer', $5, 'member', 'active')`,
    [workspaceId, ownerId, `${ownerId}@acme.test`, peerId, `${peerId}@acme.test`],
  )
})

after(async () => {
  if (!available) return
  await pool.query('DELETE FROM personal_skills WHERE user_id = ANY($1)', [[ownerId, peerId]])
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id = $1', [workspaceId])
  await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [[ownerId, peerId]])
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('manual skills support offline creation, body inspection, owner-only editing, workspace sharing, toggle, and deletion', async () => {
  currentActor = ownerId

  // Invalid inputs rejected with 400
  for (const bad of [
    { name: 'Bad Slug', slug: 'bad slug!', instructions: 'Valid instructions' },
    { name: '', slug: 'valid-slug', instructions: 'Valid instructions' },
    { name: 'Valid Name', slug: 'valid-slug', instructions: '   ' },
    { name: 'Injected', slug: 'valid-slug', instructions: 'Valid', userId: peerId },
  ]) {
    const res = await skillsRoute.POST(jsonReq('/api/skills', 'POST', bad))
    assert.equal(res.status, 400)
  }

  // Create manual skill offline (no GitHub network call)
  const createRes = await skillsRoute.POST(
    jsonReq('/api/skills', 'POST', {
      name: 'Release Checklist',
      slug: 'release-checklist',
      instructions: 'Run affected tests before promoting release.',
    }),
  )
  assert.equal(createRes.status, 201)
  const created = (await createRes.json()).skill
  assert.equal(created.name, 'Release Checklist')
  assert.equal(created.source, 'local/manual')
  assert.equal(created.slug, 'release-checklist')
  assert.equal(created.sourceKind, 'self-improvement')
  assert.equal(created.enabled, true)

  // Inspect body as owner; peer receives 404
  const getRes = await skillsRoute.GET(jsonReq(`/api/skills?id=${created.id}`))
  assert.equal(getRes.status, 200)
  const detail = (await getRes.json()).skill
  assert.match(detail.body, /name: Release Checklist/)
  assert.match(detail.body, /Run affected tests before promoting release\./)

  currentActor = peerId
  assert.equal((await skillsRoute.GET(jsonReq(`/api/skills?id=${created.id}`))).status, 404)
  assert.equal(
    (await skillsRoute.PATCH(jsonReq('/api/skills', 'PATCH', { id: created.id, name: 'Hijack', instructions: 'Nope' }))).status,
    404,
  )

  // Share to team workspace as owner
  currentActor = ownerId
  const shareRes = await shareRoute.POST(jsonReq('/api/skills/share', 'POST', { workspaceId, skillId: created.id, shared: true }))
  assert.equal(shareRes.status, 200)
  const sharedRows = await pool.query(
    'SELECT 1 FROM personal_skill_workspace_shares WHERE skill_id = $1 AND workspace_id = $2',
    [created.id, workspaceId],
  )
  assert.equal(sharedRows.rowCount, 1)

  // Edit manual skill name & instructions
  const editRes = await skillsRoute.PATCH(
    jsonReq('/api/skills', 'PATCH', {
      id: created.id,
      name: 'Release & Rollback Checklist',
      instructions: 'Run affected tests and verify rollback script.',
    }),
  )
  assert.equal(editRes.status, 200)
  const edited = (await editRes.json()).skill
  assert.equal(edited.name, 'Release & Rollback Checklist')
  assert.notEqual(edited.sha256, created.sha256)
  assert.equal(edited.sourceRevision, edited.sha256)

  // GitHub-sourced skills cannot be rewritten via manual edit
  const ghBody = '---\nname: gh-skill\n---\n\nPinned upstream body\n'
  const ghSha = createHash('sha256').update(ghBody, 'utf8').digest('hex')
  const ghId = randomUUID()
  await pool.query(
    `INSERT INTO personal_skills (id, user_id, name, source, slug, source_kind, source_revision, source_path, body, sha256)
     VALUES ($1, $2, 'gh-skill', 'acme/skills', 'gh-skill', 'skills.sh', $3, 'SKILL.md', $4, $3)`,
    [ghId, ownerId, ghSha, ghBody],
  )
  const ghEditRes = await skillsRoute.PATCH(
    jsonReq('/api/skills', 'PATCH', { id: ghId, instructions: 'Attempt to mutate pinned GitHub skill' }),
  )
  assert.equal(ghEditRes.status, 400)

  // Toggle enabled OFF then delete
  const toggleRes = await skillsRoute.PATCH(jsonReq('/api/skills', 'PATCH', { id: created.id, enabled: false }))
  assert.equal(toggleRes.status, 200)
  assert.equal((await toggleRes.json()).skill.enabled, false)

  const delRes = await skillsRoute.DELETE(jsonReq('/api/skills', 'DELETE', { id: created.id }))
  assert.equal(delRes.status, 200)
  const afterDel = await pool.query('SELECT 1 FROM personal_skills WHERE id = $1', [created.id])
  assert.equal(afterDel.rowCount, 0)
})
