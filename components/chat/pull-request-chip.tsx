'use client'

import { GitPullRequest } from '@/components/icons'
import { useTranslations } from '@/lib/intl/i18n-client'
import { PULL_CHIP_TONES, type PullChipState } from '@/lib/pull-chip'
import { cn } from '@/lib/utils'

/** `repo#28` for a GitHub pull request URL, else null. */
export function pullRequestLabel(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== 'github.com') return null
  const [owner, repo, kind, number] = parsed.pathname.split('/').filter(Boolean)
  return owner && repo && kind === 'pull' && /^\d+$/.test(number ?? '') ? `${repo}#${number}` : null
}

const STATE_WORD = { ready: 'ready', pending: 'pending', draft: 'draft', merged: 'merged', closed: 'closed', failed: 'attention' } as const

/**
 * A PR named in a chat (#2922, Figma 1318:3): the git-pull-request mark in its state's colour and `repo#n` as a link.
 * A PR whose state the chat does not know keeps the mark uncoloured rather than guessing one.
 */
export function PullRequestChip({ url, state }: { url: string; state: PullChipState | null }) {
  const tState = useTranslations('PullDirectory.states')
  const label = pullRequestLabel(url) ?? url
  const stateWord = state ? tState(STATE_WORD[state]) : null
  return <a href={url} target="_blank" rel="noopener noreferrer" data-pull-chip={state ?? ''}
    aria-label={stateWord ? `${label}, ${stateWord}` : label} title={stateWord ?? undefined}
    className="inline-flex items-baseline gap-1 rounded-sm whitespace-nowrap text-object-chip-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
    <GitPullRequest aria-hidden="true" className={cn('size-3.5 shrink-0 self-center', state ? PULL_CHIP_TONES[state] : 'text-muted-foreground')} />
    {label}
  </a>
}
