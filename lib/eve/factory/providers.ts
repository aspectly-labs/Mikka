import { z } from 'zod'
import { EVE_FACTORY_PROVIDER_DEFAULT_MODELS } from '../../model-catalog-metadata'
import { eveFactoryRefusal, type EveFactoryDispatchRole } from './contract'

/**
 * #3082: third-party provider descriptors for the Eve Software Factory
 * route. A provider is a non-secret vendor/model-family identifier — never
 * a credential value. Capabilities are declared here so a missing feature is
 * an explicit refusal plus a recorded limitation, never a silent fallback to
 * Claude Code/Codex or a fake independent review.
 *
 * Reviewer independence is the hard gate: a provider that cannot run an
 * isolated principal (separate session identity, separate authorization
 * scope, no shared turn context with the implementer) must declare
 * `independentReviewer: false`; the adapter then refuses review dispatch and
 * reports the limitation rather than labelling a self-review independent.
 */
export interface EveFactoryProviderDescriptor {
  id: string
  /** LiteLLM/model-gateway aliases this provider may run, e.g.
   * 'openrouter/anthropic/claude-sonnet-4.5'. `*` allows any alias. */
  models: readonly string[]
  /** The hosted model alias used when a request names none. */
  defaultModel: string
  /** Provider-declared effort labels; empty means no effort selection. */
  effort: readonly string[]
  /** The provider can open an isolated reviewer session whose identity,
   * authorization scope and turn context are independent from the
   * implementer session that produced the candidate. */
  independentReviewer: boolean
  /** The provider's role sessions can be bound to the admitted task
   * workspace (the sponsored Cloudflare task machine). */
  workspaceWrite: boolean
}

/**
 * Registered third-party providers. Seeded conservatively — every entry is a
 * declared capability statement, and extending the route is adding a
 * descriptor, not a code path. Providers absent from this map refuse.
 * Model aliases are LiteLLM upstream routes, e.g. `openrouter/<org>/<model>`;
 * the gateway itself resolves the vendor, so the adapter holds no vendor key.
 */
const REGISTERED_PROVIDERS: Record<string, EveFactoryProviderDescriptor> = {
  'vercel-ai-gateway': { id: 'vercel-ai-gateway', models: ['*'], defaultModel: EVE_FACTORY_PROVIDER_DEFAULT_MODELS['vercel-ai-gateway'], effort: ['low', 'medium', 'high'], independentReviewer: true, workspaceWrite: true },
  'openrouter': { id: 'openrouter', models: ['*'], defaultModel: EVE_FACTORY_PROVIDER_DEFAULT_MODELS['openrouter'], effort: ['low', 'medium', 'high'], independentReviewer: true, workspaceWrite: true },
  'bedrock': { id: 'bedrock', models: ['*'], defaultModel: EVE_FACTORY_PROVIDER_DEFAULT_MODELS['bedrock'], effort: ['low', 'medium', 'high'], independentReviewer: true, workspaceWrite: true },
  'vertex-ai': { id: 'vertex-ai', models: ['*'], defaultModel: EVE_FACTORY_PROVIDER_DEFAULT_MODELS['vertex-ai'], effort: ['low', 'medium', 'high'], independentReviewer: true, workspaceWrite: true },
}

export function resolveEveFactoryProvider(provider: unknown): EveFactoryProviderDescriptor {
  if (typeof provider !== 'string' || !provider || provider.length > 128) {
    eveFactoryRefusal('eveFactoryProviderUnavailable')
  }
  const descriptor = REGISTERED_PROVIDERS[provider]
  if (!descriptor) eveFactoryRefusal('eveFactoryProviderUnavailable')
  return descriptor
}

export const eveFactoryProviderSelectionSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(500).optional(),
  effort: z.string().min(1).max(64).optional(),
})
export type EveFactoryProviderSelection = z.infer<typeof eveFactoryProviderSelectionSchema>

/** Validate a caller's provider/model/effort request against the registered
 * descriptor. Returns the descriptor plus effective model/effort. */
export function admitEveFactoryProvider(selection: unknown): {
  descriptor: EveFactoryProviderDescriptor
  model: string | null
  effort: string | null
} {
  const parsed = eveFactoryProviderSelectionSchema.safeParse(selection)
  if (!parsed.success) eveFactoryRefusal('eveFactoryProviderUnavailable')
  const descriptor = resolveEveFactoryProvider(parsed.data.provider)
  const model = parsed.data.model ?? null
  if (model && !descriptor.models.includes('*') && !descriptor.models.includes(model)) {
    eveFactoryRefusal('eveFactoryProviderUnavailable')
  }
  const effort = parsed.data.effort ?? null
  if (effort && !descriptor.effort.includes(effort)) {
    eveFactoryRefusal('eveFactoryProviderUnavailable')
  }
  return { descriptor, model, effort }
}

/** Role capability assertion. Refuses with the role-appropriate refusal and
 * returns the limitation labels the attempt must record — including
 * forward-looking limits (a missing independent reviewer capability is
 * evidence now even when the refusal lands at the review stage). */
export function assertEveFactoryRoleCapability(
  descriptor: EveFactoryProviderDescriptor,
  role: EveFactoryDispatchRole,
): string[] {
  const limitations: string[] = descriptor.independentReviewer ? [] : ['independent_vendor_reviewer']
  if (!descriptor.workspaceWrite) {
    // Every dispatched role session is bound to the task workspace; a provider
    // without that capability cannot run any of them honestly.
    limitations.push('workspace_write')
    eveFactoryRefusal('eveFactoryComputeUnavailable')
  }
  if (role === 'reviewer' && !descriptor.independentReviewer) {
    // Never run a same-principal review and call it independent.
    eveFactoryRefusal('eveFactoryReviewerUnavailable')
  }
  return limitations
}
