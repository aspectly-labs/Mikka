import { freshSessionRoute } from '@/lib/fresh-session'
import { privateHeaders } from '@/lib/credentials/http'
import { savedCredentialsRoute } from '@/lib/credentials/route'
import { defineRoute } from '@/lib/primitives/define-route'

const credentialAuthRequired = () => Response.json(
  { error: 'credential_auth_required' },
  { status: 401, headers: privateHeaders },
)

export const GET = defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', onAuthFailure: credentialAuthRequired },
  ({ request }) => savedCredentialsRoute(request),
)

const DELETEBody = defineRoute(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true, onAuthFailure: credentialAuthRequired },
  ({ request }) => savedCredentialsRoute(request),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const DELETE = freshSessionRoute(DELETEBody)
