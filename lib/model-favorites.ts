/**
 * The model picker's favorites, as Capy's (`shared/model-picker-lab/picker.tsx`): a favorite saves a whole setup,
 * the menu option (model and route: Mikka 额度, a subscription or a key) with its reasoning level and serving speed.
 * Up to nine, in the person's order; the picker lists them first under 「Favorites」 with digit keys 1..9, and
 * picking one sets the chat's model, level and speed together.
 *
 * Mikka's existing account slots remain available to legacy clients and can seed a new device before it has local
 * slots. Capy's picker stores subsequent edits locally. An initialized empty local list is an intentional choice.
 * If a saved model disappears from the authorized menu, its account slot stays stored.
 *
 * The slot arithmetic is pure and tested (lib/model-favorites.test.ts); the reads and writes take a pool.
 */
import type { Pool } from 'pg'
import { z } from 'zod'
import { ActionFailureError } from './action-error'
import {
  HOSTED_CHOICE,
  MODEL_FAVORITES_MAX,
  groupModelOptions,
  pickerRouteKey,
  parseApiKeyOption,
  parseCreditsOption,
  type BotModelFavorite,
  type BotModelMenu,
  type BotModelMenuOption,
} from './bot-model-menu-view'
import { MODEL_ROUTING_EFFORTS, MODEL_SERVICE_TIERS, type ModelRoutingEffort, type ModelServiceTier } from './model-routing'
import { modelModesSchema } from './model-picker-options'
import { modelKeyOf, modesFor, modesFromTier, supportedModes, tierForModes, type ModelModes } from './model-capabilities'
import type { ExecutionSettings, ExecutionSettingsScope } from './execution-settings'

/** An option id as the menu lists it: a binding uuid, `credits:<vendor/model>` or `apikey:<keyId>:<model>`. */
export const favoriteOptionId = z.string().min(1).max(300).refine(id =>
  id !== HOSTED_CHOICE && (z.uuid().safeParse(id).success || parseCreditsOption(id) !== null || parseApiKeyOption(id) !== null))

const slotFields = z.strictObject({
  optionId: favoriteOptionId,
  effort: z.enum(MODEL_ROUTING_EFFORTS).nullable(),
  serviceTier: z.enum(MODEL_SERVICE_TIERS).nullable().optional(),
  modes: modelModesSchema.optional(),
})
type SlotInput = z.infer<typeof slotFields>
const validSlot = (slot: SlotInput) => slot.modes
  ? slot.serviceTier == null || slot.serviceTier === tierForModes(slot.modes)
  : slot.serviceTier !== undefined
/** Clients supply an option id. Only the server may attach the corresponding model key. */
export const modelFavoriteSlot = slotFields.refine(validSlot)
const storedSlot = slotFields.extend({ modelKey: z.string().min(1).optional(), routeKey: z.string().min(1).optional() }).refine(validSlot)
export interface ModelFavoriteSlot {
  optionId: string
  effort: ModelRoutingEffort | null
  serviceTier: ModelServiceTier | null
  modes?: ModelModes
  modelKey?: string
  routeKey?: string
}

/** A slot's position in a request. */
export const favoriteIndex = z.number().int().min(0).max(MODEL_FAVORITES_MAX - 1)

const refuse = (): never => { throw new ActionFailureError('validationGeneric') }

/** Stored slots as the app reads them: anything malformed is skipped, never thrown, and the list stops at the limit. */
export function readSlots(raw: unknown): ModelFavoriteSlot[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const slot = storedSlot.safeParse(item)
    if (!slot.success) return []
    const modes = slot.data.modes ?? modesFromTier(slot.data.serviceTier)
    return [{ ...slot.data, modes, serviceTier: slot.data.serviceTier === undefined ? tierForModes(modes) : slot.data.serviceTier }]
  }).slice(0, MODEL_FAVORITES_MAX)
}

/**
 * 「Add to favorites」 at the end, or, when the list is full, into the slot the person picked under 「Replace which
 * favorite」 (`replace`). An option already saved is not saved twice: its slot takes the new settings (or moves to
 * `replace`).
 */
export function withSlotAdded(slots: readonly ModelFavoriteSlot[], slot: ModelFavoriteSlot, replace?: number): ModelFavoriteSlot[] {
  const existing = slots.findIndex(item => sameModel(item, slot))
  if (replace === undefined) {
    if (existing >= 0) return slots.map((item, index) => index === existing ? slot : item)
    if (slots.length >= MODEL_FAVORITES_MAX) refuse()
    return [...slots, slot]
  }
  return withSlotUpdated(slots, replace, slot)
}

