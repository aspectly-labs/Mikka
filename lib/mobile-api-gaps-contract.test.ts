import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SearchInputError } from './issue-search'
import { AVATAR_MAX_BYTES } from './account/avatar-file'
import {
  buildMessageSearchSnippet,
  encodeMessageSearchCursor,
  parseMessageSearchInput,
} from './mobile-message-search-contract'
import { parseMobileAttachmentsQuery } from './mobile-attachments-contract'
import {
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  parseThreadPageParams,
  sliceThreadItemsPage,
} from './mobile-thread-pagination'
import {
  MobileAvatarError,
  mobileProfilePatchSchema,
  normalizeMediaType,
  readMobileAvatarPayload,
} from './mobile-profile-contract'
import {
  parseMobileBillingGetQuery,
  parseMobileBillingPostBody,
} from './mobile-billing-contract'

const WS_1 = '11111111-1111-4111-8111-111111111111'
const WS_2 = '22222222-2222-4222-8222-222222222222'
const BOT_1 = '33333333-3333-4333-8333-333333333333'
const CONV_1 = '44444444-4444-4444-8444-444444444444'
const MSG_1 = '55555555-5555-4555-8555-555555555555'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

test('Gap 1: parseMessageSearchInput validates query, scopes, limits and context-bound cursors', () => {
  const input = parseMessageSearchInput(
    new URLSearchParams({ q: 'deploy', scope: 'bot', botId: BOT_1, limit: '15' }),
    'user-1',
    WS_1,
  )
  assert.equal(input.q, 'deploy')
  assert.equal(input.workspaceId, WS_1)
  assert.equal(input.scope, 'bot')
  assert.equal(input.botId, BOT_1)
  assert.equal(input.conversationId, null)
  assert.equal(input.limit, 15)
  assert.equal(input.cursor, null)

  // Single CJK character is allowed; single ASCII character or empty is rejected.
  assert.equal(parseMessageSearchInput(new URLSearchParams({ q: '图' }), 'user-1', WS_1).q, '图')
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: '' }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchQueryTooShort',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'a' }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchQueryTooShort',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'x'.repeat(201) }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchQueryTooLong',
  )

  // Contradictory filters and unknown/out-of-range params fail closed.
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'hi', botId: BOT_1, conversationId: CONV_1 }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'hi', scope: 'group', botId: BOT_1 }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'hi', limit: '51' }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'hi', unknown: '1' }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )

  // Cursor round-trip succeeds only for the exact caller/workspace/scope/query binding.
  const cursor = encodeMessageSearchCursor(input, { time: '2026-11-24T12:00:00.123456Z', id: MSG_1 })
  const next = parseMessageSearchInput(
    new URLSearchParams({ q: 'deploy', scope: 'bot', botId: BOT_1, limit: '15', cursor }),
    'user-1',
    WS_1,
  )
  assert.deepEqual(next.cursor, { time: '2026-11-24T12:00:00.123456Z', id: MSG_1 })

  // Different user, workspace, or query rejects the cursor.
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'deploy', scope: 'bot', botId: BOT_1, cursor }), 'user-2', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'deploy', scope: 'bot', botId: BOT_1, cursor }), 'user-1', WS_2),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
  assert.throws(
    () => parseMessageSearchInput(new URLSearchParams({ q: 'other', scope: 'bot', botId: BOT_1, cursor }), 'user-1', WS_1),
    (err: unknown) => err instanceof SearchInputError && err.code === 'searchInvalidParam',
  )
})

test('Gap 1: buildMessageSearchSnippet strips inline file/citation markers and centers match', () => {
  const raw = `[mikka-file:${MSG_1}:spec.pdf]\n\n${'alpha '.repeat(40)}critical-token [[issue:${WS_1}]] ${'omega '.repeat(40)}`
  const snippet = buildMessageSearchSnippet(raw, 'critical-token', 80)
  assert.ok(snippet.includes('critical-token'))
  assert.ok(!snippet.includes('mikka-file'))
  assert.ok(!snippet.includes('[[issue:'))
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))
})

