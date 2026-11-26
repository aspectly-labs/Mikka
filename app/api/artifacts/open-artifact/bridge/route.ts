import { openArtifactBridgeRequestSchema } from '@mikka/protocol/open-artifact'
import {
  authenticateOpenArtifact,
  authorizeOpenArtifact,
  guardOpenArtifact,
  syncOpenArtifactCatalog,
  verifyOpenArtifactBridgeHttpRequest,
  type VerifiedOpenArtifactBridgeRequest,
} from '@/lib/artifacts/open-artifact-bridge'
import { defineRoute, NO_STORE_PUBLIC_HEADERS, routeJson } from '@/lib/primitives/define-route'

export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, VerifiedOpenArtifactBridgeRequest>(
  {
    route: '/api/artifacts/open-artifact/bridge',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyOpenArtifactBridgeHttpRequest,
  },
  async ({ webhook }) => {
    if (!webhook) {
      return routeJson({ ok: false, error: 'invalidBridgeSignature' }, 401, NO_STORE_PUBLIC_HEADERS)
    }

    const parsed = openArtifactBridgeRequestSchema.safeParse(webhook.json)
    if (!parsed.success) {
      return routeJson({ ok: false, error: 'invalidBridgePayload' }, 400, NO_STORE_PUBLIC_HEADERS)
    }

    const body = parsed.data
    switch (body.action) {
      case 'authenticate': {
        const result = await authenticateOpenArtifact(body)
        return routeJson(result, 200, NO_STORE_PUBLIC_HEADERS)
      }
      case 'authorize': {
        const result = await authorizeOpenArtifact(body)
        return routeJson(result, 200, NO_STORE_PUBLIC_HEADERS)
      }
      case 'guard': {
        const result = await guardOpenArtifact(body)
        return routeJson(result, 200, NO_STORE_PUBLIC_HEADERS)
      }
      case 'sync': {
        const result = await syncOpenArtifactCatalog(body)
        if (!result.ok) {
          return routeJson({ ok: false, error: result.error }, result.status, NO_STORE_PUBLIC_HEADERS)
        }
        return routeJson(result, 200, NO_STORE_PUBLIC_HEADERS)
      }
    }
  },
)
