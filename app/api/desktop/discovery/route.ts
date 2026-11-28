import { desktopDiscoveryResponse } from '@/lib/desktop-discovery'
import { authSignInMethods } from '@/lib/auth-config'
import { cloudConnected } from '@/lib/cloud-services/runtime'
import { defineRoute } from '@/lib/primitives/define-route'
import { envExact, runtimeEnv } from '@/lib/env/server'


/** Called before sign-in. The fixed /mikka mount is declared in the response;
 * desktop clients probing a bare origin retry this mount without redirects. */
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/desktop/discovery' },
  async ({ request }) => {
    const env = runtimeEnv()
    const signIn = authSignInMethods(env)
    if (envExact('GITHUB_SIGN_IN_USE_APP', 'true', env)) {
      // Manifest-managed credentials are optional. Ordinary discovery does not
      // initialize Better Auth or query the credential store.
      const { githubSignInEnabled } = await import('@/lib/auth')
      signIn.github = await githubSignInEnabled()
    }
    return desktopDiscoveryResponse(request, env, signIn, await cloudConnected())
  },
)