test('Gap 2: parseMobileAttachmentsQuery validates ids and scope queries strictly', () => {
  const byIds = parseMobileAttachmentsQuery(new URLSearchParams({ ids: `${MSG_1},${MSG_1},${CONV_1}`, download: '1' }))
  assert.deepEqual(byIds, { kind: 'ids', ids: [MSG_1, CONV_1], download: true })

  const byScope = parseMobileAttachmentsQuery(new URLSearchParams({ scope: 'group', id: CONV_1, limit: '25' }))
  assert.deepEqual(byScope, { kind: 'scope', scope: { kind: 'group', id: CONV_1 }, limit: 25, download: false })

  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams()), null)
  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams({ ids: '' })), null)
  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams({ ids: 'not-a-uuid' })), null)
  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams({ ids: MSG_1, scope: 'bot', id: BOT_1 })), null)
  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams({ scope: 'unknown', id: BOT_1 })), null)
  assert.equal(parseMobileAttachmentsQuery(new URLSearchParams({ scope: 'bot', id: BOT_1, limit: '51' })), null)
})

test('Gap 3: thread pagination preserves legacy unpaged mode and pages backwards deterministically', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `item-${i + 1}`, text: `msg ${i + 1}` }))

  // Legacy mode (no query params) returns all items.
  const legacyReq = parseThreadPageParams(new URLSearchParams())
  assert.deepEqual(legacyReq, { paged: false })
  const legacyPage = sliceThreadItemsPage(items, legacyReq!)
  assert.equal(legacyPage.items.length, 5)
  assert.equal(legacyPage.hasMore, false)
  assert.equal(legacyPage.historyBefore, null)
  assert.equal(legacyPage.totalItems, 5)

  // Initial paged request returns newest 2 items.
  const page1Req = parseThreadPageParams(new URLSearchParams({ limit: '2' }))
  assert.ok(page1Req && page1Req.paged)
  const page1 = sliceThreadItemsPage(items, page1Req!)
  assert.deepEqual(page1.items.map(i => i.id), ['item-4', 'item-5'])
  assert.equal(page1.hasMore, true)
  assert.ok(page1.historyBefore)
  assert.equal(page1.totalItems, 5)

  // Appending a new item at the tail does not shift the previous page boundary.
  const grown = [...items, { id: 'item-6', text: 'msg 6' }]
  const page2Req = parseThreadPageParams(new URLSearchParams({ before: page1.historyBefore!, limit: '2' }))
  const page2 = sliceThreadItemsPage(grown, page2Req!)
  assert.deepEqual(page2.items.map(i => i.id), ['item-2', 'item-3'])
  assert.equal(page2.hasMore, true)
  assert.ok(page2.historyBefore)

  // Final older page reaches index 0 and sets hasMore=false.
  const page3Req = parseThreadPageParams(new URLSearchParams({ before: page2.historyBefore!, limit: '2' }))
  const page3 = sliceThreadItemsPage(grown, page3Req!)
  assert.deepEqual(page3.items.map(i => i.id), ['item-1'])
  assert.equal(page3.hasMore, false)
  assert.equal(page3.historyBefore, null)

  // Invalid limit and cursor fail closed.
  assert.equal(parseThreadPageParams(new URLSearchParams({ limit: '0' })), null)
  assert.equal(parseThreadPageParams(new URLSearchParams({ limit: '101' })), null)
  assert.equal(parseThreadPageParams(new URLSearchParams({ before: 'not-valid!' })), null)
  const encoded = encodeThreadHistoryCursor({ id: 'item-4', index: 3 })
  assert.deepEqual(decodeThreadHistoryCursor(encoded), { v: 1, id: 'item-4', index: 3 })
})

