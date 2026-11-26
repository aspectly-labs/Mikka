import { openArtifactWakeRequestSchema } from '@mikka/protocol/open-artifact'
import {
  deliverOpenArtifactWake,
  verifyOpenArtifactBridgeHttpRequest,
  type VerifiedOpenArtifactBridgeRequest,
} from '@/lib/artifacts/open-artifact-bridge'
import { defineRoute, NO_STORE_PUBLIC_HEADERS, routeJson } from '@/lib/primitives/define-route'

export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, VerifiedOpenArtifactBridgeRequest>(
  {
    route: '/api/artifacts/open-artifact/wake',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyOpenArtifactBridgeHttpRequest,
  },
  async ({ webhook }) => {
    if (!webhook) {
      return routeJson({ ok: false, error: 'invalidBridgeSignature' }, 401, NO_STORE_PUBLIC_HEADERS)
    }

    const parsed = openArtifactWakeRequestSchema.safeParse(webhook.json)
    if (!parsed.success) {
      return routeJson({ ok: false, error: 'invalidWakePayload' }, 400, NO_STORE_PUBLIC_HEADERS)
    }

    const result = await deliverOpenArtifactWake(parsed.data)
    if (!result.ok) {
      return routeJson({ ok: false, error: result.error }, result.status, NO_STORE_PUBLIC_HEADERS)
    }
    return routeJson(result, 200, NO_STORE_PUBLIC_HEADERS)
  },
)
