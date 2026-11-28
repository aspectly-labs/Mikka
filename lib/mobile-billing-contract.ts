import { z } from 'zod'
import type { BillingScope } from '@/lib/billing/management-contract'

const scopeSchema = z
  .object({
    kind: z.enum(['workspace', 'organization']),
    id: z.uuid(),
  })
  .strict()

export interface MobileBillingGetQuery {
  scope: BillingScope | null
  budgetWorkspace: string | null
  usageMember: string | null
}

/**
 * Parses `GET /api/mobile/billing` query parameters.
 * Optional `scopeKind` and `scopeId` must be supplied together when present.
 */
export function parseMobileBillingGetQuery(params: URLSearchParams): MobileBillingGetQuery | null {
  const scopeKind = params.get('scopeKind')
  const scopeId = params.get('scopeId')
  let scope: BillingScope | null = null
  if (scopeKind !== null || scopeId !== null) {
    const parsed = scopeSchema.safeParse({ kind: scopeKind, id: scopeId })
    if (!parsed.success) return null
    scope = parsed.data
  }

  const budgetWorkspace = params.get('budgetWorkspace')
  if (budgetWorkspace !== null && !z.uuid().safeParse(budgetWorkspace).success) return null

  const usageMember = params.get('usageMember')
  if (usageMember !== null && (usageMember.length < 1 || usageMember.length > 256)) return null

  return { scope, budgetWorkspace, usageMember }
}

/**
 * Separates an optional `scope` selector from the billing management operation
 * payload passed straight to `mutateBillingManagement`.
 */
export function parseMobileBillingPostBody(
  raw: unknown,
): { scope: BillingScope | null; operation: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  let scope: BillingScope | null = null
  if (record.scope !== undefined && record.scope !== null) {
    const parsed = scopeSchema.safeParse(record.scope)
    if (!parsed.success) return null
    scope = parsed.data
  }
  const { scope: _scope, ...operation } = record
  if (typeof operation.action !== 'string') return null
  return { scope, operation }
}
