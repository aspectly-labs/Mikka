'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import type { SuggestionSource } from '@/lib/db/schema'
import { GitHubIcon, GmailIcon, LinearIcon, NotionIcon, SlackIcon } from '@/components/icons/brand-icons'
import { cardExtras, cardParts, SOURCE_NAMES, type SuggestionCard } from '@/lib/suggestions/card'

/** The app's own mark, 12px (R-21: the app's icon inline). */
export function SourceMark({ source }: { source: SuggestionSource }) {
  if (source === 'slack') return <SlackIcon />
  const Icon = source === 'gmail' ? GmailIcon : source === 'github' ? GitHubIcon : source === 'notion' ? NotionIcon : LinearIcon
  return <Icon className="size-3 shrink-0" />
}

/** The app named inside the sentence: its mark only, so a bold name does not read as part of the sentence (R-21); the name is for screen readers. 4px either side keeps the mark off the words. */
function SourceMention({ source }: { source: SuggestionSource }) {
  return <span data-slot="source-mention" className="mx-1 inline-flex h-5.5 items-center align-bottom"><SourceMark source={source} /><span className="sr-only">{SOURCE_NAMES[source]}</span></span>
}

/**
 * A 建议 item as a mobile-style card (Figma F8 `420:5831`, R-21): a verb chip,
 * then one sentence with the app named inline. Once tapped, the chat records it as
 * one line (SuggestionRow).
 */
export function SuggestionCardBody({ card }: { card: SuggestionCard }) {
  const t = useTranslations('SuggestionsPage')
  const { verb, parts } = cardParts(card, t(`action.${card.action}`))
  return <span className="flex min-w-0 items-start gap-2.5 text-left text-sm leading-5.5 font-normal whitespace-normal text-foreground">
    {verb && <span className="shrink-0 rounded-md bg-muted px-2 text-sm leading-5.5">{verb}</span>}
    <span data-slot="suggestion-words" className="line-clamp-3 min-w-0 wrap-anywhere">{parts.map((part, index) => part.kind === 'source' ? <SourceMention key={index} source={part.source} /> : <span key={index}>{part.text}</span>)}</span>
  </span>
}

/** The card's frame: one 1px line, no shadow, a 16px radius. */
export const CARD_FRAME = 'rounded-[16px] border border-border bg-background px-5 py-4'

/**
 * A 建议 the person handed over, as its one-line record in the chat (Capy records a request as a row with a status
 * word, never a card): 建议, the card's sentence with the app named inline, then its state. The sentence opens the
 * item in its app when it has a link; the source's own words, when the line shows an action instead, are its title.
 */
export function SuggestionRow({ card, status }: { card: SuggestionCard; status: string }) {
  const t = useTranslations('SuggestionsPage')
  const tNav = useTranslations('Nav')
  const { verb, parts } = cardParts(card, t(`action.${card.action}`))
  const { original, url } = cardExtras(card)
  const words = <>{verb && <span className="font-medium text-foreground">{verb} </span>}{parts.map((part, index) => part.kind === 'source'
    ? <span key={index} className="mx-0.5 inline-flex items-center align-[-2px]"><SourceMark source={part.source} /><span className="sr-only">{SOURCE_NAMES[part.source]}</span></span>
    : <span key={index}>{part.text}</span>)}</>
  return <p data-event-line="suggestion" data-slot="suggestion-row" className="mx-auto flex min-w-0 max-w-full items-center justify-center gap-1.5 text-xs text-muted-foreground">
    <span className="shrink-0">{tNav('suggestions')}</span>
    <span aria-hidden="true">·</span>
    <span data-slot="suggestion-words" className="min-w-0 truncate" title={original ?? undefined}>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">{words}</a> : words}
    </span>
    <span aria-hidden="true">·</span>
    <span role="status" className="shrink-0">{status}</span>
  </p>
}
