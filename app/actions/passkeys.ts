'use server'

import { isAPIError } from '@better-auth/core/utils/is-api-error'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { withFreshSession } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import type { ActionErrorCode, ActionResult } from '@/lib/action-result'
import { headers } from '@/lib/server-runtime/headers'
import {
  deleteUserPasskey,
  listUserPasskeys,
  renameUserPasskey,
} from '@/lib/account/passkeys'
import type { PasskeySummary } from '@/lib/account/passkeys-contract'

export type PasskeyActionErrorCode = ActionErrorCode | 'twoFactorRequired' | 'passkeyNotFound'
export type PasskeyActionResult<T> = ActionResult<T, PasskeyActionErrorCode>

async function requirePasskeySession() {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders, query: { disableCookieCache: true } })
  if (!session?.user || !session.session) return null
  return { user: session.user, session: session.session }
}

async function runPasskeyAction<T>(fn: () => Promise<T>): Promise<PasskeyActionResult<T>> {
  try {
    return await fn() as T & { error?: undefined }
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 403) return { error: 'twoFactorRequired' }
    if (error instanceof GovernanceError && error.detail === 'not_found') return { error: 'passkeyNotFound' }
    if (error instanceof z.ZodError) return { error: 'validationGeneric' }
    throw error
  }
}

export async function listPasskeys(): Promise<PasskeyActionResult<{ passkeys: PasskeySummary[] }>> {
  return runPasskeyAction(async () => {
    const active = await requirePasskeySession()
    if (!active) return { error: 'authRequired' } as never
    return { passkeys: await listUserPasskeys(active.user.id) }
  })
}

async function renamePasskeyBody(input: { id: string; name: string }): Promise<PasskeyActionResult<{ passkey: PasskeySummary }>> {
  return runPasskeyAction(async () => {
    const active = await requirePasskeySession()
    if (!active) return { error: 'authRequired' } as never
    return { passkey: await renameUserPasskey(active.user.id, active.session.id, input) }
  })
}

async function deletePasskeyBody(input: { id: string }): Promise<PasskeyActionResult<{ deleted: true }>> {
  return runPasskeyAction(async () => {
    const active = await requirePasskeySession()
    if (!active) return { error: 'authRequired' } as never
    return deleteUserPasskey(active.user.id, active.session.id, input)
  })
}

export async function renamePasskey(...args: Parameters<typeof renamePasskeyBody>) {
  return withFreshSession(() => renamePasskeyBody(...args))
}

export async function deletePasskey(...args: Parameters<typeof deletePasskeyBody>) {
  return withFreshSession(() => deletePasskeyBody(...args))
}
