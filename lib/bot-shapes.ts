/**
 * A bot's look is one of bot-avatars' eighteen bodies (libraries.dev/bots,
 * decision 2026-11-25-1200), each with its own colour. The hosted UI draws it;
 * this file only names the bodies so the API can check what it stores.
 */
export const BOT_SHAPES = [
  'clover', 'flower', 'triangle', 'square', 'blob', 'ghost', 'circle', 'drop', 'star',
  'droid', 'mech', 'alien', 'hexagon', 'cat', 'cloud', 'pill', 'pebble', 'puddle',
] as const
export type BotShape = (typeof BOT_SHAPES)[number]
export const DEFAULT_BOT_SHAPE: BotShape = 'clover'

/**
 * The sixteen bloub shapes bots were made with before, as stored in
 * `bots.shape` (the column's default is still 'cercle'). They are read, never
 * rewritten: each draws as the nearest body below. 'cercle' was everyone's
 * default, so a bot that never picked a shape gets a body from its id instead
 * of eighteen identical circles.
 */
export const LEGACY_BOT_SHAPES = {
  cercle: 'circle', galet: 'pebble', squircle: 'square', capsule: 'pill', triangle: 'triangle',
  hexagone: 'hexagon', nuage: 'cloud', goutte: 'drop', coeur: 'puddle', etoile: 'star',
  fleur: 'flower', chat: 'cat', champignon: 'droid', fantome: 'ghost', feuille: 'clover', ecran: 'mech',
} as const satisfies Record<string, BotShape>
export type LegacyBotShape = keyof typeof LEGACY_BOT_SHAPES

/** What createBot and updateBot accept: the bodies, and the old ids older clients still send. */
export const ACCEPTED_BOT_SHAPES = [...BOT_SHAPES, ...(Object.keys(LEGACY_BOT_SHAPES) as LegacyBotShape[]).filter(id => !(BOT_SHAPES as readonly string[]).includes(id))] as [string, ...string[]]

function hash(value: string) {
  let h = 2166136261
  for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return h >>> 0
}

/** The body a bot draws as, from what is stored (a body, an old bloub id, or nothing). */
export function botShapeOf({ id, shape }: { id?: string | null; shape?: string | null }): BotShape {
  if ((BOT_SHAPES as readonly string[]).includes(shape ?? '')) return shape as BotShape
  const legacy = shape === 'cercle' ? undefined : (LEGACY_BOT_SHAPES as Record<string, BotShape>)[shape ?? '']
  if (legacy) return legacy
  // The old default circle, nothing stored, or a value no client sends: a steady body from the id.
  if (id) return BOT_SHAPES[hash(id) % BOT_SHAPES.length]
  return shape === 'cercle' ? 'circle' : DEFAULT_BOT_SHAPE
}

/**
 * bloub's twelve colours, still stored in `bots.color` and still accepted from
 * older clients. A body draws in its own colour; nothing reads these for the
 * look any more.
 */
export const BOT_COLORS = ['encre', 'brun', 'rouge', 'orange', 'ambre', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'gris', 'creme'] as const
export type BotColor = (typeof BOT_COLORS)[number]
export const DEFAULT_BOT_COLOR: BotColor = 'encre'

/** The longest bot name, in characters (createBot and updateBot). */
export const BOT_NAME_MAX = 60
