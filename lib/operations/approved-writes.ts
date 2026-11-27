import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { writeTransaction, type WriteRequestContext, type WriteActor } from './write-transaction'
import { waitForMailboxGuard } from '@/lib/mailbox-transaction-guard'
import { WRITE_ACTIONS, parseWriteInput, type WriteActionName, writeTarget } from './write-contract'
import { createOperationLedger, lockOperation, OperationError, type OperationIntent, type OperationRecord } from './ledger'
import { requireOperationSession } from './session-authorization'
import type { WriteProvider } from './write-contract'
import { writeBindingSchema as bindingSchema, prepareWriteBinding } from './write-binding'
import { lockWritePolicy, lockWriteRunBinding } from './write-policy-store'
import { withReadbackBinding, withWritePolicy } from './policy-authorization'
import { snapshotDigest as digest } from './write-target'
import { approvedWriteChanged } from '../live/approved-writes'
import type { ReadbackAuthority } from './write-readback-authority'

export interface StoredWriteProposal { id: string; userId: string; action: string; input: Record<string, unknown>; status: string; error?: string | null; operationBinding: z.infer<typeof bindingSchema>; intentKey: string; context: Record<string, unknown> | null; createdAt: Date }
type Proposal = StoredWriteProposal
export interface ApprovedWriteView {
  /** Server read time plus the browser's monotonic request-start time. */
  observedAt?: string
  requestedAt?: number
  id: string
  action: WriteActionName
  input: Record<string, unknown>
  approvalContext: Record<string, unknown> | null
  account: { provider: string; accountId: string; version: string }
  createdAt: string
  approvalExpiresAt: string
  status: 'pending' | 'running' | 'done' | 'declined'
  error: 'operationUncertain' | null
  outcome?: ApprovedWriteOutcome
}
export interface ApprovedWriteOutcome { id: string; url?: string }
/** A receipt closed without readback after it was sent: its outcome is unknown and stays so. */
export const WRITE_UNCONFIRMED = 'writeUnconfirmed'
const writeOutcome = (receipt: NonNullable<OperationRecord['receipt']>): ApprovedWriteOutcome => ({ id: receipt.providerObjectId, ...(receipt.providerObjectUrl ? { url: receipt.providerObjectUrl } : {}) })
// #204 acts in a person's own account, not a team workspace. Explicit personal
// scope avoids inventing a workspace DB relationship or using a browser cookie.
const scope = (owner: string) => `personal:${owner}`
const identity = (p: Proposal) => ({ operationId: p.id, ownerId: p.userId, workspaceId: scope(p.userId) })
const nativeBinding = (ownerId: string, action: string, input: unknown, binding: z.infer<typeof bindingSchema>, context: unknown) => ({ ownerId, botId: binding.run?.botId ?? null, action, input, accountId: binding.accountId, version: binding.version, context, policy: binding })
const intent = (p: Proposal): OperationIntent => ({ ...identity(p), provider: p.operationBinding.provider, accountId: p.operationBinding.accountId, action: p.action, target: writeTarget(p.action as WriteActionName, p.input), approvalId: p.id, proposalDigest: digest([p.action, p.operationBinding]), payloadDigest: p.operationBinding.payloadDigest, ...(p.operationBinding.run ? { executionRunId: p.operationBinding.run.runId, policyScope: { botId: p.operationBinding.run.botId, workspaceId: p.operationBinding.run.workspaceId, version: p.operationBinding.run.policyVersion, ...(p.operationBinding.run.approvalDefault ? { approvalDefault: p.operationBinding.run.approvalDefault } : {}) } } : {}) })

/** Pure projection only; callers must authenticate/authorize the read separately.
 * Shared by by-ID and discovery so status never depends on which endpoint is used. */
