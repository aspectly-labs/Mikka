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
 * bloub's twelve colours, still stored in `bots.color` by older clients and
 * still accepted from them. They draw as the body's own colour.
 */
export const BOT_COLORS = ['encre', 'brun', 'rouge', 'orange', 'ambre', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'gris', 'creme'] as const
export type BotColor = (typeof BOT_COLORS)[number]
export const DEFAULT_BOT_COLOR: BotColor = 'encre'

/**
 * What a person can change about a bot's look besides its body (decision
 * 2026-11-25-1400): bot-avatars' own props. Every field left out is the body's
 * default, so `{}` is the body as shipped.
 */
export interface BotLook {
  /** One of BOT_LOOK_COLORS; absent is the body's own colour. */
  color?: BotLookColor
  /** 'mouth' adds a small mouth; absent is the eyes alone. */
  face?: 'mouth'
  hat?: BotHat
  glasses?: BotGlasses
  headphones?: boolean
  bowTie?: boolean
}

/** The colours a bot can wear (as Grok Bot's character card): ink, then the wheel, then grey. */
export const BOT_LOOK_COLORS = {
  ink: '#2b2f38', brown: '#8d5b3c', red: '#e5484d', orange: '#f76b15', amber: '#ffb224', green: '#30a46c',
  teal: '#12a594', blue: '#3e63dd', violet: '#8e4ec6', pink: '#d6409f', grey: '#8b8d98',
} as const
export type BotLookColor = keyof typeof BOT_LOOK_COLORS
export const BOT_HATS = ['beret', 'beanie', 'party', 'crown'] as const
export type BotHat = (typeof BOT_HATS)[number]
export const BOT_GLASSES = ['round', 'square', 'shades'] as const
export type BotGlasses = (typeof BOT_GLASSES)[number]

const LOOK_PREFIX = 'look:'
const has = <T extends string>(options: readonly T[], value: string | undefined): value is T => (options as readonly string[]).includes(value ?? '')

/**
 * A look is stored in `bots.color`, which every view that draws a bot already
 * carries next to its shape: `look:c=blue;f=m;h=beret;g=round;p;b` (at most 41
 * characters). Anything else (an old bloub colour, nothing) is the plain body.
 */
export function parseBotLook(stored: string | null | undefined): BotLook {
  if (!stored?.startsWith(LOOK_PREFIX)) return {}
  const look: BotLook = {}
  for (const part of stored.slice(LOOK_PREFIX.length).split(';')) {
    const [key, value] = part.split('=')
    if (key === 'c' && value && value in BOT_LOOK_COLORS) look.color = value as BotLookColor
    else if (key === 'f' && value === 'm') look.face = 'mouth'
    else if (key === 'h' && has(BOT_HATS, value)) look.hat = value
    else if (key === 'g' && has(BOT_GLASSES, value)) look.glasses = value
    else if (key === 'p') look.headphones = true
    else if (key === 'b') look.bowTie = true
  }
  return look
}

/** The `bots.color` value for a look; the plain body is the default colour id, as before. */
export function formatBotLook(look: BotLook): string {
  const parts = [
    look.color && `c=${look.color}`, look.face === 'mouth' && 'f=m', look.hat && `h=${look.hat}`,
    look.glasses && `g=${look.glasses}`, look.headphones && 'p', look.bowTie && 'b',
  ].filter(Boolean)
  return parts.length ? LOOK_PREFIX + parts.join(';') : DEFAULT_BOT_COLOR
}

/** Whether createBot and updateBot store this `color`: an old bloub colour, or a look that reads back as written. */
export function isStoredBotColor(value: string) {
  return has(BOT_COLORS, value) || (value.startsWith(LOOK_PREFIX) && formatBotLook(parseBotLook(value)) === value)
}

/** The longest bot name, in characters (createBot and updateBot). */
export const BOT_NAME_MAX = 60
