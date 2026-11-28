'use server'

import { withFreshSession } from '@/lib/fresh-session'
import type { ActionResult } from '@/lib/action-result'
import { billingPortalUrl, planCheckoutUrl, workspaceBillingView, type BillingView } from '@/lib/billing/service'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { getLocale } from '@/lib/intl/i18n-server'
import { pointsPurchase, pointsPurchaseUrl } from '@/lib/billing/points-purchase'
import { workspaceCreditBillingView, type CreditBillingView } from '@/lib/billing/history'
import { readWorkspaceBillingSettings, writeWorkspaceAutoRecharge, writeWorkspaceOveragePolicy } from '@/lib/billing/settings'
import type { WorkspaceBillingSettingsView } from '@/lib/billing/contract'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { requireUser } from '@/lib/issue-access'
import { currentDesktopSession } from '@/lib/desktop-rpc/session'

/** 设置 › 计费. Admins only. */
export async function getBilling(workspaceId?: string): Promise<ActionResult<BillingView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceBillingView(actor.userId, actor.workspaceId)
  })
}

export async function getCreditBilling(workspaceId?: string): Promise<ActionResult<CreditBillingView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceCreditBillingView(actor.userId, actor.workspaceId)
  })
}

/** Customer Portal: payment method, plan changes, cancel, invoices. `returnUrl` is this settings page. */
async function openBillingPortalBody(returnUrl: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return billingPortalUrl(actor.userId, actor.workspaceId, returnUrl)
  })
}

/** Stripe Checkout for a configured capacity plan (Pro, Team, or Enterprise). */
async function startPlanCheckoutBody(returnUrl: string, workspaceId?: string, priceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return planCheckoutUrl(actor.userId, actor.workspaceId, returnUrl, undefined, undefined, priceId)
  })
}

/** One-time points purchase. Amount is USD: 10, 25 or 50. */
async function startPointsPurchaseBody(workspaceId: string, amount: number): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return pointsPurchaseUrl(actor.userId, actor.workspaceId, amount, await getLocale())
  })
}

/**
 * 充值 from a chat whose Mikka 默认 turn ran out of points (decision
 * 2026-11-02-1450): an embedded Checkout for a dialog there, or a hosted one
 * that comes back to that chat. Amount is USD: 10, 25 or 50.
 */
async function startChatPointsPurchaseBody(amount: number, botId: string | null): Promise<ActionResult<{ url: string } | { clientSecret: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return pointsPurchase(actor.userId, actor.workspaceId, amount, await getLocale(), { chat: { botId }, hosted: Boolean(currentDesktopSession()) })
  })
}

/** Stripe hosts card verification and returns to this workspace's billing settings. */
async function startCardVerificationBody(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return (await import('@/lib/abuse/card')).createCardSetup(actor.userId,actor.workspaceId,undefined,await getLocale())
  })
}

export async function cardVerificationStatus(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { cardVerificationStatus: readCardVerificationStatus } = await import('@/lib/abuse/card')
    return readCardVerificationStatus(actor.userId, actor.workspaceId)
  })
}
export async function getHostedUsage(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { hostedUsage, ensureLegacyVerification } = await import('@/lib/abuse/runtime')
    await ensureLegacyVerification(actor.workspaceId)
    const { workspacePool } = await import('@/lib/workspace-db')
    // A personal workspace is its owner's to pay for; in a team only admins choose a plan or add credits.
    const personal = (await workspacePool.query<{ kind: string }>('SELECT kind FROM mikka_workspaces WHERE id=$1', [actor.workspaceId])).rows[0]?.kind === 'personal'
    // The person's own subscription serves them in every workspace (#838): with one connected, 连接订阅 is no way on.
    const { pool } = await import('@/lib/db')
    const subscribed = (await pool.query(`SELECT 1 FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND "removedAt" IS NULL LIMIT 1`, [actor.userId])).rowCount !== 0
    const account = await (await import('@/lib/billing/organization-account')).resolvePlatformBillingAccount(actor.workspaceId)
    const { hostedBillingScope } = await import('@/lib/abuse/context')
    const status = await hostedBillingScope.run({ workspaceId: actor.workspaceId, ownerId: actor.userId, actorId: actor.userId,
      billingAccountWorkspaceId: account.accountWorkspaceId, billingOrganizationId: account.organizationId }, () => hostedUsage.status(account.accountWorkspaceId))
    return { ...status, workspaceId: actor.workspaceId, billingAccount: account, personal, subscribed, admin: personal || actor.role === 'admin',
      recent: actor.role === 'admin' ? await hostedUsage.recent(account.accountWorkspaceId, actor.workspaceId) : [] }
  })
}

export async function getBillingSettings(workspaceId?: string): Promise<ActionResult<WorkspaceBillingSettingsView>> {
  return workspaceAction(async () => {
    const [user, actor] = await Promise.all([requireUser(), currentWorkspaceActor(workspaceId)])
    return readWorkspaceBillingSettings(actor.userId, actor.workspaceId, user[enterprisePrincipal])
  })
}

async function saveAutoRechargePolicyActionBody(
  policy: unknown,
  workspaceId?: string,
): Promise<ActionResult<WorkspaceBillingSettingsView>> {
  return workspaceAction(async () => {
    const [user, actor] = await Promise.all([requireUser(), currentWorkspaceActor(workspaceId)])
    return writeWorkspaceAutoRecharge(actor.userId, actor.workspaceId, policy, user[enterprisePrincipal])
  })
}

async function saveOveragePolicyActionBody(
  policy: unknown,
  workspaceId?: string,
): Promise<ActionResult<WorkspaceBillingSettingsView>> {
  return workspaceAction(async () => {
    const [user, actor] = await Promise.all([requireUser(), currentWorkspaceActor(workspaceId)])
    return writeWorkspaceOveragePolicy(actor.userId, actor.workspaceId, policy, user[enterprisePrincipal])
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function openBillingPortal(...args: Parameters<typeof openBillingPortalBody>) { return withFreshSession(() => openBillingPortalBody(...args)) }
export async function startPlanCheckout(...args: Parameters<typeof startPlanCheckoutBody>) { return withFreshSession(() => startPlanCheckoutBody(...args)) }
export async function startPointsPurchase(...args: Parameters<typeof startPointsPurchaseBody>) { return withFreshSession(() => startPointsPurchaseBody(...args)) }
export async function startChatPointsPurchase(...args: Parameters<typeof startChatPointsPurchaseBody>) { return withFreshSession(() => startChatPointsPurchaseBody(...args)) }
export async function startCardVerification(...args: Parameters<typeof startCardVerificationBody>) { return withFreshSession(() => startCardVerificationBody(...args)) }
export async function saveAutoRechargePolicy(...args: Parameters<typeof saveAutoRechargePolicyActionBody>) { return withFreshSession(() => saveAutoRechargePolicyActionBody(...args)) }
export async function saveOveragePolicy(...args: Parameters<typeof saveOveragePolicyActionBody>) { return withFreshSession(() => saveOveragePolicyActionBody(...args)) }
