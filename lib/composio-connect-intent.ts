import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { B64URL_43, loopbackReturn } from './loopback'

/**
 * Plugins (Composio) from the desktop app: like the GitHub link
 * (lib/github/connect-intent.ts), the authorization runs in the system
 * browser and the app takes the return on its own loopback listener
 * (RFC 8252 §7.3). The one-time token names the app's account and where to
 * return, so the browser's own session no longer decides anything. It is
 * single use, lives ten minutes, and is stored only as a hash. Composio keeps
 * the credentials; the intent carries none.
 */
export const COMPOSIO_INTENT_TTL_MS = 10 * 60_000
const TOKEN = /^coi_[A-Za-z0-9_-]{43}$/
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
export const isComposioIntentToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)

type Query = Pick<Pool, 'query'>

export type ComposioIntent = {
  tokenHash: string
  userId: string
  toolkit: string
  replaceAccountId: string | null
  returnTo: string
  returnState: string
}

/** A desktop app that can take the return on its loopback: where to return and the state its listener expects. */
export function composioLoopback(value: unknown): { returnTo: string; returnState: string } | null {
  if (!value || typeof value !== 'object') return null
  const { returnTo, returnState } = value as Record<string, unknown>
  const to = loopbackReturn(returnTo)
  if (!to || typeof returnState !== 'string' || !B64URL_43.test(returnState)) return null
  return { returnTo: to, returnState }
}

/** A new token for the signed-in app's own account and one link: a toolkit to connect, or an account to reconnect. */
export async function createComposioConnectIntent(
  query: Query,
  input: { userId: string; toolkit: string; replaceAccountId: string | null; returnTo: string; returnState: string },
  now = new Date(),
) {
  const token = `coi_${randomBytes(32).toString('base64url')}`
  await query.query('DELETE FROM composio_connect_intents WHERE "userId"=$1 AND "expiresAt" < $2', [input.userId, now])
  await query.query(
    'INSERT INTO composio_connect_intents ("tokenHash","userId","toolkit","replaceAccountId","returnTo","returnState","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [hash(token), input.userId, input.toolkit, input.replaceAccountId, input.returnTo, input.returnState, new Date(now.getTime() + COMPOSIO_INTENT_TTL_MS)],
  )
  return { token }
}

/** The browser opened the link: the intent it names, however stale — its returnTo can still say why it failed. */
export async function readComposioConnectIntent(query: Query, token: unknown): Promise<ComposioIntent | null> {
  if (!isComposioIntentToken(token)) return null
  const { rows: [row] } = await query.query<ComposioIntent>(
    'SELECT "tokenHash","userId","toolkit","replaceAccountId","returnTo","returnState" FROM composio_connect_intents WHERE "tokenHash"=$1',
    [hash(token)],
  )
  return row ?? null
}

/** Starts the link exactly once while the token lives; null when it is spent or dead. */
export async function claimComposioConnectIntent(query: Query, token: unknown, now = new Date()): Promise<ComposioIntent | null> {
  if (!isComposioIntentToken(token)) return null
  const { rows: [row] } = await query.query<ComposioIntent>(
    'UPDATE composio_connect_intents SET "usedAt"=$2 WHERE "tokenHash"=$1 AND "usedAt" IS NULL AND "expiresAt" > $2 RETURNING "tokenHash","userId","toolkit","replaceAccountId","returnTo","returnState"',
    [hash(token), now],
  )
  return row ?? null
}

/** Composio's connect page gave the link's connected account id; the shared callback looks the intent up by it. */
export async function linkComposioConnectIntent(query: Query, tokenHash: string, linkId: string): Promise<void> {
  await query.query('UPDATE composio_connect_intents SET "linkId"=$2 WHERE "tokenHash"=$1', [tokenHash, linkId])
}

/** The callback names the connected account it completed: the live intent it belongs to, if any. */
export async function composioConnectIntentByLink(query: Query, linkId: string, now = new Date()): Promise<ComposioIntent | null> {
  const { rows: [row] } = await query.query<ComposioIntent>(
    'SELECT "tokenHash","userId","toolkit","replaceAccountId","returnTo","returnState" FROM composio_connect_intents WHERE "linkId"=$1 AND "usedAt" IS NOT NULL AND "expiresAt" > $2',
    [linkId, now],
  )
  return row ?? null
}
