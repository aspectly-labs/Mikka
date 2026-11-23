import { z } from 'zod'

export const PASSKEY_NAME_MAX = 100

export const passkeyIdSchema = z.string().trim().min(1).max(200)
export const passkeyNameSchema = z.string().trim().min(1).max(PASSKEY_NAME_MAX)

export const renamePasskeyInputSchema = z.strictObject({
  id: passkeyIdSchema,
  name: passkeyNameSchema,
})

export const renamePasskeyBodySchema = z.strictObject({
  name: passkeyNameSchema,
})

export const deletePasskeyInputSchema = z.strictObject({
  id: passkeyIdSchema,
})

/** Safe passkey view for settings and desktop RPC; omits raw publicKey, credentialID and counter. */
export type PasskeySummary = {
  id: string
  name: string | null
  providerName: string | null
  deviceType: string
  backedUp: boolean
  transports: string[]
  createdAt: string | null
  aaguid: string | null
}