test('Gap 5: profile name schema and bounded avatar payload reader enforce types and 200 KB cap', async () => {
  assert.deepEqual(mobileProfilePatchSchema.parse({ name: '  Alex Jiang  ' }), { name: 'Alex Jiang' })
  assert.equal(mobileProfilePatchSchema.safeParse({ name: '   ' }).success, false)
  assert.equal(mobileProfilePatchSchema.safeParse({ name: 'a'.repeat(81) }).success, false)
  assert.equal(mobileProfilePatchSchema.safeParse({ name: 'Alex', extra: true }).success, false)
  assert.equal(normalizeMediaType('image/png; charset=binary'), 'image/png')

  // Raw PNG body succeeds.
  const rawReq = new Request('https://mikka.test/api/mobile/profile/avatar', {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: PNG_BYTES,
  })
  const rawPayload = await readMobileAvatarPayload(rawReq)
  assert.equal(rawPayload.declaredType, 'image/png')
  assert.deepEqual(rawPayload.bytes, PNG_BYTES)

  // Multipart form upload succeeds.
  const form = new FormData()
  form.set('avatar', new Blob([PNG_BYTES], { type: 'image/png' }), 'avatar.png')
  const mpReq = new Request('https://mikka.test/api/mobile/profile/avatar', { method: 'POST', body: form })
  const mpPayload = await readMobileAvatarPayload(mpReq)
  assert.equal(mpPayload.declaredType, 'image/png')
  assert.deepEqual(mpPayload.bytes, PNG_BYTES)

  // Oversized streaming body is rejected with 413 avatarTooLarge.
  const oversized = new Uint8Array(AVATAR_MAX_BYTES + 1)
  oversized.set(PNG_BYTES)
  await assert.rejects(
    readMobileAvatarPayload(
      new Request('https://mikka.test/api/mobile/profile/avatar', {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: oversized,
      }),
    ),
    (err: unknown) => err instanceof MobileAvatarError && err.code === 'avatarTooLarge' && err.status === 413,
  )

  // Unsupported MIME type (e.g. SVG) is rejected with 400 avatarInvalidType.
  await assert.rejects(
    readMobileAvatarPayload(
      new Request('https://mikka.test/api/mobile/profile/avatar', {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg/>',
      }),
    ),
    (err: unknown) => err instanceof MobileAvatarError && err.code === 'avatarInvalidType' && err.status === 400,
  )
})

test('Gap 6: billing query and post body parsers validate scope pairing and action presence', () => {
  assert.deepEqual(parseMobileBillingGetQuery(new URLSearchParams()), {
    scope: null,
    budgetWorkspace: null,
    usageMember: null,
  })
  assert.deepEqual(
    parseMobileBillingGetQuery(
      new URLSearchParams({ scopeKind: 'workspace', scopeId: WS_1, budgetWorkspace: WS_2, usageMember: 'u-1' }),
    ),
    { scope: { kind: 'workspace', id: WS_1 }, budgetWorkspace: WS_2, usageMember: 'u-1' },
  )
  assert.equal(parseMobileBillingGetQuery(new URLSearchParams({ scopeKind: 'workspace' })), null)
  assert.equal(parseMobileBillingGetQuery(new URLSearchParams({ scopeId: WS_1 })), null)
  assert.equal(parseMobileBillingGetQuery(new URLSearchParams({ budgetWorkspace: 'bad' })), null)

  assert.deepEqual(
    parseMobileBillingPostBody({ scope: { kind: 'workspace', id: WS_1 }, action: 'portal', accountWorkspaceId: WS_1 }),
    { scope: { kind: 'workspace', id: WS_1 }, operation: { action: 'portal', accountWorkspaceId: WS_1 } },
  )
  assert.deepEqual(parseMobileBillingPostBody({ action: 'checkout', accountWorkspaceId: WS_1 }), {
    scope: null,
    operation: { action: 'checkout', accountWorkspaceId: WS_1 },
  })
  assert.equal(parseMobileBillingPostBody({ scope: { kind: 'workspace', id: 'bad' }, action: 'portal' }), null)
  assert.equal(parseMobileBillingPostBody({ accountWorkspaceId: WS_1 }), null)
  assert.equal(parseMobileBillingPostBody(null), null)
})
