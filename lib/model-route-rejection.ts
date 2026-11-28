import type { EntryBlock } from './model-order-plan'
import { ActionFailureError } from './action-error'

export function modelRouteRejection(reason: EntryBlock['reason'], resetsAt: string | null = null) {
  switch (reason) {
    case 'missing':
    case 'removed':
      return { rejection: 'not_connected', health: { reason: 'not_connected', action: 'connect' } } as const
    case 'expired':
      return { rejection: 'disconnected', health: { reason: 'signed_out', action: 'reconnect' } } as const
    case 'keyRefused':
      return { rejection: 'disconnected', health: { reason: 'key_rejected', action: 'replace_key' } } as const
    case 'paused':
      return { rejection: 'disconnected', health: { reason: 'turned_off', action: 'turn_on' } } as const
    case 'quota':
    case 'balance':
      return { rejection: 'disconnected', health: { reason: 'out_of_usage', resetsAt } } as const
  }
  return undefined
}

export type ModelRouteRejection = NonNullable<ReturnType<typeof modelRouteRejection>>
export type ModelRouteHealth = ModelRouteRejection['health']

/** The route is within scope and its refusal is known. Unknown routes keep the ordinary error. */
export class ModelRouteUnavailable extends ActionFailureError {
  constructor(readonly health: ModelRouteHealth, options?: ErrorOptions) {
    super('executionModelUnknown', { reason: health.reason, ...('action' in health ? { action: health.action } : {}),
      ...('resetsAt' in health && health.resetsAt ? { resetsAt: health.resetsAt } : {}) }, undefined, options)
  }
}
