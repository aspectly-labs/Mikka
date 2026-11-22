import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { provisionWorkspacePlan } from '../lib/governance/provisioning'

let currentActor: { id: string; workspaceId?: string } | null = null
mock.module('@/lib/auth', {
  namedExports: {
    MOBILE_APP_ORIGIN: 'mikka://',
    githubEnabled: false,
    googleEnabled: false,
    authBaseURL: 'https://mikka.test',
    oauthCallbackBaseURL: 'https://mikka.test',
    githubSignInEnabled: async () => false,
    auth: {
      api: {
        getSession: async (options?: { query?: { disableCookieCache?: boolean } }) => {
          if (options?.query) assert.equal(options.query.disableCookieCache, true)
          return currentActor
            ? {
                user: { id: currentActor.id, name: currentActor.id, email: `${currentActor.id}@example.invalid` },
                session: { id: 'wsg-settings-session' },
                ...(currentActor.workspaceId ? { tokenWorkspaceId: currentActor.workspaceId } : {}),
              }
            : null
        },
      },
    },
  },
})
mock.module('@/lib/due-timer', {
  namedExports: {
    armDueTimerAfterCommit: () => {},
    armDueTimerSoon: () => {},
  },
})

test('WS-G device policy/repositories, billing settings, ops metrics and usage environment preserve strict tenant and owner boundaries on PG17', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const previousEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  const [
    { pool },
    { workspacePool },
    devicePolicyRoute,
    deviceReposRoute,
    billingSettingsRoute,
    billingRoute,
    opsMetricsRoute,
    usageRoute,
    { localComputerAuthority },
  ] = await Promise.all([
    import('../lib/db'),
    import('../lib/workspace-db'),
    import('../app/api/devices/[deviceId]/policy/route'),
    import('../app/api/devices/[deviceId]/repositories/route'),
    import('../app/api/workspaces/[workspaceId]/billing/settings/route'),
    import('../app/api/workspaces/[workspaceId]/billing/route'),
    import('../app/api/workspaces/[workspaceId]/ops-metrics/route'),
    import('../app/api/workspaces/[workspaceId]/governance/usage/route'),
    import('../lib/computer/local-authority'),
  ])

  const userA = await seedUser(pool, 'wsg-owner-a')
  const adminA = await seedUser(pool, 'wsg-admin-a')
  const memberA = await seedUser(pool, 'wsg-member-a')
  const foreignAdmin = await seedUser(pool, 'wsg-foreign-admin')
  const allUsers = [userA, adminA, memberA, foreignAdmin]

  // Workspace A: userA (owner + admin), adminA (admin), memberA (member).
  const workspaceA = await seedWorkspace(pool, userA, [
    { userId: userA, role: 'admin' },
    { userId: adminA, role: 'admin' },
    { userId: memberA, role: 'member' },
  ])
  // Unbound shared workspace: userA is a member and foreignAdmin is admin,
  // proving an admin of an unrelated workspace (even one userA belongs to!)
  // CANNOT toggle userA's personal unbound device.
  const workspaceUnbound = await seedWorkspace(pool, foreignAdmin, [
    { userId: foreignAdmin, role: 'admin' },
    { userId: userA, role: 'member' },
  ])
  // Workspace B: userA is ALSO admin here, proving Workspace B channels/storage/queues/usage
  // NEVER bleed into Workspace A even when the same user owns rows in both workspaces.
  const workspaceB = await seedWorkspace(pool, userA, [
    { userId: userA, role: 'admin' },
    { userId: foreignAdmin, role: 'admin' },
  ])
  const allWorkspaces = [workspaceA.id, workspaceUnbound.id, workspaceB.id]

  const personalDeviceA = randomUUID()
  const boundDeviceA = randomUUID()
  const boundDeviceB = randomUUID()
  await pool.query(
    `INSERT INTO devices (id, "ownerId", name, kind, enabled, "computerUseEnabled", "maxConcurrentRuns", "computerUse", "sessionOpenedAt")
     VALUES
       ($1, $4, 'Personal Laptop A', 'local', true, true, 3, '{"installed":true,"version":"1.2.0"}'::jsonb, now()),
       ($2, $4, 'Workspace A Runner', 'local', true, true, 4, '{"installed":true,"version":"1.2.0"}'::jsonb, now()),
       ($3, $4, 'Workspace B Runner', 'local', true, true, 2, '{"installed":false,"version":null}'::jsonb, now())`,
    [personalDeviceA, boundDeviceA, boundDeviceB, userA],
  )

  const projectA = randomUUID()
  const projectB = randomUUID()
  await workspacePool.query(
    `INSERT INTO workspace_projects (id, "userId", "workspaceId", name, summary, description, status, priority, lead, team, "startDate", "targetDate", "issueIds", revision)
     VALUES
       ($1, $3, $4, 'Proj A', '', '', 'planned', 'none', '', '', '', '', '[]', 1),
       ($2, $3, $5, 'Proj B', '', '', 'planned', 'none', '', '', '', '', '[]', 1)`,
    [projectA, projectB, userA, workspaceA.id, workspaceB.id],
  )
  await pool.query(
    `INSERT INTO resource_access_policies (kind, id, "workspaceId", "ownerId", visibility, provenance)
     VALUES
       ('project', $1, $3, $5, 'shared', 'created'),
       ('project', $2, $4, $5, 'shared', 'created')`,
    [projectA, projectB, workspaceA.id, workspaceB.id, userA],
  )
  // Bind boundDeviceA ONLY to workspaceA, and boundDeviceB ONLY to workspaceB; personalDeviceA stays unbound.
  await pool.query(
    `INSERT INTO device_project_checkouts ("ownerId", "workspaceId", "projectId", "deviceId", root)
     VALUES
       ($1, $2, $3, $4, '/work/ws-a'),
       ($1, $5, $6, $7, '/work/ws-b')`,
    [userA, workspaceA.id, projectA, boundDeviceA, workspaceB.id, projectB, boundDeviceB],
  )

  const createdSchedules: string[] = []
  const createdSlackInstallations: string[] = []
  const createdArtifacts: string[] = []

  t.after(async () => {
    currentActor = null
    if (previousEdition === undefined) delete process.env.MIKKA_EDITION
    else process.env.MIKKA_EDITION = previousEdition
    try {
      if (createdSchedules.length) {
        await pool.query('DELETE FROM user_schedules WHERE id = ANY($1::uuid[])', [createdSchedules])
      }
      if (createdSlackInstallations.length) {
        await pool.query('DELETE FROM mikka_slack_installations WHERE id = ANY($1::uuid[])', [createdSlackInstallations])
      }
      if (createdArtifacts.length) {
        await pool.query('DELETE FROM artifacts WHERE id = ANY($1::uuid[])', [createdArtifacts])
      }
      await pool.query('DELETE FROM telegram_conversations WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM bot_subagents WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM run_publications WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM run_checkpoints WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM hosted_usage WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM workspace_billing WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM workspace_audit_events WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM workspace_audit_outbox WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM agents WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM bots WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM device_project_checkouts WHERE "ownerId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM issues WHERE "userId" = ANY($1::text[])', [allUsers])
      await pool.query('DELETE FROM resource_access_policies WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await workspacePool.query('DELETE FROM mikka_workspace_entitlements WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await workspacePool.query('DELETE FROM workspace_environments WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await workspacePool.query('DELETE FROM workspace_projects WHERE "workspaceId" = ANY($1::uuid[])', [allWorkspaces])
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id = ANY($1::uuid[])', [allWorkspaces])
      await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [allUsers])
    } finally {
      await Promise.all([pool.end(), workspacePool.end()])
    }
  })

  const jsonReq = (url: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) =>
    new Request(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: 'https://mikka.test',
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  await t.test('device policy enforces owner or bound-workspace-admin authority, binary computerUseEnabled and localComputerAuthority revocation', async () => {
    const policyCtx = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) })

    // 1. Mandatory rejections: unauthenticated, member, foreign admin, and admin of unbound workspace
    currentActor = null
    assert.equal(
      (await devicePolicyRoute.GET(jsonReq(`https://mikka.test/api/devices/${personalDeviceA}/policy`), policyCtx(personalDeviceA))).status,
      401,
    )
    assert.equal(
      (await devicePolicyRoute.PATCH(
        jsonReq(`https://mikka.test/api/devices/${personalDeviceA}/policy`, 'PATCH', { schedulingEnabled: false }),
        policyCtx(personalDeviceA),
      )).status,
      401,
    )

    // Non-admin member of Workspace A cannot read or modify even boundDeviceA
    currentActor = { id: memberA }
    assert.equal(
      (await devicePolicyRoute.GET(
        jsonReq(`https://mikka.test/api/devices/${boundDeviceA}/policy?workspaceId=${workspaceA.id}`),
        policyCtx(boundDeviceA),
      )).status,
      403,
    )
    assert.equal(
      (await devicePolicyRoute.PATCH(
        jsonReq(`https://mikka.test/api/devices/${boundDeviceA}/policy?workspaceId=${workspaceA.id}`, 'PATCH', { computerUseEnabled: false }),
        policyCtx(boundDeviceA),
      )).status,
      403,
    )

    // Admin of workspaceUnbound (where userA IS a member, but personalDeviceA and boundDeviceA are NOT bound!)
    currentActor = { id: foreignAdmin }
    for (const targetDevice of [personalDeviceA, boundDeviceA]) {
      assert.equal(
        (await devicePolicyRoute.GET(
          jsonReq(`https://mikka.test/api/devices/${targetDevice}/policy?workspaceId=${workspaceUnbound.id}`),
          policyCtx(targetDevice),
        )).status,
        403,
      )
      assert.equal(
        (await devicePolicyRoute.PATCH(
          jsonReq(`https://mikka.test/api/devices/${targetDevice}/policy?workspaceId=${workspaceUnbound.id}`, 'PATCH', { schedulingEnabled: false }),
          policyCtx(targetDevice),
        )).status,
        403,
      )
    }

    // Even adminA of Workspace A CANNOT touch userA's personalDeviceA (not bound to Workspace A!)
    currentActor = { id: adminA }
    assert.equal(
      (await devicePolicyRoute.PATCH(
        jsonReq(`https://mikka.test/api/devices/${personalDeviceA}/policy?workspaceId=${workspaceA.id}`, 'PATCH', { schedulingEnabled: false }),
        policyCtx(personalDeviceA),
      )).status,
      403,
    )

    // 2. Bound workspace admin CAN read & toggle boundDeviceA when workspaceId is provided
    const adminRead = await devicePolicyRoute.GET(
      jsonReq(`https://mikka.test/api/devices/${boundDeviceA}/policy?workspaceId=${workspaceA.id}`),
      policyCtx(boundDeviceA),
    )
    assert.equal(adminRead.status, 200)
    assert.equal(adminRead.headers.get('cache-control'), 'private, no-store')
    const initialPolicy = await adminRead.json()
    assert.equal(initialPolicy.source, 'device')
    assert.equal(initialPolicy.schedulingEnabled, true)
    assert.equal(initialPolicy.computerUseEnabled, true)
    assert.equal(initialPolicy.computerUse.mode, 'allow')
    assert.deepEqual(initialPolicy.migration, {
      available: false,
      reason: 'machine_migration_not_supported',
      preserves: ['repository_checkpoint'],
      excludes: ['process_memory', 'native_session', 'ignored_files', 'credentials'],
    })

    // Reject 'ask' tier with 400
    assert.equal(
      (await devicePolicyRoute.PATCH(
        jsonReq(`https://mikka.test/api/devices/${boundDeviceA}/policy?workspaceId=${workspaceA.id}`, 'PATCH', { computerUseEnabled: 'ask' }),
        policyCtx(boundDeviceA),
      )).status,
      400,
    )

    const adminPatch = await devicePolicyRoute.PATCH(
      jsonReq(`https://mikka.test/api/devices/${boundDeviceA}/policy?workspaceId=${workspaceA.id}`, 'PATCH', { schedulingEnabled: false }),
      policyCtx(boundDeviceA),
    )
    assert.equal(adminPatch.status, 200)
    const afterAdminPatch = await adminPatch.json()
    assert.equal(afterAdminPatch.schedulingEnabled, false)
    assert.equal(afterAdminPatch.scheduling.availableSlots, 0)

    // 3. Owner toggles computerUseEnabled -> enforces localComputerAuthority & stops active machineAuthority run
    currentActor = { id: userA }
    const botId = await seedBot(pool, workspaceA.id, userA)
    const agentId = await seedAgent(pool, userA)
    const activeRunId = await seedRun(pool, {
      userId: userA,
      agentId,
      workspaceId: workspaceA.id,
      botId,
      status: 'running',
      startedAt: new Date(),
    })
    await pool.query(
      `UPDATE agent_runs
       SET "deviceId"=$2, "machineAuthority"=true, "leaseExpiresAt"=now() + interval '10 minutes'
       WHERE id=$1`,
      [activeRunId, personalDeviceA],
    )
    await pool.query(
      `INSERT INTO workspace_computer_policies ("workspaceId", permission, version)
       VALUES ($1, 'allow', 2)
       ON CONFLICT ("workspaceId") DO UPDATE SET permission='allow', version=2`,
      [workspaceA.id],
    )
    const grantBefore = await localComputerAuthority(pool, userA, personalDeviceA, activeRunId)
    assert.equal(grantBefore?.permission, 'allow')

    const disableComp = await devicePolicyRoute.PATCH(
      jsonReq(`https://mikka.test/api/devices/${personalDeviceA}/policy`, 'PATCH', { computerUseEnabled: false }),
      policyCtx(personalDeviceA),
    )
    assert.equal(disableComp.status, 200)
    const disabledView = await disableComp.json()
    assert.equal(disabledView.computerUseEnabled, false)
    assert.equal(disabledView.computerUse.mode, 'deny')

    // localComputerAuthority immediately denies when computerUseEnabled=false, and active run received stopRequestedAt
    assert.equal(await localComputerAuthority(pool, userA, personalDeviceA, activeRunId), null)
    const stoppedRow = (await pool.query<{ stopRequestedAt: Date | null }>(
      'SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',
      [activeRunId],
    )).rows[0]
    assert.ok(stoppedRow?.stopRequestedAt !== null, 'disabling computerUseEnabled stops active machine-authority runs on that device')
    await pool.query(`UPDATE agent_runs SET status='stopped', "finishedAt"=now() WHERE id=$1`, [activeRunId])
  })

  await t.test('device repositories CRUD enforces strict device-owner-only authorization and active-run protection', async () => {
    const repoCtx = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) })
    const url = `https://mikka.test/api/devices/${boundDeviceA}/repositories`

    // Unauthenticated, member, foreign admin, AND even bound-workspace adminA are ALL rejected!
    currentActor = null
    assert.equal((await deviceReposRoute.GET(jsonReq(url), repoCtx(boundDeviceA))).status, 401)

    for (const nonOwner of [memberA, foreignAdmin, adminA]) {
      currentActor = { id: nonOwner }
      assert.equal((await deviceReposRoute.GET(jsonReq(url), repoCtx(boundDeviceA))).status, 403)
      assert.equal(
        (await deviceReposRoute.PUT(jsonReq(url, 'PUT', { repository: 'aspectly-labs/Mikka', baseBranch: 'main' }), repoCtx(boundDeviceA))).status,
        403,
      )
    }

    // Owner CRUD lifecycle
    currentActor = { id: userA }
    const createdRes = await deviceReposRoute.PUT(
      jsonReq(url, 'PUT', {
        repository: 'aspectly-labs/Mikka',
        localPath: '/Users/alice/src/mikka',
        baseBranch: 'main',
        verifyCommand: 'pnpm test:unit',
      }),
      repoCtx(boundDeviceA),
    )
    assert.equal(createdRes.status, 200)
    const created = await createdRes.json()
    assert.equal(created.repoKey, 'v2/github.com/aspectly-labs/mikka')
    assert.equal(created.localPath, '/Users/alice/src/mikka')
    assert.equal(created.baseBranch, 'main')
    assert.equal(created.verifyCommand, 'pnpm test:unit')

    const patchedRes = await deviceReposRoute.PATCH(
      jsonReq(url, 'PATCH', {
        id: created.id,
        baseBranch: 'develop',
        verifyCommand: 'pnpm check:migrations',
      }),
      repoCtx(boundDeviceA),
    )
    assert.equal(patchedRes.status, 200)
    const patched = await patchedRes.json()
    assert.equal(patched.baseBranch, 'develop')
    assert.equal(patched.verifyCommand, 'pnpm check:migrations')
    assert.equal(patched.localPath, '/Users/alice/src/mikka')

    const listRes = await deviceReposRoute.GET(jsonReq(url), repoCtx(boundDeviceA))
    assert.equal(listRes.status, 200)
    const listed = await listRes.json()
    assert.equal(listed.source, 'device')
    assert.equal(listed.repositories.length, 1)

    // Non-owner cannot delete User A's repo
    currentActor = { id: adminA }
    assert.equal((await deviceReposRoute.DELETE(jsonReq(`${url}?id=${created.id}`, 'DELETE'), repoCtx(boundDeviceA))).status, 403)

    // Active run blocks deletion with 409
    currentActor = { id: userA }
    const agentId = await seedAgent(pool, userA)
    const queuedRun = await seedRun(pool, { userId: userA, agentId, workspaceId: workspaceA.id, status: 'queued' })
    await pool.query('UPDATE agent_runs SET "deviceId"=$2, "deviceRepoId"=$3 WHERE id=$1', [queuedRun, boundDeviceA, created.id])
    assert.equal(
      (await deviceReposRoute.DELETE(jsonReq(`${url}?id=${created.id}`, 'DELETE'), repoCtx(boundDeviceA))).status,
      409,
    )
    await pool.query(`UPDATE agent_runs SET status='succeeded', "finishedAt"=now() WHERE id=$1`, [queuedRun])

    const delRes = await deviceReposRoute.DELETE(jsonReq(`${url}?id=${created.id}`, 'DELETE'), repoCtx(boundDeviceA))
    assert.equal(delRes.status, 200)
    assert.deepEqual(await delRes.json(), {
      deleted: true,
      id: created.id,
      repoKey: 'v2/github.com/aspectly-labs/mikka',
    })
  })

  await t.test('billing settings expose stripe_portal receipt ownership, persist disabled auto-recharge limits, refuse enabled=true with provider_unsupported and reject non-owners/non-admins', async () => {
    const wsCtx = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) })
    const url = (workspaceId = workspaceA.id) => `https://mikka.test/api/workspaces/${workspaceId}/billing/settings`

    currentActor = null
    assert.equal((await billingSettingsRoute.GET(jsonReq(url()), wsCtx(workspaceA.id))).status, 401)

    currentActor = { id: memberA }
    assert.equal((await billingSettingsRoute.GET(jsonReq(url()), wsCtx(workspaceA.id))).status, 403)

    currentActor = { id: foreignAdmin }
    assert.equal((await billingSettingsRoute.GET(jsonReq(url()), wsCtx(workspaceA.id))).status, 403)
    assert.equal(
      (await billingSettingsRoute.PUT(
        jsonReq(url(), 'PUT', {
          enabled: false,
          expectedRevision: 0,
          thresholdPoints: 100,
          amountPoints: 1000,
          monthlyCapPoints: 3000,
        }),
        wsCtx(workspaceA.id),
      )).status,
      403,
    )

    // Non-owner adminA can read billing settings (canManageRecharge: false), but cannot mutate auto-recharge!
    currentActor = { id: adminA }
    const adminSettingsRes = await billingSettingsRoute.GET(jsonReq(url()), wsCtx(workspaceA.id))
    assert.equal(adminSettingsRes.status, 200)
    const adminSettings = await adminSettingsRes.json()
    assert.equal(adminSettings.canManageRecharge, false)
    assert.equal(adminSettings.receiptsManagedBy, 'stripe_portal')
    assert.equal(adminSettings.source, 'provider')
    assert.deepEqual(adminSettings.receipts, { receiptsManagedBy: 'stripe_portal', source: 'provider' })
    assert.equal(
      (await billingSettingsRoute.PUT(
        jsonReq(url(), 'PUT', {
          enabled: false,
          expectedRevision: 0,
          thresholdPoints: 100,
          amountPoints: 1000,
          monthlyCapPoints: 3000,
        }),
        wsCtx(workspaceA.id),
      )).status,
      403,
    )

    // Owner saves policy parameters with enabled=false, then enabled=true returns honest provider_unsupported 409
    currentActor = { id: userA }
    const saveDisabled = await billingSettingsRoute.PUT(
      jsonReq(url(), 'PUT', {
        enabled: false,
        expectedRevision: 0,
        thresholdPoints: 200,
        amountPoints: 2500,
        monthlyCapPoints: 5000,
      }),
      wsCtx(workspaceA.id),
    )
    assert.equal(saveDisabled.status, 200)
    const savedBody = await saveDisabled.json()
    assert.equal(savedBody.receiptsManagedBy, 'stripe_portal')
    assert.deepEqual(savedBody.autoRecharge, {
      state: 'provider_unsupported',
      enabled: false,
      provider: 'stripe_managed_payments',
      thresholdPoints: 200,
      amountPoints: 2500,
      monthlyCapPoints: 5000,
      revision: 1,
    })

    const enableAttempt = await billingSettingsRoute.PATCH(
      jsonReq(url(), 'PATCH', {
        enabled: true,
        consent: true,
        expectedRevision: 1,
        thresholdPoints: 200,
        amountPoints: 2500,
        monthlyCapPoints: 5000,
      }),
      wsCtx(workspaceA.id),
    )
    assert.equal(enableAttempt.status, 409)
    assert.deepEqual(await enableAttempt.json(), {
      error: 'billingAutoRechargeUnavailable',
      state: 'provider_unsupported',
      provider: 'stripe_managed_payments',
    })

    // Main /billing view also surfaces receipts: { receiptsManagedBy: 'stripe_portal', source: 'provider' }
    const fullBillingRes = await billingRoute.GET(
      jsonReq(`https://mikka.test/api/workspaces/${workspaceA.id}/billing`),
      wsCtx(workspaceA.id),
    )
    assert.equal(fullBillingRes.status, 200)
    const fullBilling = await fullBillingRes.json()
    assert.deepEqual(fullBilling.billing.receipts, { receiptsManagedBy: 'stripe_portal', source: 'provider' })
  })

  await t.test('workspace ops-metrics enforces admin-only access and strict tenant isolation across channels, storage and queues', async () => {
    const wsCtx = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) })
    const getMetrics = (workspaceId: string) =>
      opsMetricsRoute.GET(jsonReq(`https://mikka.test/api/workspaces/${workspaceId}/ops-metrics`), wsCtx(workspaceId))

    // Reject unauthenticated, non-admin member, outsider, and cross-workspace PAT
    currentActor = null
    assert.equal((await getMetrics(workspaceA.id)).status, 403)
    currentActor = { id: memberA }
    assert.equal((await getMetrics(workspaceA.id)).status, 403)
    currentActor = { id: foreignAdmin }
    assert.equal((await getMetrics(workspaceA.id)).status, 403)
    currentActor = { id: userA, workspaceId: workspaceB.id }
    assert.equal((await getMetrics(workspaceA.id)).status, 403)

    // Seed distinct rows in Workspace A and heavy noise in Workspace B (owned by the SAME userA!)
    const botA = await seedBot(pool, workspaceA.id, userA)
    const botB1 = await seedBot(pool, workspaceB.id, userA)
    const botB2 = await seedBot(pool, workspaceB.id, userA)
    const agentA = await seedAgent(pool, userA)
    const issueA = await seedIssue(pool, userA, workspaceA.id)
    const issueB = await seedIssue(pool, userA, workspaceB.id)

    // Slack installations + bindings
    const slackA = randomUUID(), slackB = randomUUID()
    createdSlackInstallations.push(slackA, slackB)
    await pool.query(
      `INSERT INTO mikka_slack_installations (id, workspace_id, app_id, team_id, team_name, bot_user_id, installed_by, bot_secret, scopes)
       VALUES
         ($1, $3, 'A1', 'T_WSA', 'Team A', 'U_BOT_A', $5, '{}'::jsonb, ARRAY['chat:write']),
         ($2, $4, 'A1', 'T_WSB', 'Team B', 'U_BOT_B', $5, '{}'::jsonb, ARRAY['chat:write'])`,
      [slackA, slackB, workspaceA.id, workspaceB.id, userA],
    )
    await pool.query(
      `INSERT INTO mikka_slack_members (installation_id, user_id, slack_user_id, enabled)
       VALUES ($1, $3, 'U_A1', true), ($2, $3, 'U_B1', true), ($2, $4, 'U_B2', true)`,
      [slackA, slackB, userA, foreignAdmin],
    )

    // Telegram task bindings
    await pool.query(
      `INSERT INTO telegram_conversations ("threadId", "userId", "issueId", "draftDescription")
       VALUES ('tg-a-1', $1, $2, ''), ('tg-b-1', $1, $3, ''), ('tg-b-2', $1, $3, '')`,
      [userA, issueA, issueB],
    )

    // Artifacts + versions
    const artifactA = randomUUID(), artifactB = randomUUID()
    createdArtifacts.push(artifactA, artifactB)
    await pool.query(
      `INSERT INTO artifacts (id, "userId", "workspaceId", kind, title, "latestVersion")
       VALUES ($1, $3, $4, 'markdown', 'Doc A', 2), ($2, $3, $5, 'markdown', 'Doc B', 1)`,
      [artifactA, artifactB, userA, workspaceA.id, workspaceB.id],
    )
    await pool.query(
      `INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", sha256, size, "authorName")
       VALUES
         ($1, $4, 1, 'k/a1', '00', 120, 'Agent'),
         ($2, $4, 2, 'k/a2', '01', 280, 'Agent'),
         ($3, $5, 1, 'k/b1', '02', 99999, 'Agent')`,
      [randomUUID(), randomUUID(), randomUUID(), artifactA, artifactB],
    )

    // Runs, checkpoints, publications, schedules, subagents
    const queuedA = await seedRun(pool, { userId: userA, agentId: agentA, workspaceId: workspaceA.id, issueId: issueA, status: 'queued' })
    const runningA = await seedRun(pool, { userId: userA, agentId: agentA, workspaceId: workspaceA.id, issueId: issueA, status: 'running', startedAt: new Date() })
    const queuedB1 = await seedRun(pool, { userId: userA, agentId: agentA, workspaceId: workspaceB.id, issueId: issueB, status: 'queued' })
    const queuedB2 = await seedRun(pool, { userId: userA, agentId: agentA, workspaceId: workspaceB.id, issueId: issueB, status: 'queued' })

    await pool.query(
      `INSERT INTO run_checkpoints ("runId", "userId", "baseCommit", patch, files, "takenAt")
       VALUES
         ($1, $3, $4, $5, 1, now()),
         ($2, $3, $4, $6, 4, now())`,
      [runningA, queuedB1, userA, 'b'.repeat(40), Buffer.alloc(64, 1), Buffer.alloc(4096, 2)],
    )
    await pool.query(
      `INSERT INTO run_publications ("runId", "userId", "issueId", "remoteUrl", "remoteKey", status)
       VALUES
         ($1, $4, $5, 'https://github.com/acme/a.git', 'v2/github.com/acme/a', 'pending'),
         ($2, $4, $6, 'https://github.com/acme/b.git', 'v2/github.com/acme/b', 'pending'),
         ($3, $4, $6, 'https://github.com/acme/b2.git', 'v2/github.com/acme/b2', 'awaiting_approval')`,
      [runningA, queuedB1, queuedB2, userA, issueA, issueB],
    )

    const schedA = randomUUID(), schedB = randomUUID()
    createdSchedules.push(schedA, schedB)
    await pool.query(
      `INSERT INTO user_schedules (id, owner_id, workspace_id, bot_id, request_id, request_origin, definition, request_definition, status)
       VALUES
         ($1, $3, $4, $5, 'req-a', 'page', '{}'::jsonb, '{}'::jsonb, 'active'),
         ($2, $3, $6, $7, 'req-b', 'page', '{}'::jsonb, '{}'::jsonb, 'active')`,
      [schedA, schedB, userA, workspaceA.id, botA, workspaceB.id, botB1],
    )
    await pool.query(
      `INSERT INTO schedule_occurrences (id, schedule_id, version, due_at, definition, status, execution_decision, operation_id, next_retry_at)
       VALUES
         ($1, $4, 1, now(), '{}'::jsonb, 'pending', 'execute', $6, now()),
         ($2, $5, 1, now(), '{}'::jsonb, 'pending', 'execute', $7, now()),
         ($3, $5, 1, now() + interval '1 minute', '{}'::jsonb, 'running', 'execute', $8, now())`,
      [randomUUID(), randomUUID(), randomUUID(), schedA, schedB, randomUUID(), randomUUID(), randomUUID()],
    )

    await pool.query(
      `INSERT INTO bot_subagents (id, "workspaceId", "ownerId", "botId", task, status)
       VALUES
         ($1, $4, $6, $7, 'check docs', 'queued'),
         ($2, $5, $6, $8, 'foreign queued', 'queued'),
         ($3, $5, $6, $9, 'foreign running', 'running')`,
      [randomUUID(), randomUUID(), randomUUID(), workspaceA.id, workspaceB.id, userA, botA, botB1, botB2],
    )

    currentActor = { id: userA }
    const resA = await getMetrics(workspaceA.id)
    assert.equal(resA.status, 200)
    assert.equal(resA.headers.get('cache-control'), 'private, no-store')
    const metricsA = await resA.json()
    // boundDeviceA had schedulingEnabled set to false earlier, but its gateway session is still open!
    assert.deepEqual(metricsA.channels, {
      onlineDevices: 1,
      boundDevices: 1,
      slackInstallations: 1,
      slackBindings: 1,
      telegramBindings: 1,
      activeBots: 2, // 1 bot from policy test + 1 botA here; never includes botB1/botB2!
    })
    assert.deepEqual(metricsA.storage, {
      artifacts: { count: 1, versions: 2, bytes: 400 },
      checkpoints: { count: 1, bytes: 64 },
      totalBytes: 464,
    })
    assert.deepEqual(metricsA.queues, {
      queuedRuns: 1,
      runningRuns: 1,
      pendingPublications: 1,
      pendingScheduleOccurrences: 1,
      queuedSubagents: 1,
      runningSubagents: 0,
    })
    void queuedA
  })

  await t.test('governance usage JSON and CSV support groupBy=environment and reject non-admin/cross-workspace callers', async () => {
    await provisionWorkspacePlan(
      pool,
      { workspaceId: workspaceA.id, plan: 'pro', expectedPlan: 'free', source: 'cloud', seatLimit: 20, expiresAt: null, reason: 'evaluation', operator: 'wsg-fixture' },
      { mode: 'cloud', apply: true },
    )
    const envProd = randomUUID()
    const envStaging = randomUUID()
    const envForeign = randomUUID()
    await workspacePool.query(
      `INSERT INTO workspace_environments (id, "workspaceId", name, configuration, "createdBy", "updatedBy")
       VALUES
         ($1, $4, 'Production Env', '{}'::jsonb, $6, $6),
         ($2, $4, 'Staging Env', '{}'::jsonb, $6, $6),
         ($3, $5, 'Foreign Secret Env', '{}'::jsonb, $6, $6)`,
      [envProd, envStaging, envForeign, workspaceA.id, workspaceB.id, userA],
    )
    const botProd = await seedBot(pool, workspaceA.id, userA)
    await pool.query('UPDATE bots SET "environmentId"=$2 WHERE id=$1', [botProd, envProd])
    const agent = await seedAgent(pool, userA)
    const runViaBot = await seedRun(pool, { userId: userA, agentId: agent, workspaceId: workspaceA.id, botId: botProd })
    const runViaTaskEnv = await seedRun(pool, { userId: userA, agentId: agent, workspaceId: workspaceA.id })
    await pool.query(
      `UPDATE agent_runs SET "agentDefinition"=$2::jsonb WHERE id=$1`,
      [runViaTaskEnv, JSON.stringify({ projectExecution: { workspaceId: workspaceA.id, environment: { id: envStaging, revision: 1 } } })],
    )
    const runForeign = await seedRun(pool, { userId: userA, agentId: agent, workspaceId: workspaceB.id })
    await pool.query(
      `UPDATE agent_runs SET "agentDefinition"=$2::jsonb WHERE id=$1`,
      [runForeign, JSON.stringify({ projectExecution: { workspaceId: workspaceB.id, environment: { id: envForeign, revision: 1 } } })],
    )

    await pool.query(
      `INSERT INTO hosted_usage (id, "workspaceId", model, state, "usageRunId", "costMicroUsd", "freeMicroUsd", "purchasedMicroUsd", "inputTokens", "outputTokens", "createdAt")
       VALUES
         ($1, $5, 'gpt-6-luna', 'settled', $7, 300, 0, 300, 120, 40, '2026-11-15T12:00:00Z'),
         ($2, $5, 'gpt-6-luna', 'settled', $8, 500, 0, 500, 200, 80, '2026-11-15T12:00:00Z'),
         ($3, $5, 'gpt-6-luna', 'settled', NULL, 100, 0, 100, 50, 10, '2026-11-15T12:00:00Z'),
         ($4, $6, 'gpt-6-luna', 'settled', $9, 9999, 0, 9999, 999, 999, '2026-11-15T12:00:00Z')`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), workspaceA.id, workspaceB.id, runViaBot, runViaTaskEnv, runForeign],
    )

    const usageCtx = (workspaceId = workspaceA.id) => ({ params: Promise.resolve({ workspaceId }) })
    const callUsage = (query: string, workspaceId = workspaceA.id) =>
      usageRoute.GET(jsonReq(`https://mikka.test/api/workspaces/${workspaceId}/governance/usage${query}`), usageCtx(workspaceId))

    // Reject non-admin member & cross-workspace admin
    currentActor = { id: memberA }
    assert.equal((await callUsage('?from=2026-11-15&to=2026-11-15&groupBy=environment')).status, 403)
    currentActor = { id: foreignAdmin }
    assert.equal((await callUsage('?from=2026-11-15&to=2026-11-15&groupBy=environment')).status, 403)

    // Admin JSON with groupBy=environment
    currentActor = { id: userA }
    const jsonRes = await callUsage('?from=2026-11-15&to=2026-11-15&groupBy=environment')
    assert.equal(jsonRes.status, 200)
    const usageData = await jsonRes.json()
    assert.equal(usageData.groupBy, 'environment')
    assert.ok(usageData.availableGroupBy.includes('environment'))
    const byEnv = new Map(usageData.hosted.map((row: { environmentId: string | null; environmentName: string | null; costMicroUsd: string }) => [
      row.environmentId ?? 'unattributed',
      row,
    ]))
    assert.equal(usageData.hosted.length, 3)
    assert.equal((byEnv.get(envProd) as { environmentName: string }).environmentName, 'Production Env')
    assert.equal((byEnv.get(envProd) as { costMicroUsd: string }).costMicroUsd, '300')
    assert.equal((byEnv.get(envStaging) as { environmentName: string }).environmentName, 'Staging Env')
    assert.equal((byEnv.get(envStaging) as { costMicroUsd: string }).costMicroUsd, '500')
    assert.equal((byEnv.get('unattributed') as { environmentName: string | null }).environmentName, null)
    assert.equal((byEnv.get('unattributed') as { costMicroUsd: string }).costMicroUsd, '100')
    assert.ok(!JSON.stringify(usageData).includes('Foreign Secret Env'))
    assert.ok(!JSON.stringify(usageData).includes(envForeign))

    // CSV export with groupBy=environment vs unsubdivided CSV
    const csvRes = await callUsage('?from=2026-11-15&to=2026-11-15&groupBy=environment&format=csv')
    assert.equal(csvRes.status, 200)
    const csvText = await csvRes.text()
    assert.ok(csvText.startsWith('"day","model","environmentId","environmentName","requests",'))
    assert.ok(csvText.includes('Production Env'))
    assert.ok(csvText.includes('Staging Env'))
    assert.ok(!csvText.includes('Foreign Secret Env'))

    const defaultCsv = await (await callUsage('?from=2026-11-15&to=2026-11-15&format=csv')).text()
    assert.ok(!defaultCsv.includes('environmentId'))
    assert.ok(!defaultCsv.includes('environmentName'))
  })

  await t.test('Desktop RPC actions enforce the same owner, admin and provider_unsupported contracts end to end', async () => {
    const [{ desktopActions }, { withDesktopSession }, { createRequestScope, runRequestScope }] = await Promise.all([
      import('../lib/desktop-rpc/registry'),
      import('../lib/desktop-rpc/session'),
      import('../apps/api/src/context'),
    ])
    const invokeAs = <T>(userId: string, name: keyof typeof desktopActions, args: unknown[]) => {
      currentActor = { id: userId }
      return runRequestScope(
        createRequestScope(new Request('https://mikka.test/api/desktop/rpc')),
        () => withDesktopSession(
          { user: { id: userId, name: userId, email: `${userId}@example.invalid` }, session: { id: 'rpc-fixture' } },
          () => desktopActions[name].invoke(desktopActions[name].args.parse(args) as never[]),
        ),
      ) as Promise<T>
    }

    // Foreign admin rejected via RPC on personalDeviceA
    const deniedPolicy = await invokeAs<{ error?: string }>(foreignAdmin, 'devices.updatePolicy', [
      personalDeviceA,
      { schedulingEnabled: false },
      workspaceUnbound.id,
    ])
    assert.equal(deniedPolicy.error, 'workspaceAccessDenied')

    // Owner updates policy & repositories via RPC
    const updatedPolicy = await invokeAs<{ schedulingEnabled: boolean; computerUseEnabled: boolean; source: string }>(
      userA,
      'devices.updatePolicy',
      [personalDeviceA, { schedulingEnabled: true, computerUseEnabled: true }],
    )
    assert.equal(updatedPolicy.source, 'device')
    assert.equal(updatedPolicy.computerUseEnabled, true)

    const repoCreated = await invokeAs<{ id: string; repoKey: string }>(userA, 'devices.upsertRepository', [
      personalDeviceA,
      { repository: 'aspectly-labs/Mikka', baseBranch: 'main' },
    ])
    assert.equal(repoCreated.repoKey, 'v2/github.com/aspectly-labs/mikka')
    const deniedRepo = await invokeAs<{ error?: string }>(memberA, 'devices.listRepositories', [personalDeviceA])
    assert.equal(deniedRepo.error, 'workspaceAccessDenied')
    const deletedRepo = await invokeAs<{ deleted: boolean }>(userA, 'devices.deleteRepository', [
      personalDeviceA,
      { id: repoCreated.id },
    ])
    assert.equal(deletedRepo.deleted, true)

    // Billing & Ops Metrics via RPC
    const billingSettings = await invokeAs<{ receiptsManagedBy: string; source: string }>(
      userA,
      'billing.getBillingSettings',
      [workspaceA.id],
    )
    assert.equal(billingSettings.receiptsManagedBy, 'stripe_portal')
    assert.equal(billingSettings.source, 'provider')
    const rechargeUnsupported = await invokeAs<{ error?: string }>(userA, 'billing.saveAutoRechargePolicy', [
      { enabled: true, consent: true, expectedRevision: 1, thresholdPoints: 200, amountPoints: 2500, monthlyCapPoints: 5000 },
      workspaceA.id,
    ])
    assert.equal(rechargeUnsupported.error, 'billingAutoRechargeUnavailable')

    const deniedMetrics = await invokeAs<{ error?: string }>(memberA, 'ops-metrics.getWorkspaceOpsMetrics', [workspaceA.id])
    assert.equal(deniedMetrics.error, 'workspaceAccessDenied')
    const allowedMetrics = await invokeAs<{ workspaceId: string; channels: { onlineDevices: number } }>(
      userA,
      'ops-metrics.getWorkspaceOpsMetrics',
      [workspaceA.id],
    )
    assert.equal(allowedMetrics.workspaceId, workspaceA.id)
    assert.equal(allowedMetrics.channels.onlineDevices, 1)
  })
})
