import type { OperationAuthorize } from './ledger'
import { OperationError } from './write-error'
import { lockWritePolicy, lockWriteRunBinding } from './write-policy-store'
import { DIRECT_APP_WRITE_VERSION } from './write-policy'

/** Composes the existing domain binding check with live policy. The callback is
 * a host implementation executed in the same locked transaction; it must verify
 * owner, account, target and payload. The run binding and the policy version
 * pinned on the receipt must still hold; a deny blocks. There is no approval
 * step (ADR 2026-11-27-1615). */
export function withWritePolicy(checkBinding: OperationAuthorize): OperationAuthorize {
  return async (tx, binding, runId, phase) => {
    const scope = binding.policyScope
    const executionRunId = binding.executionRunId
    if (!scope || !executionRunId || (runId !== null && runId !== executionRunId)) throw new OperationError('writePolicyUnavailable')
    await checkBinding(tx, binding, runId, phase)
    const current = await lockWritePolicy(tx, { ownerId: binding.ownerId, botId: scope.botId, workspaceId: scope.workspaceId, runId: executionRunId, action: binding.action }, { direct: scope.version === DIRECT_APP_WRITE_VERSION })
    if (current.version !== scope.version) throw new OperationError('writePolicyChanged')
    if (current.decision === 'deny') throw new OperationError('writeDenied')
  }
}

/** Readback of an already-recorded write: only the read and reconcile phases,
 * never reserve, claim, invoke or settle, so it can never send anything. The
 * binding and its owner, Bot, workspace and run still hold; the run may have
 * ended and the pinned policy version may have moved. */
export function withReadbackBinding(checkBinding: OperationAuthorize): OperationAuthorize {
  return async (tx, binding, runId, phase) => {
    if (phase !== 'read' && phase !== 'reconcile') throw new OperationError('operationReadbackOnly')
    const scope = binding.policyScope
    const executionRunId = binding.executionRunId
    if (!scope || !executionRunId || (runId !== null && runId !== executionRunId)) throw new OperationError('writePolicyUnavailable')
    await checkBinding(tx, binding, runId, phase)
    await lockWriteRunBinding(tx, { ownerId: binding.ownerId, botId: scope.botId, workspaceId: scope.workspaceId, runId: executionRunId, action: binding.action })
  }
}