/** 「Update favorite」: the slot keeps its place and takes this setup; another slot saving the same option goes. */
export function withSlotUpdated(slots: readonly ModelFavoriteSlot[], index: number, slot: ModelFavoriteSlot): ModelFavoriteSlot[] {
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) refuse()
  return slots.flatMap((item, at) => at === index ? [slot] : sameModel(item, slot) ? [] : [item])
}

/** 「Remove from favorites」: the later slots move up one. */
export function withSlotRemoved(slots: readonly ModelFavoriteSlot[], index: number): ModelFavoriteSlot[] {
  if (!Number.isInteger(index) || index < 0 || index >= slots.length) refuse()
  return slots.filter((_, at) => at !== index)
}

/** A drag in the Favorites list: `order` names every current slot once, in its new order. */
export function withSlotsReordered(slots: readonly ModelFavoriteSlot[], order: readonly number[]): ModelFavoriteSlot[] {
  if (order.length !== slots.length || new Set(order).size !== order.length
    || order.some(index => !Number.isInteger(index) || index < 0 || index >= slots.length)) refuse()
  return order.map(index => slots[index])
}

function sameModel(a: ModelFavoriteSlot, b: ModelFavoriteSlot) {
  return a.optionId === b.optionId || Boolean(a.modelKey && a.modelKey === b.modelKey)
}

type MenuGroups = Pick<BotModelMenu, 'groups'>

/** Upgrade old slots from this menu's trusted route data. A legacy credits id
 * also identifies its model while disconnected; opaque legacy binding ids are
 * resolved when the binding next appears. The first saved setup wins ties. */
function canonicalSlots(slots: readonly ModelFavoriteSlot[], menu: MenuGroups): ModelFavoriteSlot[] {
  const options = new Map(menu.groups.flatMap(group => group.options).map(option => [option.id, option]))
  const routes = new Map([...options.values()].map(option => [pickerRouteKey(option), option]))
  const result: ModelFavoriteSlot[] = []
  for (const slot of slots) {
    const option = options.get(slot.optionId) ?? (slot.routeKey ? routes.get(slot.routeKey) : undefined)
    const credits = parseCreditsOption(slot.optionId)
    const modelKey = option ? option.modelKey ?? modelKeyOf(option.modelId, option.provider, option.route?.label)
      : slot.modelKey ?? (credits ? modelKeyOf(credits, 'mikka') : undefined)
    const canonical = { ...slot, ...(option ? { optionId: option.id } : {}), ...(option?.route?.source === 'subscription' ? { routeKey: pickerRouteKey(option) } : {}), ...(modelKey ? { modelKey } : {}), modes: slot.modes ?? modesFromTier(slot.serviceTier) }
    if (!result.some(item => sameModel(item, canonical))) result.push(canonical)
  }
  return result
}

export function menuFavorites(slots: readonly ModelFavoriteSlot[], menu: MenuGroups): BotModelFavorite[] {
  const listed = new Set(menu.groups.flatMap(group => group.options.map(option => option.id)))
  const modelRoutes = new Map(groupModelOptions(menu.groups).map(model => [model.key, model.routes]))
  const canonical = canonicalSlots(slots, menu)
  return canonical.flatMap<BotModelFavorite>(({ routeKey: _routeKey, ...slot }, index) => {
    if (listed.has(slot.optionId)) return [{ slot: index, ...slot }]
    // Project a replacement route for the same model without overwriting the saved route.
    const fallback = slot.modelKey && modelRoutes.get(slot.modelKey)?.find(option => !option.unavailable && !option.health)
    if (fallback) return [{ slot: index, ...slot, ...favoriteSettings(slot, fallback.capabilities), optionId: fallback.id }]
    // At capacity an occupied slot must be replaceable, even in a workspace without access to its route.
    return canonical.length === MODEL_FAVORITES_MAX
      ? [{ slot: index, optionId: `unavailable:${index}`, effort: null, serviceTier: null, unavailable: true }] : []
  })
}

/** Keep hidden slots in place while reordering the visible subset. */
export function reorderVisibleFavorites(slots: ModelFavoriteSlot[], order: number[], menu: MenuGroups) {
  const visible = menuFavorites(slots, menu).map(item => item.slot)
  if (order.length !== visible.length || new Set(order).size !== order.length || order.some(index => !visible.includes(index))) refuse()
  const fullOrder = slots.map((_, index) => index)
  visible.forEach((index, i) => { fullOrder[index] = order[i] })
  return withSlotsReordered(slots, fullOrder)
}

