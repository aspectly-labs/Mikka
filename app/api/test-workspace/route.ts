import { getTranslations } from '@/lib/intl/i18n-server'
import { createHmac } from 'node:crypto'
import { auth, authBaseURL } from '@/lib/auth'
import { defineRoute } from '@/lib/primitives/define-route'
import { envExact, readEnv } from '@/lib/env/server'
import { DEFAULT_LOCAL_DEV_ORIGIN } from '@/lib/env/hosts'

async function handlePOST(request: Request) {
  const i18nText = await getTranslations();
  if (!envExact('NODE_ENV', 'development')) return new Response(null, { status: 404 })

  const origin = request.headers.get('origin')
  const trustedOrigins = [
    DEFAULT_LOCAL_DEV_ORIGIN,
    authBaseURL,
    readEnv('V0_RUNTIME_URL'),
    readEnv('V0_DEV_APP_URL'),
    readEnv('V0_BUILD_URL'),
    readEnv('V0_SANDBOX_URL'),
  ]
    .filter((value): value is string => Boolean(value))
    .map(value => new URL(value).origin)
  if (!origin || !trustedOrigins.includes(origin)) return new Response(null, { status: 403 })

  const secret = readEnv('BETTER_AUTH_SECRET')
  if (!secret) return new Response(null, { status: 503 })

  const fingerprint = createHmac('sha256', secret).update('mikka-preview-test-account').digest('hex')
  const credentials = { email: `mikka-preview-${fingerprint.slice(0, 16)}@example.com`, password: fingerprint }
  try {
    let response = await auth.api.signInEmail({ body: credentials, headers: request.headers, asResponse: true })
    if (!response.ok) {
      response = await auth.api.signUpEmail({ body: { ...credentials, name: 'Mikka Test Account' }, headers: request.headers, asResponse: true })
      if (!response.ok) response = await auth.api.signInEmail({ body: credentials, headers: request.headers, asResponse: true })
    }
    if (!response.ok) return new Response(null, { status: 503 })

    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const cookie of response.headers.getSetCookie()) headers.append('Set-Cookie', cookie)
    return new Response(null, { status: 204, headers })
  } catch {
    console.error(i18nText("FeatureCopy.c_2c441a6c"))
    return new Response(null, { status: 503 })
  }
}

export const POST = defineRoute<'public', 'none'>(
  {
    route: '/api/test-workspace',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handlePOST(request),
)