export function projectApprovedWriteView(p: StoredWriteProposal, execution: (OperationRecord & { invokedAt: Date | string | null }) | null | undefined): ApprovedWriteView {
  const action = p.action as WriteActionName
  if (!WRITE_ACTIONS.includes(action) || !z.uuid().safeParse(p.intentKey).success || !bindingSchema.safeParse(p.operationBinding).success || !parseWriteInput(action, p.input) || !['pending', 'running', 'done', 'declined', 'failed'].includes(p.status)) throw new OperationError('operationBindingConflict')
  if (digest(p.input) !== p.operationBinding.payloadDigest || digest(p.context) !== p.operationBinding.contextDigest || execution && digest(execution.binding) !== digest(intent(p))) throw new OperationError('operationBindingConflict')
  if (p.status === 'declined' && execution?.invokedAt || p.status === 'failed' && execution?.status === 'succeeded' || p.status === 'done' && execution?.status !== 'succeeded') throw new OperationError('operationBindingConflict')
  // `failed` is a write closed unsent after its run ended (readback); to the
  // existing four-state client contract that is "did not run", like declined.
  // `failed` / writeUnconfirmed was sent and can no longer be read back: its
  // outcome stays unknown (running / operationUncertain), never "did not run".
  const unconfirmed = p.status === 'failed' && p.error === WRITE_UNCONFIRMED
  const status = unconfirmed ? 'running' : p.status === 'declined' || p.status === 'failed' ? 'declined' : execution?.status === 'succeeded' ? 'done' : execution || p.status === 'running' ? 'running' : 'pending'
  const created = z.coerce.date().safeParse(p.createdAt)
  if (!created.success) throw new OperationError('operationBindingConflict')
  return {
    id: p.id, action, input: p.input, approvalContext: p.context,
    account: { provider: p.operationBinding.provider, accountId: p.operationBinding.accountId, version: p.operationBinding.version },
    createdAt: created.data.toISOString(), approvalExpiresAt: new Date(created.data.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status, error: status === 'running' ? 'operationUncertain' : null,
    ...(status === 'done' && execution?.receipt ? { outcome: writeOutcome(execution.receipt) } : {}),
  }
}

async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await waitForMailboxGuard(Promise.race([call(requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OperationError('operationUncertain')) }, 30000) })]), requestSignal) }
  finally { clearTimeout(timer) }
}

/** A personal write from a run runs directly (ADR 2026-11-27-1615: no
 * approvals). The `pending_actions` row is its receipt and the operation ledger
 * its exactly-once gate; an unclear outcome stays `running` and is never resent. */