/** Fit an existing setup to current route capabilities after provider catalog changes. */
export function favoriteSettings(slot: Pick<SlotInput, 'effort' | 'serviceTier'> & { modes?: ModelModes }, capabilities?: BotModelMenuOption['capabilities']) {
  const modes = modesFor(capabilities, slot.modes ?? modesFromTier(slot.serviceTier))
  const effort = modes.pro ? null : capabilities ? capabilities.efforts.find(level => level === slot.effort) ?? null : slot.effort
  const serviceTier = modes.pro || modes.fast || modes.ultrafast || slot.serviceTier === 'standard' || slot.serviceTier === undefined ? tierForModes(modes) : null
  return { effort, serviceTier, modes }
}

/** Older servers write only the three legacy fields. Reuse extended data only if those settings still match. */
function restoreSlotDetails(raw: unknown, details: unknown) {
  const extended = new Map(readSlots(details).map(slot => [slot.optionId, slot]))
  return readSlots(raw).map(slot => {
    const saved = extended.get(slot.optionId)
    return saved && slot.effort === saved.effort && slot.serviceTier === saved.serviceTier ? saved : slot
  })
}

/** Resolve old favorite binding ids. Only the authorized menu supplies routes to the caller. */
async function restoreRouteKeys(query: Pick<Pool, 'query'>, ownerId: string, slots: ModelFavoriteSlot[]) {
  const ids = [...new Set(slots.filter(slot => !slot.routeKey).map(slot => slot.optionId))].filter(id => z.uuid().safeParse(id).success)
  if (!ids.length) return slots
  const { rows } = await query.query<{ id: string; connectionId: string; modelId: string; provider: string }>(
    `SELECT b.id,b."connectionId",b."modelId",c.provider FROM byos_bindings b
     JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
     WHERE b."ownerId"=$1 AND b.id=ANY($2::uuid[])`, [ownerId, ids])
  const bindings = new Map(rows.map(row => [row.id, row]))
  return slots.map(slot => {
    const binding = bindings.get(slot.optionId)
    if (!binding) return slot
    return { ...slot, routeKey: `subscription:${binding.connectionId}:${binding.modelId}`,
      modelKey: slot.modelKey ?? modelKeyOf(binding.modelId, binding.provider) }
  })
}

/** Account favorite fallback for clients without initialized local slots. */
export async function readModelFavorites(pool: Pick<Pool, 'query'>, ownerId: string) {
  try {
    const { rows: [row] } = await pool.query<{ slots: unknown; details: unknown }>(
      `SELECT slots, to_jsonb(f)->'slotDetails' AS details FROM model_favorites f WHERE "ownerId"=$1`, [ownerId])
    return await restoreRouteKeys(pool, ownerId, restoreSlotDetails(row?.slots, row?.details))
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return []
    throw error
  }
}

