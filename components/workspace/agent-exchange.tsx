'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import type { GroupExchange } from '@/lib/group-messages'
import type { GroupParticipant } from '@/lib/group-participants'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { BotAvatar } from '@/components/slots/bot-avatar'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { AvatarGroup } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

type ExchangePage = {
  linkId: string
  participants: GroupParticipant[]
  messages: { id: string; position: string; body: string; createdAt: string; author: GroupParticipant }[]
  nextBefore: string | null
}

async function fetchExchange(linkId: string, before?: string | null): Promise<ExchangePage> {
  const params = new URLSearchParams({ limit: '50' })
  if (before) params.set('before', before)
  const response = await fetch(withBasePath(`/api/conversation-links/${linkId}/messages?${params}`), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error('exchange unavailable')
  return response.json()
}

function ParticipantAvatar({ p }: { p: GroupParticipant }) {
  return p.memberType === 'bot' ? <BotAvatar color={p.color} shape={p.shape} size="pill" still /> : <LetterAvatar name={p.name} size="pill" />
}

/** One `agent_exchange` marker in the group timeline; opens the bounded, read-only transcript. */
export function AgentExchangeMarker({ exchange }: { exchange: GroupExchange }) {
  const t = useTranslations('GroupChat.exchange')
  const [open, setOpen] = useState(false)
  const [a, b] = exchange.participants
  const names = b ? `${a?.name ?? '?'} & ${b.name}` : a?.name ?? '?'

  return <>
    <div className="flex w-full justify-center">
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}
        className="gap-1.5 rounded-full bg-muted/60 px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <AvatarGroup className="-space-x-1">
          {exchange.participants.map(p => <ParticipantAvatar key={p.id} p={p} />)}
        </AvatarGroup>
        {t('marker', { names, count: Number(exchange.count) })}
      </Button>
    </div>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-[380px] flex-col gap-0 p-0">
        <SheetTitle className="px-4 py-3 text-sm font-medium">{t('title', { names })}</SheetTitle>
        {open && <ExchangeTranscript linkId={exchange.linkId} />}
      </SheetContent>
    </Sheet>
  </>
}

function ExchangeTranscript({ linkId }: { linkId: string }) {
  const t = useTranslations('GroupChat.exchange')
  const { data, error } = useSWR(['group-exchange', linkId], () => fetchExchange(linkId))
  if (error) return <p className="px-4 py-6 text-sm text-muted-foreground">{t('loadError')}</p>
  if (!data) return <div className="flex justify-center py-6"><Spinner /></div>
  const messages = [...data.messages].sort((x, y) => BigInt(x.position) < BigInt(y.position) ? -1 : 1)
  return <ol className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4" aria-label={t('title', { names: '' })}>
    {messages.map(m => <li key={m.id} className="flex gap-2">
      <span className="mt-0.5 shrink-0"><ParticipantAvatar p={m.author} /></span>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{m.author?.name}</div>
        <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>
      </div>
    </li>)}
    {messages.length === 0 && <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>}
  </ol>
}
