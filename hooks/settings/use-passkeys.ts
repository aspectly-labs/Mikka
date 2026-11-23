'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { settingsReadOptions } from '@/lib/settings-data'
import { PASSKEY_NAME_MAX, type PasskeySummary } from '@/lib/account/passkeys-contract'
import type { PersonalSecurityState } from '@/lib/governance/organization-security-contract'

export { PASSKEY_NAME_MAX, type PasskeySummary }
export type { PersonalSecurityState }

export type PasskeyErrorKind = 'twoFactorRequired' | 'notFound' | 'invalidName' | 'cancelled' | 'failed'
export type TwoFactorErrorKind = 'invalidCode' | 'orgRequired' | 'twoFactorRequired' | 'failed'

export interface TwoFactorEnrollment {
  totpURI: string
  secret: string | null
  backupCodes: string[]
}

export const passkeysKey = 'account:passkeys' as const
export const personalSecurityKey = 'account:personal-security' as const
export const githubLinkedKey = 'account:github-linked' as const

export class PasskeyHttpError extends Error {
  constructor(
    public status: number,
    public code?: string,
    public detail?: string,
  ) {
    super(code ?? `http_${status}`)
    this.name = 'PasskeyHttpError'
  }
}

async function readJsonBody(response: Response): Promise<{ error?: { code?: string; detail?: string }; [key: string]: unknown } | null> {
  try {
    return await response.json() as { error?: { code?: string; detail?: string }; [key: string]: unknown }
  } catch {
    return null
  }
}

export async function fetchPasskeys(): Promise<{ passkeys: PasskeySummary[] }> {
  const response = await fetch(withBasePath('/api/me/passkeys'), { cache: 'no-store', credentials: 'same-origin' })
  const body = await readJsonBody(response)
  if (!response.ok) {
    throw new PasskeyHttpError(response.status, body?.error?.code, body?.error?.detail)
  }
  return { passkeys: Array.isArray(body?.passkeys) ? (body.passkeys as PasskeySummary[]) : [] }
}

export async function fetchPersonalSecurity(): Promise<PersonalSecurityState> {
  const response = await fetch(withBasePath('/api/me/security'), { cache: 'no-store', credentials: 'same-origin' })
  const body = await readJsonBody(response)
  if (!response.ok || !body) {
    throw new PasskeyHttpError(response.status, body?.error?.code, body?.error?.detail)
  }
  return body as unknown as PersonalSecurityState
}

function classifyAddError(error: { status?: number; code?: string; message?: string } | null | undefined): PasskeyErrorKind {
  if (!error) return 'failed'
  if (error.status === 403 || error.code === 'TWO_FACTOR_REQUIRED') return 'twoFactorRequired'
  const text = `${error.code ?? ''} ${error.message ?? ''}`
  if (/abort|cancel|not[_\s-]?allowed/i.test(text)) return 'cancelled'
  return 'failed'
}

function classifyMutationStatus(status: number, code?: string, detail?: string): PasskeyErrorKind {
  if (status === 403 || code === 'TWO_FACTOR_REQUIRED' || detail === 'two_factor_required') return 'twoFactorRequired'
  if (status === 404 || detail === 'not_found') return 'notFound'
  if (status === 400 || detail === 'invalid_request') return 'invalidName'
  return 'failed'
}

/**
 * Passkey list, WebAuthn registration (`authClient.passkey.addPasskey`), rename and deletion
 * against `/api/me/passkeys` (`WS-E` #3121). Surfaces `403 TWO_FACTOR_REQUIRED` explicitly when
 * the account has 2FA enabled and the current session has not completed second-factor step-up.
 */
