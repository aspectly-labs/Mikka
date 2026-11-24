import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson } from '@/lib/governance/http'
import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { parseMobileBillingGetQuery, parseMobileBillingPostBody } from '@/lib/mobile-billing-contract'
import { readMobileBilling, runMobileBillingMutation } from '@/lib/mobile-billing'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { WorkspaceError } from '@/lib/workspace-access'
import { isActionErrorCode } from '@/lib/workspace-admin/action'

function mapBillingError(error: unknown) {
  if (error instanceof z.ZodError) return json({ error: 'validationGeneric' }, 400)
  if (error instanceof GovernanceError) {
    return json(
      {
        error:
          error.detail === 'access_denied'
            ? 'workspaceAccessDenied'
            : error.detail === 'invalid_request'
              ? 'validationGeneric'
              : 'billingPolicyChanged',
      },
      error.detail === 'access_denied' ? 403 : error.detail === 'invalid_request' ? 400 : 409,
    )
  }
  if (error instanceof WorkspaceError) {
    return json(
      { error: isActionErrorCode(error.code) ? error.code : 'generic' },
      error.code === 'workspaceAccessDenied' ? 403 : 409,
    )
  }
  console.error('mobile_billing_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
  return json({ error: 'generic' }, 500)
}

/**
 * `GET /api/mobile/billing`: reads the caller's workspace or organization
 * billing view (plan, credit balance, transactions, budgets, monthly usage)
 * through the same owning reader as `/api/workspaces/:id/billing`. Non-admin
 * members without a billing scope receive `{ available: false, billingScope: null, view: null }`.
 */
async function handleGET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    })
    noteLogUser(session?.user?.id)
    if (!session?.user) return unauthorized()
    const query = parseMobileBillingGetQuery(new URL(request.url).searchParams)
    if (!query) return json({ error: 'validationGeneric' }, 400)
    return json(await readMobileBilling(session, query))
  } catch (error) {
    return mapBillingError(error)
  }
}

/**
 * `POST /api/mobile/billing`: executes a billing management action (`checkout`,
 * `portal`, `topup`, `budget`, `recharge`, `account`) with the mobile origin
 * policy (`writeAllowed`) and fresh session verification.
 */
async function handlePOST(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    })
    noteLogUser(session?.user?.id)
    if (!session?.user) return unauthorized()
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return json({ error: 'validationGeneric' }, 400)
    }
    const parsed = parseMobileBillingPostBody(await governanceJson(request))
    if (!parsed) return json({ error: 'validationGeneric' }, 400)
    return json(await runMobileBillingMutation(session, parsed.scope, parsed.operation))
  } catch (error) {
    return mapBillingError(error)
  }
}

export const GET = freshSessionRoute(withRequestLog('/api/mobile/billing', handleGET))
export const POST = freshSessionRoute(withRequestLog('/api/mobile/billing', handlePOST))
