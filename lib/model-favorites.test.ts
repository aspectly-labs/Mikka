import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modesFromTier, NO_MODES } from './model-capabilities'
import { favoriteHolds, favoriteSlotOf, MODEL_FAVORITES_MAX, type BotModelMenu } from './bot-model-menu-view'
import {
  favoriteSettings,
  menuFavorites,
  modelFavoriteSlot,
  readSlots,
  reorderVisibleFavorites,
  withSlotAdded,
  withSlotRemoved,
  withSlotsReordered,
  withSlotUpdated,
  type ModelFavoriteSlot,
} from './model-favorites'

const binding = '11111111-1111-4111-8111-111111111111'
const key = '22222222-2222-4222-8222-222222222222'
const slot = (optionId: string, effort: ModelFavoriteSlot['effort'] = null, serviceTier: ModelFavoriteSlot['serviceTier'] = null): ModelFavoriteSlot => ({ optionId, effort, serviceTier })
const credits = (n: number) => slot(`credits:acme/model-${n}`)
const full = Array.from({ length: MODEL_FAVORITES_MAX }, (_, n) => credits(n))
const refused = { code: 'validationGeneric' }

test('Capy keeps nine favorites', () => {
  assert.equal(MODEL_FAVORITES_MAX, 9)
})

test('a slot names a menu option and a known level and speed, nothing else', () => {
  for (const id of [binding, 'credits:openai/gpt-6-sol', `apikey:${key}:deepseek-v4`]) assert.ok(modelFavoriteSlot.safeParse(slot(id, 'high', 'fast')).success, id)
  for (const bad of [
    slot('00000000-0000-0000-0000-000000000000'), slot('gpt-6'), slot(''), slot('credits:no-vendor'),
    { ...slot(binding), effort: 'ultra' }, { ...slot(binding), serviceTier: 'turbo' }, { ...slot(binding), extra: 1 }, { optionId: binding },
  ]) assert.equal(modelFavoriteSlot.safeParse(bad).success, false, JSON.stringify(bad))
})

test('stored slots skip what is malformed and stop at the limit', () => {
  assert.deepEqual(readSlots(null), [])
  assert.deepEqual(readSlots({}), [])
  assert.deepEqual(readSlots([credits(1), { optionId: 'nope' }, 7, slot(binding, 'low')]), [{ ...credits(1), modes: NO_MODES }, { ...slot(binding, 'low'), modes: NO_MODES }])
  assert.equal(readSlots([...full, credits(99)]).length, MODEL_FAVORITES_MAX)
})

test('Add to favorites goes at the end; a full list needs a slot to replace', () => {
  assert.deepEqual(withSlotAdded([credits(1)], credits(2)), [credits(1), credits(2)])
  assert.throws(() => withSlotAdded(full, credits(99)), refused)
  const replaced = withSlotAdded(full, credits(99), 3)
  assert.equal(replaced.length, MODEL_FAVORITES_MAX)
  assert.deepEqual(replaced[3], credits(99))
  assert.throws(() => withSlotAdded([credits(1)], credits(2), 1), refused, 'replace names an existing slot')
})

test('an option already saved is not saved twice', () => {
  const again = withSlotAdded([credits(1), slot(binding, 'low')], slot(binding, 'max', 'fast'))
  assert.deepEqual(again, [credits(1), slot(binding, 'max', 'fast')])
  assert.deepEqual(withSlotAdded(full, slot('credits:acme/model-4', 'high')), full.map((item, n) => n === 4 ? slot('credits:acme/model-4', 'high') : item), 'a full list still updates a saved option')
  assert.deepEqual(withSlotAdded([credits(1), credits(2), credits(3)], credits(3), 0), [credits(3), credits(2)], 'replacing moves a saved option')
})

test('Update favorite keeps the place; another slot with the same option goes', () => {
  const slots = [credits(1), credits(2), credits(3)]
  assert.deepEqual(withSlotUpdated(slots, 1, slot('credits:acme/model-2', 'high')), [credits(1), slot('credits:acme/model-2', 'high'), credits(3)])
  assert.deepEqual(withSlotUpdated(slots, 0, credits(3)), [credits(3), credits(2)])
  assert.throws(() => withSlotUpdated(slots, 3, credits(9)), refused)
  assert.throws(() => withSlotUpdated(slots, -1, credits(9)), refused)
  assert.throws(() => withSlotUpdated(slots, 0.5, credits(9)), refused)
})

