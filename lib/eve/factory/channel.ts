import 'server-only'
import { z } from 'zod'
import { POST, type RouteHandlerArgs } from 'eve/channels'
import { internalEveRequestScope } from '../auth'
import { eveFactoryRoleResultSchema } from './evidence'
import {
  EVE_FACTORY_MAX_SESSION_OPENS,
  isEveFactoryDefinition,
  readEveFactoryPlan,
  readEveFactoryRoute,
  type EveFactoryDispatchRole,
} from './contract'
import { assertEveFactoryRoleCapability, resolveEveFactoryProvider } from './providers'
import { eveFactoryConversationAddress, eveFactoryScopeAuth } from './session'

const requestBody = z.strictObject({ runId: z.uuid() })

/**
 * #3082: the Eve-service entry that opens a Factory role session. The Mikka
 * app host (the Factory dispatch driver) calls this after the run is frozen
 * and bound; every authority check is re-derived from the persisted
 * Factory/run rows — request bytes carry only the run identity.
 */
export function eveFactoryAttemptsRoute() {
  return POST('/eve/v1/mikka/factory-attempts', async (request: Request, args: RouteHandlerArgs) => {
    const scope = internalEveRequestScope(request)
    if (!scope) return Response.json({ ok: false, error: 'authRequired' }, { status: 401 })
    const parsed = requestBody.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return Response.json({ ok: false, error: 'validationGeneric' }, { status: 400 })
    const { runId } = parsed.data

    const { pool } = await import('../../db')
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const { rows: [row] } = await tx.query<{
        runId: string; ownerId: string; issueId: string; botId: string | null; status: string; prompt: string
        agentDefinition: Record<string, unknown> | null; attemptId: string; taskId: string; stage: string
        attemptStatus: string; taskStatus: string; candidateId: string | null; output: Record<string, unknown>
      }>(
        `SELECT r.id AS "runId",r."userId" AS "ownerId",r."issueId",r."botId",r.status,r.prompt,r."agentDefinition",
          a.id AS "attemptId",a."taskId",a.status AS "attemptStatus",a.output,
          t.stage,t.status AS "taskStatus",t."candidateId"
         FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id
         JOIN factory_tasks t ON t.id=a."taskId" AND t."attemptId"=a.id
         JOIN computer_run_bindings b ON b."runId"=r.id AND b."botId"=$3::uuid AND b."workspaceId"=$4::uuid AND b."ownerId"=r."userId"
         WHERE r.id=$1 AND r."userId"=$2 FOR UPDATE OF a`,
        [runId, scope.ownerId, scope.botId, scope.workspaceId],
      )
      const plan = readEveFactoryPlan(row?.output)
      const route = readEveFactoryRoute(row?.output)
      if (!row || !plan || !route || !row.agentDefinition || !isEveFactoryDefinition(row.agentDefinition)) {
        await tx.query('ROLLBACK'); return Response.json({ ok: false, code: 'eveFactoryRouteMismatch' }, { status: 409 })
      }
      if (row.taskStatus !== 'running' || row.attemptStatus !== 'running' || row.status !== 'queued') {
        await tx.query('ROLLBACK'); return Response.json({ ok: false, code: 'eveFactoryRouteMismatch' }, { status: 409 })
      }
      if (plan.sessionOpens >= EVE_FACTORY_MAX_SESSION_OPENS) {
        await tx.query('ROLLBACK'); return Response.json({ ok: false, code: 'eveFactoryRoleBudgetExceeded' }, { status: 409 })
      }
      const descriptor = resolveEveFactoryProvider(plan.provider)
      assertEveFactoryRoleCapability(descriptor, plan.role as EveFactoryDispatchRole)
      // Idempotent reopen: a recorded pair is returned as-is (the send already
      // committed); a session without delivery may be re-driven by the host.
      if (plan.sessionId && plan.deliveryId) {
        await tx.query('COMMIT'); return Response.json({ ok: true, sessionId: plan.sessionId, deliveryId: plan.deliveryId })
      }
      const role = row.agentDefinition.role as EveFactoryDispatchRole
      const readOnly = row.agentDefinition.readOnly === true || role !== 'implementer'
      const source = args.from(eveFactoryConversationAddress({
        ownerId: row.ownerId, workspaceId: scope.workspaceId, taskId: row.taskId, attemptId: row.attemptId,
      }))
      const sessionAuth = eveFactoryScopeAuth(row.ownerId, scope, {
        ...plan, runId: row.runId, taskId: row.taskId, attemptId: row.attemptId, readOnly,
      })
      const created = await source.create({ auth: sessionAuth })
      const sessionId = created.session.id
      const delivery = plan.sessionId === sessionId ? null : await created.session.send(row.prompt, {
        auth: sessionAuth, turnPolicy: 'queue',
        // The role's final answer is its structured result part; settlement
        // converts it into the bound run's ordinary completion.
        outputSchema: z.toJSONSchema(eveFactoryRoleResultSchema) as never,
        idempotencyKey: `eve-factory:${row.attemptId}:${plan.sessionOpens + 1}`,
      })
      await tx.query(
        `UPDATE factory_attempts SET output = output || $3::jsonb, "sessionId"=$4 WHERE id=$1 AND "taskId"=$2`,
        [row.attemptId, row.taskId, JSON.stringify({
          eveFactory: {
            ...plan, sessionId,
            deliveryId: delivery ? delivery.deliveryId : plan.deliveryId,
            sessionOpens: plan.sessionOpens + 1,
          },
        }), sessionId],
      )
      await tx.query(`UPDATE agent_runs SET "sessionId"=$2,"startedAt"=COALESCE("startedAt",clock_timestamp()),"updatedAt"=now() WHERE id=$1 AND "userId"=$3`, [runId, sessionId, row.ownerId])
      await tx.query('COMMIT')
      return Response.json({
        ok: true, sessionId,
        deliveryId: delivery ? delivery.deliveryId : plan.deliveryId,
      })
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {})
      if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as { code: unknown }).code
        if (typeof code === 'string') return Response.json({ ok: false, code }, { status: 409 })
      }
      throw error
    } finally {
      tx.release()
    }
  })
}
