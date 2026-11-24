import { freshSessionRoute } from '@/lib/fresh-session'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { mobileProfilePatchSchema } from '@/lib/mobile-profile-contract'
import {
  MobileProfileSessionError,
  readMobileProfile,
  requireMobileHumanSession,
  updateMobileProfileName,
} from '@/lib/mobile-profile'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

/** `GET /api/mobile/profile`: the signed-in person's profile fields. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const profile = await readMobileProfile(user.id)
  if (!profile) return unauthorized()
  return json({ user: profile })
}

/**
 * `PATCH /api/mobile/profile` with `{ name }`: updates the person's display
 * name through Better Auth's `updateUser` (the same owning writer as
 * `app/actions/account.ts:updateDisplayName`). Requires a fresh human session;
 * PATs are rejected with `403 sessionRequired`.
 */
async function handlePATCH(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  let session
  try {
    session = await requireMobileHumanSession(request)
  } catch (error) {
    if (error instanceof MobileProfileSessionError) {
      return json({ error: error.code }, error.status)
    }
    throw error
  }
  noteLogUser(session.user.id)
  const parsed = mobileProfilePatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'validationNameRequired' }, 400)
  const { user: profile, setCookies } = await updateMobileProfileName(request, session.user.id, parsed.data.name)
  if (!profile) return unauthorized()
  const response = json({ user: profile })
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}

export const GET = withRequestLog('/api/mobile/profile', handleGET)
export const PATCH = freshSessionRoute(withRequestLog('/api/mobile/profile', handlePATCH))
