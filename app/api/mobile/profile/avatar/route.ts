import { forbiddenOrigin, json, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { MobileAvatarError, readMobileAvatarPayload } from '@/lib/mobile-profile-contract'
import {
  MobileProfileSessionError,
  requireMobileHumanSession,
  updateMobileProfileAvatar,
} from '@/lib/mobile-profile'
import { noteLogUser } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * `POST /api/mobile/profile/avatar`: uploads a PNG, JPEG or WebP avatar
 * (max 200 KB) as either `multipart/form-data` (`avatar` field) or raw image
 * bytes, reusing `checkAvatarFile` + `saveAvatar` + Better Auth `updateUser`.
 * Requires a fresh human session; PATs are rejected with `403 sessionRequired`.
 */
async function handlePOST(request: Request) {
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
  try {
    const payload = await readMobileAvatarPayload(request)
    const { image, user: profile, setCookies } = await updateMobileProfileAvatar(
      request,
      session.user.id,
      payload.declaredType,
      payload.bytes,
    )
    if (!profile) return unauthorized()
    const response = json({ image, user: profile })
    for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
    return response
  } catch (error) {
    if (error instanceof MobileAvatarError) return json({ error: error.code }, error.status)
    throw error
  }
}

export const POST = defineRoute<'mobile-or-session', 'none'>(
  {
    route: '/api/mobile/profile/avatar',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true,
  },
  async ({ request }) => handlePOST(request),
)