/** Changes the person's favorites under a row lock, so two pickers saving at once neither lose a slot nor pass the limit. */
export async function changeModelFavorites(pool: Pick<Pool, 'connect'>, ownerId: string,
  change: (slots: ModelFavoriteSlot[]) => ModelFavoriteSlot[]): Promise<ModelFavoriteSlot[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO model_favorites ("ownerId") VALUES ($1) ON CONFLICT ("ownerId") DO NOTHING', [ownerId])
    const { rows: [row] } = await client.query<{ slots: unknown; slotDetails: unknown }>('SELECT slots,"slotDetails" FROM model_favorites WHERE "ownerId"=$1 FOR UPDATE', [ownerId])
    const restored = await restoreRouteKeys(client, ownerId, restoreSlotDetails(row?.slots, row?.slotDetails))
    const next = change(restored)
    const legacy = next.map(({ optionId, effort, serviceTier }) => ({ optionId, effort, serviceTier }))
    await client.query('UPDATE model_favorites SET slots=$2::jsonb, "slotDetails"=$3::jsonb, "updatedAt"=now() WHERE "ownerId"=$1', [ownerId, JSON.stringify(legacy), JSON.stringify(next)])
    await client.query('COMMIT')
    return next
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

type MenuSettings = ExecutionSettings
type FavoriteChange = { slot: SlotInput; replace?: number } | { index: number; slot: SlotInput }

/** The menu option a new setup names, with its settings fitted to it; refused when this menu does not list it. */
function listedSetup(menu: BotModelMenu, slot: SlotInput): ModelFavoriteSlot {
  const option = menu.groups.flatMap(group => group.options).find(item => item.id === slot.optionId)
  if (!option) throw new ActionFailureError('executionModelUnknown')
  if (slot.modes && !supportedModes(option.capabilities, slot.modes)) refuse()
  const modelKey = option.modelKey ?? modelKeyOf(option.modelId, option.provider, option.route?.label)
  return { optionId: slot.optionId, modelKey, ...(option.route?.source === 'subscription' ? { routeKey: pickerRouteKey(option) } : {}), ...favoriteSettings(slot, option.capabilities) }
}

/** Saves a setup the chat's menu lists (`slot` added, or written over slot `index`) and returns the menu. */
async function saveSetup(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null, change: FavoriteChange): Promise<BotModelMenu> {
  const { botModelMenu } = await import('./bot-model-menu')
  const menu = await botModelMenu(pool, settings, scope, botId)
  const parsed = modelFavoriteSlot.safeParse(change.slot)
  const slot = listedSetup(menu, parsed.success ? parsed.data : refuse())
  const slots = await changeModelFavorites(pool, scope.ownerId, current => {
    const saved = canonicalSlots(current, menu)
    return 'index' in change ? withSlotUpdated(saved, change.index, slot) : withSlotAdded(saved, slot, change.replace)
  })
  return { ...menu, favorites: menuFavorites(slots, menu) }
}

/** 「Add to favorites」, or into slot `replace` when the list is full (「Replace which favorite」). */
export function addModelFavorite(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null,
  slot: SlotInput, replace?: number): Promise<BotModelMenu> {
  return saveSetup(pool, settings, scope, botId, { slot, ...(replace === undefined ? {} : { replace }) })
}

/** 「Update favorite」: slot `index` takes this setup. */
export function updateModelFavorite(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null,
  index: number, slot: SlotInput): Promise<BotModelMenu> {
  return saveSetup(pool, settings, scope, botId, { index, slot })
}

/** 「Remove from favorites」. */
export async function removeModelFavorite(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null, index: number): Promise<BotModelMenu> {
  const menu = await (await import('./bot-model-menu')).botModelMenu(pool, settings, scope, botId)
  const next = await changeModelFavorites(pool, scope.ownerId, slots => withSlotRemoved(canonicalSlots(slots, menu), index))
  return { ...menu, favorites: menuFavorites(next, menu) }
}

/** A drag in the Favorites list: `order` is the current slots' indexes in their new order. */
export async function reorderModelFavorites(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null, order: number[]): Promise<BotModelMenu> {
  const menu = await (await import('./bot-model-menu')).botModelMenu(pool, settings, scope, botId)
  const next = await changeModelFavorites(pool, scope.ownerId, slots => reorderVisibleFavorites(canonicalSlots(slots, menu), order, menu))
  return { ...menu, favorites: menuFavorites(next, menu) }
}

/**
 * Picks favorite `index` for the chat: its option becomes the chat's model (the same save as any pick, which refuses
 * one not usable here), then its level and speed, fitted to that model, become the chat's. Returns the menu.
 */
export async function chooseModelFavorite(pool: Pool, settings: MenuSettings, scope: ExecutionSettingsScope, botId: string | null, index: number): Promise<BotModelMenu> {
  const { botModelMenu, chooseBotModel, setChatModelSettings } = await import('./bot-model-menu')
  const before = await botModelMenu(pool, settings, scope, botId)
  const slot = before.favorites?.find(item => item.slot === index)
  if (!slot || slot.unavailable) throw new ActionFailureError('executionModelUnknown')
  const menu = await chooseBotModel(pool, settings, scope, botId, slot.optionId)
  const previous = before.groups.flatMap(group => group.options).find(option => option.id === slot.optionId)!
  const option = menu.groups.flatMap(group => group.options).find(option => pickerRouteKey(option) === pickerRouteKey(previous))
  if (!option) throw new ActionFailureError('executionModelUnknown')
  const chosen = favoriteSettings(slot, option.capabilities ?? { efforts: [], effortSource: 'none', speedModes: [] })
  await setChatModelSettings(pool, scope, botId, chosen, option.capabilities)
  return { ...menu, chat: chosen }
}