export function createApprovedWrites(pool: Pool, provider: WriteProvider, action: WriteActionName, context: WriteRequestContext & { /** Required before any provider readback. */ readbackAuthority?: ReadbackAuthority } = {}) {
  function transaction<T>(work: (tx: PoolClient) => Promise<T>, actor: WriteActor | undefined = context.actor) {
    return writeTransaction(pool, work, { signal: context.signal, guard: context.guard, ...(actor ? { authorizeCommit: (tx: PoolClient) => requireOperationSession(tx, actor, actor.userId) } : {}) })
  }
  async function owned(tx: PoolClient, owner: string, id: string) {
    const { rows } = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [id, owner])
    const row = rows[0]
    if (!row || row.action !== action || !row.operationBinding) throw new OperationError('pendingActionUnavailable')
    const storedIntent = z.uuid().safeParse(row.intentKey)
    if (!storedIntent.success) throw new OperationError('operationBindingConflict')
    const canonicalIntent = storedIntent.data.toLowerCase()
    const aliases = await tx.query('SELECT id FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2 LIMIT 2', [owner, canonicalIntent])
    if (aliases.rows.length !== 1) throw new OperationError('operationIntentAmbiguous')
    if (!bindingSchema.safeParse(row.operationBinding).success) throw new OperationError('operationBindingConflict')
    if (digest(row.input) !== row.operationBinding.payloadDigest || digest(row.context) !== row.operationBinding.contextDigest) throw new OperationError('operationBindingConflict')
    return row
  }
  async function current(tx: PoolClient, binding: OperationIntent, _run: string | null, phase: string) {
    const p = await owned(tx, binding.ownerId, binding.approvalId)
    if (digest(intent(p)) !== digest(binding)) throw new OperationError('operationBindingConflict')
    if (binding.executionRunId && _run !== null && binding.executionRunId !== _run) throw new OperationError('operationRunMismatch')
    const valid = await tx.query(`SELECT id FROM pending_actions WHERE id=$1 AND status IN ('running','done') AND ($2=false OR "createdAt">clock_timestamp()-interval '7 days')`, [p.id, ['claim', 'invoke'].includes(phase)])
    if (!valid.rows.length || p.operationBinding.provider !== provider.name) throw new OperationError('pendingActionUnavailable')
  }
  async function project(row: OperationRecord) {
    // UI-compatible projection. Unknown results are never represented as failure
    // or success: existing running stays pending reconciliation; ledger is authoritative.
    if (row.status === 'succeeded') await pool.query(`UPDATE pending_actions SET status='done',result=$2,error=NULL WHERE id=$1 AND status IN ('running','done')`, [row.operationId, { id: row.receipt!.providerObjectId }])
    return { status: row.status === 'succeeded' ? 'done' as const : 'running' as const, error: row.status === 'succeeded' ? null : 'operationUncertain', ...(row.status === 'succeeded' ? { outcome: writeOutcome(row.receipt!) } : {}) }
  }
  async function execute(p: Proposal) {
      const run = p.operationBinding.run
      if (!run) throw new OperationError('operationAuthorizationRequired')
      const guard = context.guard
      if (run.workspaceId && !guard) throw new OperationError('writePolicyUnavailable')
      const ledger = createOperationLedger(pool, withWritePolicy(current), { ...context, guard })
      const row = await ledger.reserve(intent(p))
      if (row.status !== 'reserved') {
        if (row.status === 'succeeded') return project(row)
        return project(await ledger.reconcile(identity(p), (record, leaseSignal) => bounded(signal => provider.lookup({ ownerId: p.userId, accountId: p.operationBinding.accountId, version: p.operationBinding.version, payload: p.input, idempotencyKey: record.idempotencyKey, signal: AbortSignal.any([signal, leaseSignal]) }), context.signal)))
      }
      let claimed: OperationRecord
      try { claimed = await ledger.claim(identity(p), run.runId) }
      catch (error) {
        if (error instanceof OperationError && error.message === 'operationAlreadyClaimed') return project(await ledger.read(identity(p)))
        throw error
      }
      try {
        const result = await ledger.invoke(identity(p), claimed.attemptToken!, (record, beforeSend, leaseSignal) => bounded(signal => provider.execute({ signal: AbortSignal.any([signal, leaseSignal]), beforeSend, ownerId: p.userId, ...p.operationBinding, payload: p.input, approvalContext: p.context, idempotencyKey: record.idempotencyKey }), context.signal))
        return project(result)
      } catch {
        // The durable invoke gate survives provider/writeback failures. Never resend.
        return { status: 'running' as const, error: 'operationUncertain' }
      }
  }
  /** Never sent: the run ended before the ledger's invoke gate committed, and an ended run can never claim or invoke. */
  async function closeUnsent(p: Proposal) {
    return transaction(async tx => {
      const closed = await tx.query("UPDATE pending_actions SET status='failed',error='writeRunEnded' WHERE id=$1 AND \"userId\"=$2 AND status='running'", [p.id, p.userId])
      if (closed.rowCount) await approvedWriteChanged(tx, p.id, p.userId)
      return { status: 'failed' as const, error: 'writeRunEnded' }
    })
  }
  /** Ends a receipt the sweep may no longer read back: its run binding is gone
   * (a Bot taken over removes the old owner's agent head and runs) or its owner
   * lost the workspace or the connection. Reads only Mikka's own ledger, under
   * the operation lock, never the provider; never claims, invokes or resends.
   * An ended run can no longer claim or invoke, so a write whose invoke gate
   * never committed was never sent (writeRunEnded); one that succeeded is done;
   * one that was sent with no evidence is closed `failed` / writeUnconfirmed,
   * which still reads as an unknown outcome. */
  async function closeWithoutReadback(p: Proposal) {
    return transaction(async tx => {
      await lockOperation(tx, identity(p))
      const locked = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [p.id, p.userId])
      if (locked.rows[0]?.status !== 'running') return { status: locked.rows[0]?.status ?? 'failed', error: locked.rows[0]?.error ?? null }
      const { rows } = await tx.query<OperationRecord & { invokedAt: Date | null }>('SELECT * FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [p.id, p.userId, scope(p.userId)])
      const row = rows[0]
      if (row?.status === 'succeeded' && row.receipt) {
        await tx.query(`UPDATE pending_actions SET status='done',result=$2,error=NULL WHERE id=$1 AND status='running'`, [p.id, { id: row.receipt.providerObjectId }])
        await approvedWriteChanged(tx, p.id, p.userId)
        return { status: 'done' as const, error: null, outcome: writeOutcome(row.receipt) }
      }
      const sent = Boolean(row) && row!.status !== 'failed' && (Boolean(row!.invokedAt) || row!.status === 'uncertain')
      const error = sent ? WRITE_UNCONFIRMED : 'writeRunEnded'
      await tx.query("UPDATE pending_actions SET status='failed',error=$3 WHERE id=$1 AND \"userId\"=$2 AND status='running'", [p.id, p.userId, error])
      await approvedWriteChanged(tx, p.id, p.userId)
      return { status: 'failed' as const, error }
    })
  }
  return {
    async view(actor: { userId: string; sessionId: string }, id: string): Promise<ApprovedWriteView> {
      z.uuid().parse(id)
      return transaction(async tx => {
        // Same gate/lock order as writes; only SELECTs, no reserve, projection
        // writeback, provider lookup or execution authority.
        await lockOperation(tx, { operationId: id, ownerId: actor.userId, workspaceId: scope(actor.userId) })
        const result = await tx.query<OperationRecord & { invokedAt: Date | null }>('SELECT * FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [id, actor.userId, scope(actor.userId)])
        await requireOperationSession(tx, actor, actor.userId)
        const p = await owned(tx, actor.userId, id)
        const execution = result.rows[0]
        const view = projectApprovedWriteView(p, execution)
        await requireOperationSession(tx, actor, actor.userId)
        return view
      }, actor)
    },
    /** Trusted host sweep for a run-bound receipt still `running` after its run
     * ended: read and reconcile only, never claim, invoke or resend. Evidence of
     * the effect makes it `done`; a write whose invoke gate never committed is
     * closed `failed` (writeRunEnded); an invoked write with no evidence stays
     * `running` / operationUncertain. A run still running is left to the run.
     * The provider is read only while the owner still holds the workspace and
     * the connection (`readbackAuthority`); a receipt whose binding or authority
     * is gone is ended without any provider read (closeWithoutReadback). */
    async readback(ownerId: string, id: string) {
      z.uuid().parse(id)
      const p = await transaction(tx => owned(tx, ownerId, id))
      const run = p.operationBinding.run
      if (!run) throw new OperationError('operationAuthorizationRequired')
      if (p.status !== 'running') return { status: p.status, actionId: p.id }
      let binding: { running: boolean }
      try { binding = await transaction(tx => lockWriteRunBinding(tx, { ownerId, botId: run.botId, workspaceId: run.workspaceId, runId: run.runId, action })) }
      catch (error) {
        // The head or the run is gone for good (a Bot taken over, a Bot moved):
        // nothing can claim or invoke it any more, and nothing may read it back.
        if (error instanceof OperationError && ['writePolicyUnavailable', 'writeRunUnavailable'].includes(error.message)) return { ...await closeWithoutReadback(p), actionId: p.id }
        throw error
      }
      if (binding.running) return { status: 'running' as const, error: 'operationUncertain', actionId: p.id }
      const ledger = createOperationLedger(pool, withReadbackBinding(current), context)
      let row: OperationRecord | null
      try { row = await ledger.read(identity(p)) }
      catch (error) { if (error instanceof OperationError && error.message === 'operationUnavailable') row = null; else throw error }
      const invoked = Boolean(row && (row as OperationRecord & { invokedAt?: Date | string | null }).invokedAt)
      if (!row || row.status === 'reserved' || (row.status === 'executing' && !invoked) || row.status === 'failed') return { ...await closeUnsent(p), actionId: p.id }
      if (row.status === 'succeeded') return { ...await project(row), actionId: p.id }
      // Only now would the provider be read, with the owner's credential: the
      // owner must still hold the workspace and the connection (fail closed).
      const readbackAuthority = context.readbackAuthority
      if (!readbackAuthority) throw new OperationError('writePolicyUnavailable')
      const authority = await readbackAuthority({ ownerId: p.userId, workspaceId: run.workspaceId, accountId: p.operationBinding.accountId })
      if (!authority) return { ...await closeWithoutReadback(p), actionId: p.id }
      const reader = createOperationLedger(pool, withReadbackBinding(current), { ...context, guard: authority.guard })
      try {
        // The provider read is bounded by the membership lease: when the lease
        // is lost or expires, the read is aborted and any late answer discarded.
        return { ...await project(await reader.reconcile(identity(p), (record, leaseSignal) => bounded(signal => provider.lookup({ ownerId: p.userId, accountId: p.operationBinding.accountId, version: p.operationBinding.version, payload: p.input, idempotencyKey: record.idempotencyKey, signal: AbortSignal.any([signal, leaseSignal]) }), context.signal))), actionId: p.id }
      } catch (error) {
        // The provider says the account is no longer the owner's active one.
        if (error instanceof OperationError && error.message === 'integrationAccountUnavailable') return { ...await closeWithoutReadback(p), actionId: p.id }
        // Any other failure (a lost lease among them): if the owner's authority
        // is gone by now, end the receipt without reading; otherwise retry later.
        if (!await readbackAuthority({ ownerId: p.userId, workspaceId: run.workspaceId, accountId: p.operationBinding.accountId })) return { ...await closeWithoutReadback(p), actionId: p.id }
        throw error
      }
    },
    /** The receipt is written as `running` and the write dispatched in the same
     * call. A retry with the same intent replays the receipt and never resends. */
    async writeFromRun(raw: unknown, intentKey: string) {
      const run = context.modelRun
      if (!run || (run.workspaceId && !context.guard)) throw new OperationError('writePolicyUnavailable')
      const key = z.uuid().parse(intentKey).toLowerCase()
      const input = parseWriteInput(action, raw)
      if (!input) throw new OperationError('invalidIntegrationInput')
      const hash = digest(input)
      const locked = <T>(work: (tx: PoolClient) => Promise<T>) => transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-intent', run.ownerId, key])])
        return work(tx)
      })
      const prior = async (tx: PoolClient) => {
        const rows = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2', [run.ownerId, key])
        if (rows.rows.length > 1) throw new OperationError('operationIntentAmbiguous')
        const p = rows.rows[0]
        if (p && (p.action !== action || p.operationBinding?.payloadDigest !== hash || p.operationBinding?.run?.runId !== run.runId || p.operationBinding.run.botId !== run.botId || p.operationBinding.run.workspaceId !== run.workspaceId)) throw new OperationError('operationBindingConflict')
        return p ?? null
      }
      let proposal = await locked(prior)
      if (!proposal) {
        // Recheck the current tool and run under the insert lock after the provider read.
        await transaction(tx => lockWritePolicy(tx, { ...run, action }, { direct: true }))
        const selected = await bounded(() => provider.prepare(run.ownerId, input), context.signal)
        proposal = await locked(async tx => {
          const existing = await prior(tx)
          if (existing) return existing
          const policy = await lockWritePolicy(tx, { ...run, action }, { direct: true })
          const binding = bindingSchema.parse({ ...prepareWriteBinding(provider.name, selected, input), run: { runId: run.runId, botId: run.botId, workspaceId: run.workspaceId, policyVersion: policy.version, decision: policy.decision } })
          const nativeDecision = context.nativeWriteReview ? await context.nativeWriteReview('allow', nativeBinding(run.ownerId, action, input, binding, selected.context ?? null)) : 'allow'
          if (nativeDecision !== 'allow') throw new OperationError('writeDenied')
          const id = randomUUID()
          const inserted = await tx.query<Proposal>('INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context,status) VALUES ($1,$2,$3,$4,$5,$6,$7,\'running\') RETURNING *', [id, run.ownerId, action, input, key, binding, selected.context ?? null])
          await approvedWriteChanged(tx, id, run.ownerId)
          return inserted.rows[0]
        })
      }
      // A receipt from before ADR 2026-11-27-1615 that was waiting for, or
      // bound to, a person's approval is replayed as it stands, never run here.
      if (proposal.status === 'pending' || proposal.status === 'declined') return { status:'declined' as const, actionId:proposal.id }
      if (proposal.operationBinding.run?.decision !== 'allow') return { status:proposal.status, actionId:proposal.id }
      return { ...(await execute(proposal)), actionId:proposal.id }
    },
  }
}
