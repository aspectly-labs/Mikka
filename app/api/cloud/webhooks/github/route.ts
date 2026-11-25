import { pool } from '@/lib/db'
import { cloudClient } from '@/lib/cloud-services/runtime'
import { createCloudGitHubReceiver, verifyCloudGitHubSignature } from '@/lib/github/cloud-webhook'
import { dispatchVerifiedGitHubWebhook, readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { defineRoute } from '@/lib/primitives/define-route'

const noStore = { 'Cache-Control': 'no-store' } as const

function webhookFailure(error: unknown) {
  console.error(JSON.stringify({ event: 'cloud_github_webhook_failed', causeName: error instanceof Error ? error.name : 'unknown' }))
  return new Response(null, { status: 503, headers: noStore })
}

export const POST = defineRoute(
  {
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    route: '/api/cloud/webhooks/github',
    verifyWebhook: async request => {
      try {
        const registration = await cloudClient.registration()
        if (!registration) return new Response(null, { status: 401, headers: noStore })
        const body = await readGitHubWebhookBody(request)
        if (body === null) return new Response(null, { status: 413, headers: noStore })
        if (!verifyCloudGitHubSignature(body, request.headers.get('Mikka-Cloud-Signature'), registration.serverSecret)) {
          return new Response(null, { status: 401, headers: noStore })
        }
        return { ok: true, payload: { registration, body } }
      } catch (error) {
        return webhookFailure(error)
      }
    },
  },
  async ({ request, webhook }) => {
    const receive = createCloudGitHubReceiver({
      database: pool,
      registration: async () => webhook!.registration,
      readBody: async () => webhook!.body,
      dispatch: dispatchVerifiedGitHubWebhook,
    })
    try { return await receive(request) }
    catch (error) { return webhookFailure(error) }
  },
)
