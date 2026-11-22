import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GroupMember } from '@/lib/group-messages'

// The member list the group page read earlier, before the Bot's colour changed.
let cachedMembers: GroupMember[] | undefined
mock.module('swr', { defaultExport: () => ({ data: cachedMembers }) })
mock.module(new URL('./bot-avatar.tsx', import.meta.url).href, { namedExports: {
  BotAvatar: ({ id, color }: { id?: string; color?: string | null }) => <i data-bot={id} data-color={color ?? ''} />,
  COORDINATOR_AVATAR: { color: 'encre', shape: 'cercle', coordinator: true },
} })
mock.module(new URL('./letter-avatar.tsx', import.meta.url).href, { namedExports: { LetterAvatar: ({ name }: { name: string }) => <b>{name}</b> } })

test('the chat list draws the Bot faces its live group list carries, not an older member read', async () => {
  const { CachedGroupAvatar } = await import('./group-avatar')
  cachedMembers = [{ id: 'bot', name: 'Bot', memberType: 'bot', color: 'bleu', shape: 'cercle' }]
  const html = renderToStaticMarkup(<CachedGroupAvatar id="group" title="Group" bots={[{ id: 'bot', color: 'rouge', shape: 'cercle' }]} />)
  assert.match(html, /data-color="rouge"/)
  assert.doesNotMatch(html, /bleu/)
  assert.match(renderToStaticMarkup(<CachedGroupAvatar id="group" title="Group" />), /data-color="bleu"/, 'an older server\'s list without faces keeps the members already read')
})
