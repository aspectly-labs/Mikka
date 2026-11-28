import { z } from 'zod'
import { OperationError } from './write-error'

// Numeric versions are pinned receipts for operations created before the settings change.
export const DIRECT_APP_WRITE_VERSION = 'direct'
export const writePolicyVersion = z.union([z.literal(DIRECT_APP_WRITE_VERSION), z.string().regex(/^\d+(?::\d+)?$/)])

// 'ask' is only ever read from rows written before ADR 2026-11-27-1615 (no
// permission approvals); it reads as allow. Nothing writes it any more.
const decision = z.enum(['allow', 'ask', 'deny'])
const settings = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), decision)

/** The workspace entry is the decision. There is no agent/Bot choice to narrow
 * and no approval: an explicit deny blocks, anything else (absent, allow, a
 * legacy ask) runs. A malformed layer is unavailable (never allow). */
export function resolveWritePermission(action: string, layers: readonly unknown[]): 'allow' | 'deny' {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(action) || !layers.length) throw new OperationError('writePolicyUnavailable')
  let denied = false
  for (const raw of layers) {
    const parsed = settings.safeParse(raw)
    if (!parsed.success) throw new OperationError('writePolicyUnavailable')
    if (Object.hasOwn(parsed.data, action) && parsed.data[action] === 'deny') denied = true
  }
  return denied ? 'deny' : 'allow'
}
