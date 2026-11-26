/*
 * The model picker in a bot's composer (decision 2026-10-31-2330): what the
 * server sends to the web and mobile chips. No server imports, so both clients
 * and tests can read it.
 */

import { modelKeyOf, type ModelModes } from './model-capabilities'
import { modelDisplayName } from './model-display-name'
import type { ModelRouteHealth } from './model-route-rejection'

/**
 * The retired id of 「Mikka 默认」 (decision 2026-11-15-1900). No menu offers it
 * and no save accepts it; it only lets old clients and tests be recognised.
 */
export const HOSTED_CHOICE = '00000000-0000-0000-0000-000000000000'

/** The menu's id for a catalogue model run on Mikka 额度: `credits:<vendor/model>`. */
export const creditsOptionId = (model: string) => `credits:${model}`
export function parseCreditsOption(id: string): string | null {
  const match = /^credits:([a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._:-]*)$/.exec(id)
  return match && match[1].length <= 128 ? match[1] : null
}

/** The menu's id for a model an API key or custom provider serves (C22): `apikey:<keyId>:<model>`. */
export const apiKeyOptionId = (keyId: string, model: string) => `apikey:${keyId}:${model}`
export function parseApiKeyOption(id: string): { keyId: string; model: string } | null {
  const match = /^apikey:([0-9a-f-]{36}):(.+)$/i.exec(id)
  return match ? { keyId: match[1], model: match[2] } : null
}

/** The menu's groups, in the order they appear. `hosted` is Mikka 额度: the catalogue's models. */
export type BotModelGroupKind = 'hosted' | 'subscription' | 'apiKey' | 'shared'

export interface BotModelMenuOption {
  modelKey?: string
  /** A concrete route identity that survives creation of another binding for the same subscription. */
  entryId?: string
  /** What `chooseBotModel` saves: a binding id, a Mikka 额度 model (`creditsOptionId`), or an API key model (`apiKeyOptionId`). */
  id: string
  /** The model's id as its provider names it; a catalogue id (`vendor/model`) on Mikka 额度; empty when nothing is chosen. */
  modelId: string
  /** `claude`, `codex`, `mikka` for Mikka 额度, or an API key's provider (`anthropic`, `deepseek`, `custom`…). */
  provider: string
  /** Mikka 额度: the catalogue's name for the model and its USD list price per million tokens. */
  name?: string
  price?: { input: number; output: number }
  /**
   * @deprecated Compatibility flag kept while hosted `slots/onboarding.tsx`, `mobile-next` `wire/model.ts`,
   * and older serving clients still read `option.featured`; every hosted option sets `true` so nothing filters
   * Mikka credits to a featured subset.
   */
  featured?: boolean
  /** A community default uses cloud credits or the administrator's own provider. */
  hostedSource?: 'cloud' | 'self-hosted'
  /** What runs it (Figma 1318:71, #2925): Mikka 额度, a subscription or the person's own key, and which connection. */
  route?: BotModelRoute
  /** Set when this option cannot run now; the picker dims the row and says why. */
  unavailable?: BotModelUnavailable
  /** An observed block on this authorized route. */
  health?: ModelRouteHealth
  /** Its reasoning levels and serving speeds on this route (lib/model-capabilities.ts); the picker adapts to them. */
  capabilities?: import('./model-capabilities').ModelCapabilities
}

/**
 * The connection a menu option runs through. `credits` is Mikka 额度 (no connection); `subscription` is a
 * byos_connections id; `byok` is a model_api_keys id, the person's own or a teammate's shared key.
 * `label` names the connection as the person knows it (account label, key name and masked suffix); empty for credits.
 */
export interface BotModelRoute {
  kind?: 'credits' | 'plan' | 'key'
  source: 'credits' | 'subscription' | 'byok'
  connectionId: string | null
  label: string
  /** The subscription's service (`claude` | `codex`), whose own mark stands for the route. */
  service?: string
}

/** Why an option cannot run now: its subscription's usage limit (until `resetsAt`, when known) or no Mikka 额度 left. */
export type BotModelUnavailable = { reason: 'quota'; resetsAt: string | null } | { reason: 'points' }

export interface BotModelMenuGroup {
  kind: BotModelGroupKind
  /** The subscription's provider (`claude` | `codex`), for its heading. */
  provider?: string
  /** The subscription's plan, e.g. `Max`, when the provider reports one. */
  plan?: string | null
  /** For a shared credential: the name of the member it belongs to. */
  owner?: string
  /** Account label or key name and masked suffix; never a credential value. */
  credentialLabel?: string
  /** Mikka 默认: the points it can spend in this chat's workspace (its own and members' shared ones). */
  points?: number
  hostedSource?: 'cloud' | 'self-hosted'
  options: BotModelMenuOption[]
}

