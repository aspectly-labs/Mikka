import { verifyGitHubSignature } from '@/lib/suggestions/github-webhook'
import { dispatchVerifiedGitHubWebhook, readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { relayOfficialGitHubWebhook } from '@/lib/github/official-cloud-relay'
import { CloudServiceError } from '@/lib/cloud-services/errors'
import { defineRoute } from '@/lib/primitives/define-route'

const noStore = { 'Cache-Control': 'no-store' }

async function verifyGitHubWebhook(request: Request) {
  const secret = (await (await import('@/lib/github/app-config')).readGitHubAppConfig()).webhookSecret
  if (!secret) return new Response('Webhook is not configured.', { status: 503, headers: noStore })
  const rawBody = await readGitHubWebhookBody(request)
  if (rawBody === null) return new Response('Webhook payload is too large.', { status: 413, headers: noStore })
  if (!verifyGitHubSignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) {
    return new Response('Invalid webhook.', { status: 401, headers: noStore })
  }
  return { ok: true as const, payload: rawBody }
}

export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, string>(
  {
    route: '/api/webhooks/github',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyGitHubWebhook,
  },
  async ({ request, webhook: rawBody }) => {
    if (rawBody === undefined) return new Response('Invalid webhook.', { status: 401, headers: noStore })
    const response = await dispatchVerifiedGitHubWebhook(request.headers.get('x-github-event'), rawBody, { defer: true, deliveryId: request.headers.get('x-github-delivery') })
    if (response.status >= 400) return response
    try {
      await relayOfficialGitHubWebhook({ event: request.headers.get('x-github-event'), deliveryId: request.headers.get('x-github-delivery'), signature: request.headers.get('x-hub-signature-256'), body: rawBody })
    } catch (error) {
      // Existing official business handling remains in this deployment. A failed
      // bridge is non-2xx so the existing GitHub delivery sweep can recover it.
      console.error('github_cloud_relay_failed', { code: error instanceof CloudServiceError ? error.code : 'cloud_unavailable' })
      return new Response('GitHub relay temporarily unavailable.', { status: 503, headers: noStore })
    }
    return response
  },
)
