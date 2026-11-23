'use client'

import { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape } from '@/lib/bot-shapes'
import { cn } from '@/lib/utils'

export { BOT_COLORS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_SHAPE, type BotColor, type BotShape }

export type BotMove = 'wide' | 'hexagon' | 'burst'
export type BotMood = 'idle' | 'thinking' | 'wink' | 'exclaim' | 'sleep' | BotMove

export const BOT_MOOD_SECONDS: Record<BotMood, number> = {
  idle: 2.4, thinking: 2.6, wink: 1.6, exclaim: 2, sleep: 2.4, wide: 1.8, hexagon: 1.6, burst: 2.6,
}

export const BOT_AVATAR_SIZES = {
  row: 16, pill: 22, message: 24, search: 28, list: 34, cell: 40, profile: 72, hero: 144,
} as const

export type BotAvatarSize = keyof typeof BOT_AVATAR_SIZES

export type BotAvatarProps = {
  color?: string | null
  shape?: string | null
  id?: string | null
  coordinator?: boolean
  size?: BotAvatarSize
  mood?: BotMood
  label?: string
  still?: boolean
  brisk?: boolean
}

const pick = <T extends string>(value: string | null | undefined, options: readonly T[], fallback: T) =>
  (options as readonly string[]).includes(value ?? '') ? value as T : fallback

/**
 * Public server-pages fallback avatar for shared views.
 * Official builds render the animated avatar inside the hosted workspace entry.
 */
export function BotAvatar({ color, shape, coordinator, size = 'list', mood = 'idle', label }: BotAvatarProps) {
  const tone = pick(color, BOT_COLORS, DEFAULT_BOT_COLOR)
  const form = pick(shape, BOT_SHAPES, DEFAULT_BOT_SHAPE)
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot="bot-avatar"
      data-color={tone}
      data-shape={form}
      data-mood={mood}
      data-coordinator={coordinator ? 'true' : undefined}
      className={cn(
        'relative inline-flex shrink-0 rounded-full',
        tone === 'encre' && 'bg-foreground',
        tone === 'brun' && 'bg-bot-brun',
        tone === 'rouge' && 'bg-bot-rouge',
        tone === 'orange' && 'bg-bot-orange',
        tone === 'ambre' && 'bg-bot-ambre',
        tone === 'vert' && 'bg-bot-vert',
        tone === 'turquoise' && 'bg-bot-turquoise',
        tone === 'bleu' && 'bg-bot-bleu',
        tone === 'violet' && 'bg-bot-violet',
        tone === 'rose' && 'bg-bot-rose',
        tone === 'gris' && 'bg-bot-gris',
        tone === 'creme' && 'bg-bot-creme',
        size === 'row' && 'size-4',
        size === 'pill' && 'size-5.5',
        size === 'message' && 'size-6',
        size === 'search' && 'size-7',
        size === 'list' && 'size-8.5',
        size === 'cell' && 'size-10',
        size === 'profile' && 'size-18',
        size === 'hero' && 'size-36',
      )}
    />
  )
}

/** A steady colour for something that has a name but no colour of its own, such as an agent assignee. */
export function colorFor(name: string): BotColor {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  // Cream is left out: next to other avatars it reads as empty.
  return BOT_COLORS[Math.abs(hash) % (BOT_COLORS.length - 1)]
}

/** The Coordinator's look (Figma 202:4518): the default ink circle, no badge. */
export const COORDINATOR_AVATAR = { color: 'encre', shape: 'cercle', coordinator: true } as const

/**
 * The Coordinator is a bot like any other. Where the same slot can show the
 * Coordinator or a bot, render `BotAvatar` with `COORDINATOR_AVATAR` instead,
 * so switching keeps one mounted blob that morphs.
 */
export function CoordinatorAvatar({ size = 'list', mood }: { size?: BotAvatarSize; mood?: BotMood }) {
  return <BotAvatar {...COORDINATOR_AVATAR} size={size} mood={mood} />
}
