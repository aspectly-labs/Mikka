import 'server-only'
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { approvalModeSchema } from '@mikka/protocol/agent-policy'
import { pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceListChanged } from '@/lib/live/lists'
import { stopRunsForPolicyChange } from '@/lib/run-policy-stop'
import { cliPolicyLayerSchema } from '@/lib/agent-tool-approval/policy-store'
import type { SettingsContext } from './store'

export async function workspaceApprovalMode({ workspaceId, userId }: SettingsContext, update?: unknown) {
  const mode = update === undefined ? undefined : approvalModeSchema.parse(update)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, workspaceId, userId, mode !== undefined)
    return writeTransaction(pool, async tx => {
      if (mode !== undefined) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${workspaceId}`])
        await tx.query('INSERT INTO workspace_computer_policies ("workspaceId",permission) VALUES($1,\'allow\') ON CONFLICT DO NOTHING', [workspaceId])
      }
      const { rows: [row] } = await tx.query(`SELECT cli_run_policy FROM workspace_computer_policies WHERE "workspaceId"=$1 ${mode ? 'FOR UPDATE' : ''}`, [workspaceId])
      const layer = cliPolicyLayerSchema.parse(row?.cli_run_policy ?? {})
      const approvalMode = layer.approvalMode ?? layer.defaults?.approvalMode ?? 'ask'
      if (mode === undefined || approvalMode === mode) return { approvalMode }
      const { rows: [version] } = await tx.query(`UPDATE workspace_computer_policies SET cli_run_policy=$2
        WHERE "workspaceId"=$1 RETURNING cli_run_policy_version::text AS revision`, [workspaceId, { ...layer, approvalMode: mode }])
      await recordAudit(drizzle(tx), { workspaceId, actor: { type: 'user', id: userId, name: userId },
        action: 'agent.policy_changed', target: { type: 'workspace', id: workspaceId }, metadata: { scope: 'workspace', revision: createHash('sha256').update(JSON.stringify([workspaceId, version.revision, mode])).digest('hex') } })
      await stopRunsForPolicyChange(tx, { kind: 'workspace', workspaceId }, workspaceTx)
      await workspaceListChanged(workspaceTx, workspaceId, ['workspace_settings'])
      return { approvalMode: mode }
    })
  })
}