test('Remove from favorites moves the later slots up', () => {
  assert.deepEqual(withSlotRemoved([credits(1), credits(2), credits(3)], 0), [credits(2), credits(3)])
  assert.throws(() => withSlotRemoved([credits(1)], 1), refused)
})

test('a reorder names every slot once', () => {
  const slots = [credits(1), credits(2), credits(3)]
  assert.deepEqual(withSlotsReordered(slots, [2, 0, 1]), [credits(3), credits(1), credits(2)])
  for (const bad of [[0, 1], [0, 0, 1], [0, 1, 3], [0, 1, 2, 3], [0, 1, 1.5]]) assert.throws(() => withSlotsReordered(slots, bad), refused, JSON.stringify(bad))
  assert.deepEqual(withSlotsReordered([], []), [])
})

const menu = (current: string, chat: BotModelMenu['chat'], slots: ModelFavoriteSlot[]): BotModelMenu => {
  const groups: BotModelMenu['groups'] = [{ kind: 'hosted', options: [
    { id: 'credits:acme/model-1', modelId: 'acme/model-1', provider: 'mikka', capabilities: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', effortSource: 'provider', speedModes: ['fast'] } },
  ] }]
  const option = groups[0].options.find(item => item.id === current) ?? groups[0].options[0]
  return { groups, current: { ...option, kind: 'hosted', chosen: true, available: true }, chat, favorites: menuFavorites(slots, { groups }) }
}

test('hidden routes retain their stored positions and return when reconnected', () => {
  const slots = [slot(binding), credits(1)]
  const { groups, favorites } = menu('credits:acme/model-1', undefined, slots)
  assert.deepEqual(favorites, [
    { slot: 1, ...credits(1), modelKey: 'acme/model-1', modes: NO_MODES },
  ])
  groups[0].options.push({ id: binding, modelId: 'plan-model', provider: 'codex' })
  assert.deepEqual(menuFavorites(slots, { groups }).map(f => [f.slot, f.optionId]), [[0, binding], [1, credits(1).optionId]])
})

test('a missing entry can project a runnable route for its model without changing the saved setup', () => {
  const saved = { ...slot(binding, 'max', 'fast'), modelKey: 'acme/model-1' }
  const { groups } = menu(credits(1).optionId, undefined, [])
  assert.deepEqual(menuFavorites([saved], { groups }).map(({ optionId, effort }) => [optionId, effort]), [[credits(1).optionId, null]])
  assert.equal(saved.optionId, binding)
  groups[0].options[0].unavailable = { reason: 'points' }
  assert.deepEqual(menuFavorites([saved], { groups }), [])
})

test('a full collection of disconnected routes offers replaceable slots without disclosing the routes', () => {
  const favorites = menuFavorites(full, { groups: [] })
  assert.equal(favorites.length, MODEL_FAVORITES_MAX)
  assert.ok(favorites.every((favorite, i) => favorite.slot === i && favorite.unavailable && favorite.optionId === `unavailable:${i}`))
  assert.equal(withSlotAdded(full, credits(99), favorites[4].slot)[4].optionId, credits(99).optionId)
})

test('reordering displayed slots leaves a disconnected route at its stored position', () => {
  const hidden = slot(binding), slots = [credits(1), hidden, credits(2)]
  const { groups } = menu(credits(1).optionId, undefined, [])
  groups[0].options.push({ id: credits(2).optionId, modelId: 'acme/model-2', provider: 'mikka' })
  assert.deepEqual(reorderVisibleFavorites(slots, [2, 0], { groups }), [credits(2), hidden, credits(1)])
  for (const order of [[0], [0, 1], [0, 0]]) assert.throws(() => reorderVisibleFavorites(slots, order, { groups }), refused)
})

test('the same model on another route updates one slot, including older rows without model keys', () => {
  const { groups } = menu(credits(1).optionId, undefined, [])
  groups[0].options.push({ id: binding, modelId: 'acme/model-1', provider: 'custom', modelKey: 'acme/model-1' })
  const legacy = menuFavorites([credits(1), slot(binding)], { groups })
  assert.equal(legacy.length, 1)
  assert.equal(favoriteSlotOf({ groups, favorites: legacy }, binding), 0)
  const changed = { ...slot(binding, 'high', 'fast'), modelKey: 'acme/model-1' }
  assert.deepEqual(withSlotAdded(legacy, changed), [changed])
  const legacyBinding = slot(binding)
  const newerCredits = { ...credits(1), modelKey: 'acme/model-1' }
  assert.deepEqual(menuFavorites([legacyBinding, newerCredits], { groups }).map(slot => slot.optionId), [legacyBinding.optionId])
})

test('new requests accept modes, reject conflicting modes, and keep model identity server-owned', () => {
  const input = { optionId: binding, effort: 'high', modes: { ...NO_MODES, pro: true } }
  assert.ok(modelFavoriteSlot.safeParse(input).success)
  for (const invalid of [{ ...input, modes: { ...input.modes, fast: true } }, { ...input, modelKey: 'forged/key' }, { ...input, serviceTier: 'fast' },
    { ...input, modes: { ...NO_MODES, daybreak: true } }]) assert.equal(modelFavoriteSlot.safeParse(invalid).success, false)
  assert.deepEqual(readSlots([slot(binding, 'high', 'ultrafast')])[0].modes, modesFromTier('ultrafast'))
})

test('picking a favorite fits its level and speed to the model', () => {
  const capabilities = { efforts: ['low', 'high'] as const, effortSource: 'provider' as const, speedModes: ['fast'] as const }
  const caps = { ...capabilities, efforts: [...capabilities.efforts], speedModes: [...capabilities.speedModes] }
  assert.deepEqual(favoriteSettings(slot(binding, 'high', 'fast'), caps), { effort: 'high', serviceTier: 'fast', modes: modesFromTier('fast') })
  assert.deepEqual(favoriteSettings(slot(binding, 'max', 'ultrafast'), caps), { effort: null, serviceTier: null, modes: NO_MODES })
  assert.deepEqual(favoriteSettings(slot(binding, null, 'standard'), caps), { effort: null, serviceTier: 'standard', modes: NO_MODES })
  assert.deepEqual(favoriteSettings(slot(binding, 'max', 'ultrafast')), { effort: 'max', serviceTier: 'ultrafast', modes: modesFromTier('ultrafast') }, 'unknown capabilities keep the setup')
})

test('Update favorite shows only when the chat differs from the slot', () => {
  const saved = [slot('credits:acme/model-1', 'medium', 'fast')]
  assert.equal(favoriteSlotOf(menu('credits:acme/model-1', undefined, saved), 'credits:acme/model-1'), 0)
  assert.equal(favoriteSlotOf(menu('credits:acme/model-1', undefined, saved), binding), -1)
  assert.equal(favoriteHolds(menu('credits:acme/model-1', { effort: 'medium', serviceTier: 'fast' }, saved), 0), true)
  assert.equal(favoriteHolds(menu('credits:acme/model-1', { effort: null, serviceTier: 'fast' }, saved), 0), true, 'the default level named equals the default')
  assert.equal(favoriteHolds(menu('credits:acme/model-1', { effort: 'high', serviceTier: 'fast' }, saved), 0), false)
  assert.equal(favoriteHolds(menu('credits:acme/model-1', { effort: 'medium', serviceTier: null }, saved), 0), false)
  assert.equal(favoriteHolds(menu('credits:acme/model-1', undefined, saved), 1), false)
})

test('explicit standard speed differs from inheriting the workspace speed', () => {
  const slot = { ...credits(1), serviceTier: 'standard' as const }
  assert.equal(favoriteHolds(menu(slot.optionId, { effort: null, serviceTier: null }, [slot]), 0), false)
})

test('Pro ignores effort for holds and still compares route and all four modes', () => {
  const pro = { ...NO_MODES, pro: true }
  const saved = { ...credits(1), modes: pro, effort: 'high' as const, serviceTier: 'standard' as const }
  const m = menu(saved.optionId, { effort: null, serviceTier: 'standard', modes: pro }, [saved])
  assert.equal(favoriteHolds(m, 0), true)
  assert.equal(favoriteHolds({ ...m, chat: { ...m.chat!, modes: NO_MODES } }, 0), false)
  assert.equal(favoriteHolds({ ...m, current: { ...m.current, id: binding } }, 0), false)
  assert.deepEqual(favoriteSettings(saved, { effortSource: 'provider', efforts: ['high'], speedModes: [], pro: true }), { effort: null, serviceTier: 'standard', modes: pro })
})
