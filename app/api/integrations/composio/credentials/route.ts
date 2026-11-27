import { freshSessionRoute } from '@/lib/fresh-session'
import { getComposio } from '@/lib/composio'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { PluginError } from '@/lib/plugins/contracts'
import { connectWithCredentials, credentialConnectInput } from '@/lib/plugins/credential-connect'
import { credentialConnectDeps } from '@/lib/plugins/credential-connect-server'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * Connects an app with the person's own credentials (an API key, a token, a
 * login). The values go to Composio only; the response is the new account id,
 * never the values, and nothing about them is logged.
 */
const POSTBody = defineRoute(
  {
    route: '/api/integrations/composio/credentials',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, session }) => pluginResponse(async () => {
    const userId = await pluginActor(request, {}, session)
    const body = await pluginBody(request, credentialConnectInput)
    const client = getComposio()
    if (!client) throw new PluginError('composioNotConfigured', 503)
    return connectWithCredentials(credentialConnectDeps(client), userId, body)
  }, 201),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
