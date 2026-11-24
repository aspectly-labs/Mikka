import 'server-only'
import { eq } from 'drizzle-orm'
import { auth as apiAuth, type ApiSession } from '@/lib/api-auth'
import { auth as sessionAuth } from '@/lib/auth'
import { checkAvatarFile } from '@/lib/account/avatar-file'
import { saveAvatar } from '@/lib/account/avatar'
import { db, pool } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { ownerIssueListsChanged, ownerProfileListsChanged } from '@/lib/live/lists'
import {
  MobileAvatarError,
  type MobileProfileUser,
} from './mobile-profile-contract'

export class MobileProfileSessionError extends Error {
  constructor(
    readonly code: 'authRequired' | 'sessionRequired',
    readonly status: 401 | 403,
  ) {
    super(code)
  }
}

/**
 * Resolves a fresh human session for account-wide profile writes. Personal
 * access tokens are workspace-scoped and are refused with `403 sessionRequired`.
 */
export async function requireMobileHumanSession(request: Request): Promise<ApiSession> {
  const session = await apiAuth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  })
  if (!session?.user) throw new MobileProfileSessionError('authRequired', 401)
  if (session.tokenId) throw new MobileProfileSessionError('sessionRequired', 403)
  return session
}

export async function readMobileProfile(userId: string): Promise<MobileProfileUser | null> {
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row ? { id: row.id, name: row.name, email: row.email, image: row.image ?? null } : null
}

/** Single owning profile display-name write via Better Auth + live list fanout. */
export async function updateMobileProfileName(
  request: Request,
  userId: string,
  name: string,
): Promise<MobileProfileUser | null> {
  await sessionAuth.api.updateUser({ body: { name }, headers: request.headers })
  await ownerIssueListsChanged(pool, userId)
  await ownerProfileListsChanged(pool, userId)
  return readMobileProfile(userId)
}

/** Single owning avatar validation, storage and user.image update for mobile. */
export async function updateMobileProfileAvatar(
  request: Request,
  userId: string,
  declaredType: string,
  bytes: Uint8Array,
): Promise<{ image: string; user: MobileProfileUser | null }> {
  const checked = checkAvatarFile(declaredType, bytes)
  if (!checked.ok) {
    throw new MobileAvatarError(
      checked.reason === 'size' ? 'avatarTooLarge' : 'avatarInvalidType',
      checked.reason === 'size' ? 413 : 400,
    )
  }
  const image = await saveAvatar(userId, checked.contentType, checked.bytes)
  await sessionAuth.api.updateUser({ body: { image }, headers: request.headers })
  await ownerIssueListsChanged(pool, userId)
  await ownerProfileListsChanged(pool, userId)
  return { image, user: await readMobileProfile(userId) }
}
