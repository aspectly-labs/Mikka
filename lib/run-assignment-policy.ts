import { readOnlyRunPolicy, isNoLooserThan, runPolicySchema, type RunPolicy } from '@mikka/protocol/agent-policy'

/** A host-frozen continuation ceiling can only remove what the host itself
 * grants: the daemon's own push, the computer grant, and a read-only role.
 * Older ceilings may also carry install, write or network denials and domain
 * lists a workspace once set; those restrict nothing (ADR 2026-11-27-1615). */
export function intersectRunPolicy(current: RunPolicy, frozen: unknown): RunPolicy {
  if (frozen === undefined) return current
  const ceiling = runPolicySchema.parse(frozen)
  const permissions = { ...current.permissions }
  if (ceiling.permissions.git_push === 'deny') permissions.git_push = 'deny'
  // Computer authority is separately granted by the broker. A CLI-only
  // ceiling omits it; a read-only or independent-check ceiling can deny it.
  if (ceiling.permissions.computer_use === 'deny') permissions.computer_use = 'deny'
  const policy: RunPolicy = { ...current, permissions }
  return current.readOnly || ceiling.readOnly ? readOnlyRunPolicy(policy) : policy
}

/** A frozen check/benchmark may narrow the live policy, never replace a denial.
 * Keep its exact bytes for the execution-evidence digest; configuration drift
 * rejects the assignment instead of silently changing the recorded experiment. */
export function constrainedAssignmentPolicy(current: RunPolicy, frozen: unknown): RunPolicy {
  if (frozen === undefined) return current
  const next = runPolicySchema.parse(frozen)
  if (!isNoLooserThan(current, next)) throw new Error('Frozen assignment policy exceeds the current policy')
  return next
}
