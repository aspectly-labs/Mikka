import type { PoolClient } from 'pg'
import { z } from 'zod'
import { OperationError } from './write-error'
import { DIRECT_APP_WRITE_VERSION, resolveWritePermission } from './write-policy'
import { digest, parseDefinition, type DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { supportsWritePlanning } from './write-planning-model'

/** Values originate from the authenticated host, not tool arguments. Call in
 * the effect transaction and keep the row locks until the effect is fenced. */
export interface WritePolicyScope { ownerId: string; botId: string | null; workspaceId: string | null; runId: string; action: string }
const scopeSchema = z.object({ ownerId: z.string().min(1), botId: z.uuid().nullable(), workspaceId: z.uuid().nullable(), runId: z.uuid(), action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict().refine(s => (s.botId === null) === (s.workspaceId === null))

/** Binds the write to its running run, Bot and workspace. A direct write (every
 * new one) is allowed once that binding holds; numeric policy versions keep the
 * stored deny check for receipts created before. There is no ask
 * (ADR 2026-11-27-1615). */
export async function lockWritePolicy(tx: PoolClient, input: WritePolicyScope, options: { direct?: boolean } = {}) {
  const scope = scopeSchema.parse(input)
  const key = scope.botId ?? 'coordinator'
  // The head is identity only: it binds the run to its Bot and workspace and
  // names the definition version. Its external-write columns are not read.
  const head = await tx.query<{ workspace_id: string | null; active_version: string }>(
    'select workspace_id,active_version from agent_kit_heads where owner_id=$1 and bot_key=$2 for share', [scope.ownerId, key])
  const identity = head.rows[0]
  if (!identity || identity.workspace_id !== scope.workspaceId) throw new OperationError('writePolicyUnavailable')
  const execution = await tx.query<{ status: string; snapshot: DefinitionSnapshot; version_id: string }>('select status,snapshot,version_id from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3 for share', [scope.ownerId, key, scope.runId])
  const row = execution.rows[0]
  const snapshot = row?.snapshot
  if (!row || row.status !== 'running' || !snapshot || !supportsWritePlanning(snapshot.runtime) || row.version_id !== snapshot.revisionId || digest(snapshot.definition) !== snapshot.definitionDigest || !Array.isArray(snapshot.effectiveTools) || !snapshot.effectiveTools.includes(scope.action) || !parseDefinition(snapshot.definition).tools.includes(scope.action as never)) throw new OperationError('writeRunUnavailable')
  const current = await tx.query<{ definition: unknown; digest: string }>('select definition,digest from agent_kit_versions where owner_id=$1 and bot_key=$2 and id=$3', [scope.ownerId, key, identity.active_version])
  const definition = current.rows[0]
  if (!definition || digest(definition.definition) !== definition.digest || !parseDefinition(definition.definition).tools.includes(scope.action as never)) throw new OperationError('writeRunUnavailable')
  if (options.direct) return { decision: 'allow' as const, version: DIRECT_APP_WRITE_VERSION }
  if (!scope.workspaceId) {
    // A run that names no workspace still reads the owner's legacy Coordinator
    // head as an explicit ceiling. It is not a per-Bot layer and is removed
    // after the personal-workspace backfill.
    const legacy = await tx.query<{ external_write_permissions: unknown; external_write_policy_version: string }>(
      'select external_write_permissions,external_write_policy_version from agent_kit_heads where owner_id=$1 and bot_key=$2 for share', [scope.ownerId, key])
    const ceiling = legacy.rows[0]
    if (!ceiling || !/^\d+$/.test(String(ceiling.external_write_policy_version))) throw new OperationError('writePolicyUnavailable')
    const permissions = ceiling.external_write_permissions
    return { decision: resolveWritePermission(scope.action, [permissions]), version: String(ceiling.external_write_policy_version) }
  }
  // Serializes absence as well as existing rows with the workspace settings writer.
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-external-write:${scope.workspaceId}`])
  const workspace = await tx.query<{ external_write_permissions: unknown; external_write_policy_version: string }>('select external_write_permissions,external_write_policy_version from workspace_computer_policies where "workspaceId"=$1 for share', [scope.workspaceId])
  const policy = workspace.rows[0]
  const version = policy ? String(policy.external_write_policy_version) : '0'
  if (!/^\d+$/.test(version)) throw new OperationError('writePolicyUnavailable')
  const permissions = policy?.external_write_permissions ?? {}
  return { decision: resolveWritePermission(scope.action, [permissions]), version }
}

/** Readback only: binds an already-recorded write to its owner, Bot and
 * workspace and to a run that exists, in any state. It grants no effect: the
 * caller may only read the ledger and the provider's evidence. A run that has
 * ended, a revoked tool or a moved policy version do not stop a readback. */
export async function lockWriteRunBinding(tx: PoolClient, input: WritePolicyScope) {
  const scope = scopeSchema.parse(input)
  const key = scope.botId ?? 'coordinator'
  const head = await tx.query<{ workspace_id: string | null }>('select workspace_id from agent_kit_heads where owner_id=$1 and bot_key=$2 for share', [scope.ownerId, key])
  if (!head.rows[0] || head.rows[0].workspace_id !== scope.workspaceId) throw new OperationError('writePolicyUnavailable')
  const execution = await tx.query<{ status: string }>('select status from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3 for share', [scope.ownerId, key, scope.runId])
  if (!execution.rows[0]) throw new OperationError('writeRunUnavailable')
  return { running: execution.rows[0].status === 'running' }
}
