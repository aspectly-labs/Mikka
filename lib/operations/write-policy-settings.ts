import type { Pool } from 'pg'
import { z } from 'zod'
import type { AgentScope } from '@/lib/agent-kit/store'
import { AgentKitError } from '@/lib/agent-kit/store'
import type { MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import type { PoolClient } from 'pg'
import { writeTransaction } from './write-transaction'

const settingKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
/** An admin's workspace boundary: which app/write actions the workspace's Bots
 * may not use at all. Allow or deny only; there is no "ask" and no approval
 * (ADR 2026-11-27-1615). */
export const writePolicySettingsSchema = z.record(settingKey, z.enum(['allow', 'deny']))
  .refine(value => Object.keys(value).length <= 100)
/** Rows written before that decision may still hold "ask"; it reads as allow. */
const storedSettingsSchema = z.record(settingKey, z.enum(['allow', 'ask', 'deny']))
  .transform(value => Object.fromEntries(Object.entries(value).map(([key, decision]) => [key, decision === 'deny' ? 'deny' as const : 'allow' as const])))
const versionSchema = z.string().regex(/^(0|[1-9]\d*)$/)

/** Host supplies workspace membership lease; model input cannot select identity. */
export function createWritePolicySettings(pool: Pool, membershipGuard: (scope: AgentScope) => MailboxTransactionGuard | undefined) {
  async function workspace<T>(scope: AgentScope, work: (tx: PoolClient) => Promise<T>, admin = false, after?: (tx: PoolClient, value: T) => Promise<T>) {
    const guard = membershipGuard(scope)
    if (!scope.botId || !scope.workspaceId || !guard) throw new AgentKitError('agentScopeNotFound',404)
    return writeTransaction(pool, async tx => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-external-write:${scope.workspaceId}`])
      return work(tx)
    }, { guard, guardedWork: async (tx,value,lease) => {
      if (!lease?.workspaceClient) throw new AgentKitError('agentScopeNotFound',404)
      if (admin) {
        const result = await lease.workspaceClient.query(`select role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status='active' for share`, [scope.workspaceId, scope.ownerId])
        if (result.rows[0]?.role !== 'admin') throw new AgentKitError('workspaceAccessDenied',403)
      }
      return after ? after(tx,value) : value
    } })
  }
  async function workspaceRow(tx: PoolClient, workspaceId:string) {
    const result=await tx.query<{ permissions:unknown; version:string }>('select external_write_permissions as permissions,external_write_policy_version as version from workspace_computer_policies where "workspaceId"=$1 for update',[workspaceId])
    return result.rows[0] ?? { permissions:{},version:'0' }
  }
  return {
    readWorkspace: (scope:AgentScope) => workspace(scope, async tx => {
      const row=await workspaceRow(tx,scope.workspaceId!)
      return { permissions:storedSettingsSchema.parse(row.permissions),version:versionSchema.parse(String(row.version)) }
    }),
    setWorkspace: (scope:AgentScope,raw:unknown,expected:string) => {
      const permissions=writePolicySettingsSchema.parse(raw), version=versionSchema.parse(expected)
      return workspace(scope, async tx => {
        const row=await workspaceRow(tx,scope.workspaceId!)
        if (String(row.version)!==version) throw new AgentKitError('writePolicyChanged')
        return { permissions,version }
      }, true, async (tx,value) => {
        const result=await tx.query<{permissions:unknown;version:string}>(`insert into workspace_computer_policies ("workspaceId",permission,external_write_permissions,external_write_policy_version)
          values ($1,'allow',$2,case when $2::jsonb='{}'::jsonb then 0 else 1 end)
          on conflict ("workspaceId") do update set external_write_permissions=$2
          returning external_write_permissions as permissions,external_write_policy_version as version`,[scope.workspaceId,value.permissions])
        return {permissions:storedSettingsSchema.parse(result.rows[0].permissions),version:versionSchema.parse(String(result.rows[0].version))}
      })
    },
  }
}