export interface BotModelCurrent extends BotModelMenuOption {
  /** `none`: nothing is chosen and no subscription or key fills in; the chip asks the person to choose (decision 2026-11-15-1900). */
  kind: BotModelGroupKind | 'none'
  /** The person picked it. False: it is what the resolution order gives today. */
  chosen: boolean
  /** True only when this credential is confirmed usable. */
  available: boolean
  /** Unknown or stale subscription quota remains selectable for a new check. */
  availability?: 'available' | 'checking' | 'exhausted'
  credentialLabel?: string
  /** The effective next choice differs from the stored preference. */
  fallback?: 'preference' | 'points' | 'quota'
  /**
   * Set when the subscription ran out of quota. With a fallback key, the rest
   * of `current` is that key's model, which the next turn uses.
   */
  quota?: BotModelQuota
}

/** A subscription out of quota, as the composer warns before sending (decision 2026-11-01-quota-exhausted). */
export interface BotModelQuota {
  /** The used-up subscription's provider (`claude` | `codex`). */
  subscription: string
  /** The subscription's plan, e.g. `Max`. */
  plan: string | null
  /** When the used-up window resets; null when the provider did not say. */
  resetsAt: string | null
  /** 订阅额度用完后，自动改用 API Key is on and the person has a key: the next turn runs on it. */
  fallback: { keyProvider: string; keyName: string | null; model: string } | null
}

/** A subscription's menu binding can rotate when the same account and model bind to another bot. */
export function pickerRouteKey(option: BotModelMenuOption): string {
  return option.route?.source === 'subscription' && option.route.connectionId
    ? `subscription:${option.route.connectionId}:${option.modelId}` : option.id
}

export interface ModelRouteGroup { key: string; name: string; routes: BotModelMenuOption[] }

const routeOrder: Record<BotModelGroupKind, number> = { subscription: 0, apiKey: 1, shared: 2, hosted: 3 }

export function orderedRouteGroups(groups: BotModelMenuGroup[]): BotModelMenuGroup[] {
  return [...groups].sort((a, b) => routeOrder[a.kind] - routeOrder[b.kind])
}

export function groupModelOptions(groups: BotModelMenuGroup[]): ModelRouteGroup[] {
  const byModel = new Map<string, ModelRouteGroup>()
  for (const group of orderedRouteGroups(groups)) {
    for (const option of group.options) {
      const key = option.modelKey ?? modelKeyOf(option.modelId, option.provider, option.route?.label)
      const model = byModel.get(key) ?? { key, name: option.name ?? modelDisplayName(key).name, routes: [] }
      model.routes.push(option)
      byModel.set(key, model)
    }
  }
  return [...byModel.values()]
}

export interface BotModelMenu {
  models?: ModelRouteGroup[]
  /** Compatibility echo from route validation. The client owns device-local preferences. */
  preferredRoutes?: Record<string, string>
  /** An observed reason for a previously selected route that is now disabled or signed out. */
  unavailableSelection?: ModelRouteHealth
  groups: BotModelMenuGroup[]
  current: BotModelCurrent
  /**
   * The chat's own reasoning level and serving speed (bot_model_choices), saved beside its model. `effort` null is
   * the model's default; `serviceTier` null is the workspace's default. The next run applies each only when the
   * model it freezes supports it (lib/model-capabilities.ts).
   */
  chat?: { modes?: ModelModes; effort: import('./model-routing').ModelRoutingEffort | null; serviceTier: import('./model-routing').ModelSpeedMode | 'standard' | null }
}

/** The option the chip and the menu's check mark stand for. */
export function isCurrent(menu: Pick<BotModelMenu, 'current'>, option: BotModelMenuOption) {
  return menu.current.id === option.id
}

/**
 * The menu as it reads the moment the person picks `id`, before the server answers: the chip and the check mark move
 * at once. Only what the menu already knows is claimed (the option, its group's kind and label); a fallback or a used-up
 * quota is the server's to say when it answers. Null when the menu has no such option.
 */
export function withChosenModel(menu: BotModelMenu, id: string): BotModelMenu | null {
  for (const group of menu.groups) {
    const option = group.options.find(item => item.id === id)
    if (option) return { ...menu, current: { ...option, kind: group.kind, chosen: true, available: true, ...(group.credentialLabel ? { credentialLabel: group.credentialLabel } : {}) } }
  }
  return null
}

/** Nothing chosen: what the menu reports when no choice, subscription or key applies. */
export const NO_MODEL: BotModelCurrent = { id: '', modelId: '', provider: '', kind: 'none', chosen: false, available: false }


/**
 * The person's own subscription a refused Mikka 额度 turn can move to (decision
 * 2240): the first in the menu's order, its first model. Null with none.
 */
export function ownSubscriptionOption(menu: Pick<BotModelMenu, 'groups'>): { option: string; provider: string; plan: string | null } | null {
  const group = menu.groups.find(item => item.kind === 'subscription' && item.owner === undefined && item.options.length > 0)
  return group ? { option: group.options[0].id, provider: group.provider ?? group.options[0].provider, plan: group.plan ?? null } : null
}