export function usePasskeys() {
  const read = useSWR<{ passkeys: PasskeySummary[] }>(passkeysKey, fetchPasskeys, settingsReadOptions)
  const [pending, setPending] = useState<'add' | string | null>(null)
  const [actionError, setActionError] = useState<PasskeyErrorKind | null>(null)

  const unauthenticated = read.error instanceof PasskeyHttpError && read.error.status === 401
  const loading = read.isLoading && !read.data
  const loadError = Boolean(read.error) && !unauthenticated
  const passkeys = read.data?.passkeys ?? []

  async function add(name?: string): Promise<PasskeyErrorKind | null> {
    const trimmed = name?.trim() ?? ''
    if (trimmed.length > PASSKEY_NAME_MAX) {
      setActionError('invalidName')
      return 'invalidName'
    }
    setPending('add')
    setActionError(null)
    try {
      const result = await authClient.passkey.addPasskey(trimmed ? { name: trimmed } : undefined)
      if (result?.error) {
        const kind = classifyAddError(result.error as { status?: number; code?: string; message?: string })
        setActionError(kind)
        return kind
      }
      await read.mutate()
      return null
    } catch (error) {
      const cancelled = error instanceof Error && (
        error.name === 'NotAllowedError'
        || error.name === 'AbortError'
        || /abort|cancel|not[_\s-]?allowed/i.test(error.message)
      )
      const kind: PasskeyErrorKind = cancelled ? 'cancelled' : 'failed'
      setActionError(kind)
      return kind
    } finally {
      setPending(null)
    }
  }

  async function rename(passkeyId: string, name: string): Promise<PasskeyErrorKind | null> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > PASSKEY_NAME_MAX) {
      setActionError('invalidName')
      return 'invalidName'
    }
    setPending(passkeyId)
    setActionError(null)
    try {
      const response = await fetch(withBasePath(`/api/me/passkeys/${encodeURIComponent(passkeyId)}`), {
        method: 'PATCH',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      const body = await readJsonBody(response)
      if (!response.ok) {
        const kind = classifyMutationStatus(response.status, body?.error?.code, body?.error?.detail)
        if (kind === 'notFound') void read.mutate()
        setActionError(kind)
        return kind
      }
      const updated = body?.passkey as PasskeySummary | undefined
      if (updated) {
        await read.mutate(
          current => current ? { passkeys: current.passkeys.map(item => (item.id === passkeyId ? updated : item)) } : { passkeys: [updated] },
          { revalidate: false },
        )
      } else {
        await read.mutate()
      }
      return null
    } catch {
      setActionError('failed')
      return 'failed'
    } finally {
      setPending(null)
    }
  }

  async function remove(passkeyId: string): Promise<PasskeyErrorKind | null> {
    setPending(passkeyId)
    setActionError(null)
    try {
      const response = await fetch(withBasePath(`/api/me/passkeys/${encodeURIComponent(passkeyId)}`), {
        method: 'DELETE',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      const body = await readJsonBody(response)
      if (!response.ok) {
        const kind = classifyMutationStatus(response.status, body?.error?.code, body?.error?.detail)
        if (kind === 'notFound') void read.mutate()
        setActionError(kind)
        return kind
      }
      await read.mutate(
        current => current ? { passkeys: current.passkeys.filter(item => item.id !== passkeyId) } : current,
        { revalidate: false },
      )
      return null
    } catch {
      setActionError('failed')
      return 'failed'
    } finally {
      setPending(null)
    }
  }

  return {
    passkeys,
    loading,
    loadError,
    pending,
    actionError,
    clearError: () => setActionError(null),
    reload: () => { void read.mutate() },
    add,
    rename,
    remove,
  }
}

function extractTotpSecret(totpURI: string): string | null {
  try {
    return new URL(totpURI).searchParams.get('secret')
  } catch {
    return null
  }
}

async function postTwoFactor(path: string, payload: Record<string, unknown>) {
  const response = await fetch(withBasePath(`/api/auth/two-factor/${path}`), {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await readJsonBody(response)
  return { ok: response.ok, status: response.status, body }
}

/**
 * Personal two-step verification (TOTP + recovery codes + session step-up) backed by
 * `GET /api/me/security` and Better Auth's `/api/auth/two-factor/*` endpoints (`#2956`).
 */
export function useTwoFactorSettings() {
  const read = useSWR<PersonalSecurityState>(personalSecurityKey, fetchPersonalSecurity, settingsReadOptions)
  const [pending, setPending] = useState<'enable' | 'verify' | 'disable' | 'regenerate' | null>(null)
  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null)
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<TwoFactorErrorKind | null>(null)

  const unauthenticated = read.error instanceof PasskeyHttpError && (read.error.status === 401 || read.error.status === 403)
  const loading = read.isLoading && !read.data
  const loadError = Boolean(read.error) && !unauthenticated
  const state = read.data ?? null
  const orgRequiresTwoFactor = Boolean(state?.organizations.some(org => org.requireTwoFactor))

  async function startEnable(password?: string): Promise<boolean> {
    setPending('enable')
    setError(null)
    try {
      const { ok, status, body } = await postTwoFactor('enable', password ? { password } : {})
      if (!ok || typeof body?.totpURI !== 'string') {
        setError(status === 403 ? 'twoFactorRequired' : 'failed')
        return false
      }
      const codes = Array.isArray(body.backupCodes) ? (body.backupCodes as string[]) : []
      setEnrollment({ totpURI: body.totpURI, secret: extractTotpSecret(body.totpURI), backupCodes: codes })
      return true
    } catch {
      setError('failed')
      return false
    } finally {
      setPending(null)
    }
  }

  async function verifyCode(rawCode: string): Promise<boolean> {
    const trimmed = rawCode.trim()
    if (!trimmed) {
      setError('invalidCode')
      return false
    }
    setPending('verify')
    setError(null)
    try {
      const digits = trimmed.replace(/\s+/g, '')
      const endpoint = /^\d{6}$/.test(digits) && !enrollment?.backupCodes.includes(trimmed) ? 'verify-totp' : 'verify-backup-code'
      const first = await postTwoFactor(endpoint, { code: endpoint === 'verify-totp' ? digits : trimmed })
      if (!first.ok && endpoint === 'verify-totp' && !enrollment) {
        const fallback = await postTwoFactor('verify-backup-code', { code: trimmed })
        if (!fallback.ok) {
          setError(fallback.status === 401 || fallback.status === 400 ? 'invalidCode' : 'failed')
          return false
        }
      } else if (!first.ok) {
        setError(first.status === 401 || first.status === 400 ? 'invalidCode' : 'failed')
        return false
      }
      if (enrollment?.backupCodes.length) setGeneratedCodes(enrollment.backupCodes)
      setEnrollment(null)
      await read.mutate()
      return true
    } catch {
      setError('failed')
      return false
    } finally {
      setPending(null)
    }
  }

  async function regenerateBackupCodes(password?: string): Promise<boolean> {
    setPending('regenerate')
    setError(null)
    try {
      const { ok, status, body } = await postTwoFactor('generate-backup-codes', password ? { password } : {})
      if (!ok || !Array.isArray(body?.backupCodes)) {
        setError(status === 403 ? 'twoFactorRequired' : 'failed')
        return false
      }
      setGeneratedCodes(body.backupCodes as string[])
      return true
    } catch {
      setError('failed')
      return false
    } finally {
      setPending(null)
    }
  }

  async function disable(password?: string): Promise<boolean> {
    if (orgRequiresTwoFactor) {
      setError('orgRequired')
      return false
    }
    setPending('disable')
    setError(null)
    try {
      const { ok, status } = await postTwoFactor('disable', password ? { password } : {})
      if (!ok) {
        setError(status === 403 ? (orgRequiresTwoFactor ? 'orgRequired' : 'twoFactorRequired') : 'failed')
        return false
      }
      setEnrollment(null)
      setGeneratedCodes(null)
      await read.mutate()
      return true
    } catch {
      setError('failed')
      return false
    } finally {
      setPending(null)
    }
  }

  return {
    state,
    loading,
    loadError,
    orgRequiresTwoFactor,
    pending,
    enrollment,
    generatedCodes,
    error,
    clearError: () => setError(null),
    cancelEnroll: () => { setEnrollment(null); setError(null) },
    dismissCodes: () => setGeneratedCodes(null),
    reload: () => { void read.mutate() },
    startEnable,
    verifyCode,
    regenerateBackupCodes,
    disable,
  }
}

/** GitHub sign-in account link status from Better Auth's `listAccounts` + `linkSocial`. */
export function useGitHubSignIn() {
  const accounts = useSWR(githubLinkedKey, async () => {
    const { data, error } = await authClient.listAccounts()
    if (error) throw new Error('Accounts unavailable')
    return data?.some(account => account.providerId === 'github') ?? false
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  const [pending, setPending] = useState(false)
  const linked = accounts.error ? null : (accounts.data ?? null)

  async function link() {
    if (pending || linked) return
    setPending(true)
    try {
      const callbackURL = typeof window !== 'undefined' ? window.location.href : withBasePath('/settings?section=security')
      const result = await authClient.linkSocial({ provider: 'github', callbackURL })
      if (result.data?.url && typeof window !== 'undefined') window.location.assign(result.data.url)
    } catch {
      // Linking unavailability leaves current state intact.
    } finally {
      setPending(false)
    }
  }

  return { linked, pending, link, reload: () => { void accounts.mutate() } }
}
