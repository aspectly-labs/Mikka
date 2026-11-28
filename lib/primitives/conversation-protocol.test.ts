import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIKKA_CONVERSATION_KINDS,
  assertConversationId,
  assertConversationShellInvariants,
  assertHistoryPageInvariants,
  botConversationId,
  buildConversationShellCollection,
  computeDurationMs,
  filterShellsByKind,
  formatConversationId,
  fromLegacyAdapterThreadId,
  groupConversationId,
  groupItemsIntoTurns,
  isActiveConversationStatus,
  isConversationId,
  isConversationIdOfKind,
  isReadOnlyConversation,
  isSubagentShell,
  isTerminalConversationStatus,
  isWorkingConversationStatus,
  isoFromUnixSeconds,
  mergeHistoryPages,
  normalizeApprovalItem,
  normalizeBotHistoryPage,
  normalizeBotShell,
  normalizeConversationShell,
  normalizeConversationStatus,
  normalizeGroupHistoryPage,
  normalizeGroupShell,
  normalizeHistoryCursor,
  normalizeHistoryPage,
  normalizeIsoTimestamp,
  normalizeQuestionItem,
  normalizeSubagentHistoryPage,
  normalizeSubagentShell,
  normalizeSubagentSummaryItem,
  normalizeThreadHistoryPage,
  normalizeThreadShell,
  parseConversationId,
  subagentConversationId,
  threadConversationId,
  type MikkaBotConversationId,
  type MikkaConversationShell,
  type MikkaGroupConversationId,
  type MikkaSubagentConversationId,
  type MikkaSubagentConversationShell,
  type MikkaSubagentSummaryItem,
  type MikkaThreadConversationId,
} from './conversation-protocol'

const UUID_1 = '550e8400-e29b-41d4-a716-446655440001'
const UUID_2 = '550e8400-e29b-41d4-a716-446655440002'
const UUID_3 = '550e8400-e29b-41d4-a716-446655440003'
const UUID_4 = '550e8400-e29b-41d4-a716-446655440004'

// ── 1. Round-trip ID parsing & formatting ────────────────────────────────────────────────────

test('formats and round-trip parses canonical IDs for all 4 conversation kinds', () => {
  const cases: ReadonlyArray<{
    kind: (typeof MIKKA_CONVERSATION_KINDS)[number]
    rawId: string
    expected: string
  }> = [
    { kind: 'bot', rawId: UUID_1, expected: `bot:${UUID_1}` },
    { kind: 'bot', rawId: 'coordinator', expected: 'bot:coordinator' },
    { kind: 'group', rawId: UUID_2, expected: `group:${UUID_2}` },
    { kind: 'thread', rawId: UUID_3, expected: `thread:${UUID_3}` },
    { kind: 'subagent', rawId: UUID_4, expected: `subagent:${UUID_4}` },
  ]

  for (const { kind, rawId, expected } of cases) {
    const formatted = formatConversationId(kind, rawId)
    assert.equal(formatted, expected)
    assert.equal(isConversationId(formatted), true)
    assert.equal(isConversationIdOfKind(formatted, kind), true)

    const parsed = parseConversationId(formatted)
    assert.deepEqual(parsed, { kind, rawId, id: formatted })
    assert.deepEqual(assertConversationId(formatted), { kind, rawId, id: formatted })
    assert.equal(formatConversationId(parsed.kind, parsed.rawId), formatted)
    if (parsed.kind === 'subagent') {
      const narrowed: MikkaSubagentConversationId = parsed.id
      assert.equal(narrowed, expected)
    }
  }

  const botId: MikkaBotConversationId = botConversationId('bot_1')
  const groupId: MikkaGroupConversationId = groupConversationId('grp-2')
  const threadId: MikkaThreadConversationId = threadConversationId('run.3')
  const subagentId: MikkaSubagentConversationId = subagentConversationId('sub_4')

  assert.equal(botId, 'bot:bot_1')
  assert.equal(groupId, 'group:grp-2')
  assert.equal(threadId, 'thread:run.3')
  assert.equal(subagentId, 'subagent:sub_4')
  assert.equal(isConversationIdOfKind(botId, 'group'), false)
  assert.equal(isConversationIdOfKind(subagentId, 'thread'), false)
})

test('strict ID parser rejects legacy prefixes, whitespace, nested colons, and traversal segments', () => {
  const invalid: unknown[] = [
    '',
    'bot:',
    'group:',
    'thread:',
    'subagent:',
    `bot-chat:${UUID_1}`, // legacy iOS adapter prefix must not pass strict canonical parser
    `dm:${UUID_1}`,
    `run:${UUID_1}`,
    `conversation:${UUID_1}`,
    UUID_1,
    `BOT:${UUID_1}`,
    `Group:${UUID_2}`,
    `Thread:${UUID_3}`,
    `Subagent:${UUID_4}`,
    `bot: ${UUID_1}`,
    `bot:${UUID_1} `,
    'bot:has space',
    'bot:line\nbreak',
    `bot:group:${UUID_1}`,
    `thread:subagent:${UUID_4}`,
    'bot::double',
    'thread:.',
    'thread:..',
    'group:a/b',
    `bot:${'a'.repeat(129)}`,
    null,
    undefined,
    42,
    {},
  ]

  for (const candidate of invalid) {
    assert.equal(parseConversationId(candidate), null, `expected null for ${JSON.stringify(candidate)}`)
    assert.equal(isConversationId(candidate), false)
    assert.throws(() => assertConversationId(candidate), RangeError)
  }

  assert.throws(() => formatConversationId('bot', ''), RangeError)
  assert.throws(() => formatConversationId('bot', 'group:123'), RangeError)
  assert.throws(() => formatConversationId('bot', '..'), RangeError)
  assert.throws(() => formatConversationId('unknown' as 'bot', '123'), RangeError)
})

test('legacy iOS adapter bridge converts bot-chat:<id> to canonical bot:<id> while preserving canonical kinds', () => {
  assert.deepEqual(fromLegacyAdapterThreadId(`bot-chat:${UUID_1}`), {
    kind: 'bot',
    rawId: UUID_1,
    id: `bot:${UUID_1}`,
  })
  assert.deepEqual(fromLegacyAdapterThreadId(`group:${UUID_2}`), {
    kind: 'group',
    rawId: UUID_2,
    id: `group:${UUID_2}`,
  })
  assert.deepEqual(fromLegacyAdapterThreadId(`thread:${UUID_3}`), {
    kind: 'thread',
    rawId: UUID_3,
    id: `thread:${UUID_3}`,
  })
  assert.deepEqual(fromLegacyAdapterThreadId(`subagent:${UUID_4}`), {
    kind: 'subagent',
    rawId: UUID_4,
    id: `subagent:${UUID_4}`,
  })
  assert.equal(fromLegacyAdapterThreadId('bot-chat:'), null)
  assert.equal(fromLegacyAdapterThreadId('bot-chat:bad:id'), null)
  assert.equal(fromLegacyAdapterThreadId('dm:123'), null)
})

// ── 2. Strict Subagent Read-Only Invariant (Decision 1 / R-10) ───────────────────────────────

test('enforces subagent read-only invariant at compile time and runtime', () => {
  // Compile-time check verified by TypeScript (`tsrs --noEmit` in CI):
  // A subagent shell cannot be constructed with `readOnly: false` or `canReply: true`.
  const typeCheckSubagentReadOnly = () => {
    const invalidShell: MikkaSubagentConversationShell = {
      kind: 'subagent',
      id: subagentConversationId(UUID_4),
      rawId: UUID_4,
      latestRunId: UUID_4,
      title: 'Reviewer',
      status: 'running',
      // @ts-expect-error Decision 1 / R-10: subagent shells MUST have readOnly: true
      readOnly: false,
      // @ts-expect-error Decision 1 / R-10: subagent shells MUST have canReply: false
      canReply: true,
      // @ts-expect-error Decision 1 / R-10: subagent shells MUST have canRetry: false
      canRetry: true,
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:00:00.000Z',
      finishedAt: null,
      parentThreadId: threadConversationId(UUID_3),
    }
    const invalidSummary: MikkaSubagentSummaryItem = {
      type: 'subagent_summary',
      id: `subagent:${UUID_4}`,
      subagentId: subagentConversationId(UUID_4),
      rawRunId: UUID_4,
      latestRunId: UUID_4,
      parentThreadId: threadConversationId(UUID_3),
      name: 'Reviewer',
      status: 'running',
      // @ts-expect-error Decision 1 / R-10: subagent summary MUST have readOnly: true
      readOnly: false,
      // @ts-expect-error Decision 1 / R-10: subagent summary MUST have canReply: false
      canReply: true,
      createdAt: '2026-11-24T10:00:00.000Z',
      startedAt: '2026-11-24T10:00:00.000Z',
      finishedAt: null,
      durationMs: null,
    }
    return { invalidShell, invalidSummary }
  }
  assert.equal(typeof typeCheckSubagentReadOnly, 'function')

  // Runtime check: even if untrusted fields attempt to force mutability, normalizer locks read-only.
  const hostileInput = {
    id: UUID_4,
    parentRunId: UUID_3,
    status: 'running',
    createdAt: '2026-11-24T10:00:00.000Z',
    readOnly: false,
    canReply: true,
    canRetry: true,
  } as Parameters<typeof normalizeSubagentShell>[0]

  const shell = normalizeSubagentShell(hostileInput)
  assert.equal(shell.kind, 'subagent')
  assert.equal(shell.id, `subagent:${UUID_4}`)
  assert.equal(shell.readOnly, true)
  assert.equal(shell.canReply, false)
  assert.equal(shell.canRetry, false)
  assert.equal(shell.parentThreadId, `thread:${UUID_3}`)
  assert.equal(isSubagentShell(shell), true)
  assert.equal(isReadOnlyConversation(shell), true)
  assert.doesNotThrow(() => assertConversationShellInvariants(shell))

  // Runtime assertion catches tampered shells directly.
  const tamperedSubagent = { ...shell, readOnly: false, canReply: true } as unknown as MikkaConversationShell
  assert.throws(() => assertConversationShellInvariants(tamperedSubagent), /Decision 1 \/ R-10/)

  const tamperedThread = {
    ...normalizeThreadShell({ id: UUID_3, status: 'running', createdAt: '2026-11-24T10:00:00.000Z' }),
    readOnly: true,
    canReply: true,
  } as unknown as MikkaConversationShell
  assert.throws(() => assertConversationShellInvariants(tamperedThread), /both readOnly=true and canReply=true/)

  const mismatchedId = {
    ...shell,
    id: threadConversationId(UUID_4),
  } as unknown as MikkaConversationShell
  assert.throws(() => assertConversationShellInvariants(mismatchedId), /disagrees with kind/)
})

// ── 3. finishedAt & durationMs preservation (Evidence A) ─────────────────────────────────────

test('preserves finishedAt and computes frozen durationMs on settled subagents and threads', () => {
  const settled = normalizeSubagentShell({
    id: UUID_4,
    latestRunId: 'run-child-2',
    issueId: 'issue-99',
    parentRunId: UUID_3,
    title: 'Audit auth boundaries',
    harness: 'codex',
    status: 'succeeded',
    outcome: 'done',
    createdAt: '2026-11-24T10:00:00.000Z',
    finishedAt: '2026-11-24T10:02:15.500Z',
    subagent: {
      profile: { name: 'Security Auditor', icon: 'diamond', color: 'violet' },
      model: 'openai/gpt-6-luna',
      brief: 'Verify PAT workspace isolation',
    },
  })

  assert.equal(settled.status, 'completed')
  assert.equal(settled.finishedAt, '2026-11-24T10:02:15.500Z')
  assert.equal(settled.updatedAt, '2026-11-24T10:02:15.500Z')
  assert.equal(settled.issueId, 'issue-99')
  assert.equal(settled.latestRunId, 'run-child-2')
  assert.equal(settled.model, 'openai/gpt-6-luna')
  assert.equal(settled.brief, 'Verify PAT workspace isolation')
  assert.deepEqual(settled.profile, { name: 'Security Auditor', icon: 'diamond', color: 'violet' })

  const settledItem = normalizeSubagentSummaryItem({
    id: UUID_4,
    parentRunId: UUID_3,
    harness: 'codex',
    status: 'succeeded',
    createdAt: '2026-11-24T10:00:00.000Z',
    finishedAt: '2026-11-24T10:02:15.500Z',
    lastReply: 'All 4 routes enforce workspace fencing.',
  })
  assert.equal(settledItem.finishedAt, '2026-11-24T10:02:15.500Z')
  assert.equal(settledItem.durationMs, 135_500)
  assert.equal(settledItem.completedAtMs, Date.parse('2026-11-24T10:02:15.500Z'))
  assert.equal(settledItem.readOnly, true)
  assert.equal(settledItem.canReply, false)
  assert.equal(settledItem.summary, 'All 4 routes enforce workspace fencing.')

  // Running subagent keeps finishedAt=null and durationMs=null (no fake 0ms).
  const activeItem = normalizeSubagentSummaryItem({
    id: UUID_4,
    parentRunId: UUID_3,
    status: 'running',
    createdAt: '2026-11-24T10:00:00.000Z',
    finishedAt: null,
  })
  assert.equal(activeItem.status, 'running')
  assert.equal(activeItem.finishedAt, null)
  assert.equal(activeItem.completedAtMs, null)
  assert.equal(activeItem.durationMs, null)

  // Reversed timestamps never produce negative duration.
  assert.equal(computeDurationMs('2026-11-24T10:05:00.000Z', '2026-11-24T10:00:00.000Z'), null)
  assert.equal(isoFromUnixSeconds(1732442400), '2024-11-24T10:00:00.000Z')
  assert.equal(normalizeIsoTimestamp('not-a-date'), null)
  assert.equal(normalizeIsoTimestamp(Number.NaN), null)
})

// ── 4. Pagination Cursor Invariants ──────────────────────────────────────────────────────────

test('enforces MikkaHistoryPage cursor invariants and lossless bigint cursors', () => {
  assert.equal(normalizeHistoryCursor(' 9007199254740993 '), '9007199254740993')
  assert.equal(normalizeHistoryCursor(9007199254740993n), '9007199254740993')
  assert.equal(normalizeHistoryCursor(42), '42')
  assert.equal(normalizeHistoryCursor(0), null)
  assert.equal(normalizeHistoryCursor(-10), null)
  assert.equal(normalizeHistoryCursor('0'), null)
  assert.equal(normalizeHistoryCursor('-42'), null)
  assert.equal(normalizeHistoryCursor('   '), null)
  assert.equal(normalizeHistoryCursor(Number.NaN), null)
  assert.equal(normalizeHistoryCursor(Number.MAX_SAFE_INTEGER + 1), null)

  const pageWithMore = normalizeHistoryPage({
    items: [{ id: 'm2' }, { id: 'm3' }],
    nextBefore: '9007199254740993',
    totalItems: 10,
  })
  assert.equal(pageWithMore.hasMore, true)
  assert.equal(pageWithMore.nextBefore, '9007199254740993')
  assert.equal(pageWithMore.totalItems, 10)
  assert.doesNotThrow(() => assertHistoryPageInvariants(pageWithMore))

  // hasMore=true without valid cursor must normalize to hasMore=false, nextBefore=null.
  const noCursor = normalizeHistoryPage({ items: [{ id: 'm1' }], hasMore: true, nextBefore: null })
  assert.equal(noCursor.hasMore, false)
  assert.equal(noCursor.nextBefore, null)

  // hasMore=false clears stale cursor so hasMore === (nextBefore !== null) always holds.
  const staleCursor = normalizeHistoryPage({ items: [{ id: 'm1' }], hasMore: false, nextBefore: '50' })
  assert.equal(staleCursor.hasMore, false)
  assert.equal(staleCursor.nextBefore, null)

  // totalItems smaller than items.length clamps cleanly to items.length.
  const clampedTotal = normalizeHistoryPage({ items: [{ id: 'a' }, { id: 'b' }], totalItems: 1 })
  assert.equal(clampedTotal.totalItems, 2)

  // Runtime validator rejects violated pages.
  assert.throws(
    () => assertHistoryPageInvariants({ items: [], hasMore: true, nextBefore: null }),
    /Pagination invariant violated/,
  )
  assert.throws(
    () => assertHistoryPageInvariants({ items: [], hasMore: false, nextBefore: '10' }),
    /Pagination invariant violated/,
  )
  assert.throws(
    () => assertHistoryPageInvariants({ items: [{ id: '1' }, { id: '2' }], hasMore: false, nextBefore: null, totalItems: 1 }),
    /totalItems/,
  )

  // Merging older page before newer page deduplicates overlap and preserves oldest boundary.
  const older = normalizeHistoryPage({
    items: [{ id: 'm1', v: 'old' }, { id: 'm2', v: 'old' }],
    nextBefore: '100',
    totalItems: 5,
  })
  const newer = normalizeHistoryPage({
    items: [{ id: 'm2', v: 'fresh' }, { id: 'm3', v: 'fresh' }],
    nextBefore: '200',
    totalItems: 5,
  })
  const merged = mergeHistoryPages(older, newer)
  assert.deepEqual(merged.items, [
    { id: 'm1', v: 'old' },
    { id: 'm2', v: 'fresh' },
    { id: 'm3', v: 'fresh' },
  ])
  assert.equal(merged.hasMore, true)
  assert.equal(merged.nextBefore, '100')
  assert.equal(merged.totalItems, 5)
})

// ── 5. Normalization across all 4 conversation kinds ─────────────────────────────────────────

test('normalizes Bot DM shell and history page with tools, dispatched threads, notices, approvals, and questions', () => {
  const botShell = normalizeBotShell({
    id: UUID_1,
    name: 'Mikka Coordinator',
    coordinator: true,
    working: true,
    line: 'Dispatched coding thread',
    at: '2026-11-24T12:00:00.000Z',
    unreadCount: 2,
    pinned: true,
    color: 'blue',
    shape: 'circle',
  })

  assert.equal(botShell.kind, 'bot')
  assert.equal(botShell.id, `bot:${UUID_1}`)
  assert.equal(botShell.status, 'running')
  assert.equal(botShell.readOnly, false)
  assert.equal(botShell.canReply, true)
  assert.equal(botShell.canRetry, true)
  assert.equal(botShell.finishedAt, null)
  assert.equal(botShell.unreadCount, 2)
  assert.doesNotThrow(() => assertConversationShellInvariants(botShell))

  const page = normalizeBotHistoryPage(UUID_1, {
    historyBefore: 12,
    totalItems: 30,
    botSpeaker: { id: UUID_1, name: 'Mikka Coordinator', color: 'blue', shape: 'circle' },
    items: [
      {
        id: 'welcome-empty',
        position: 1,
        from: 'coordinator',
        text: '',
        welcome: true,
        createdAt: '2026-11-24T11:50:00.000Z',
      },
      {
        id: 'msg-1',
        submissionId: 'sub-1',
        position: 13,
        from: 'person',
        text: 'Ship the protocol primitive',
        images: 1,
        createdAt: '2026-11-24T11:55:00.000Z',
      },
      {
        id: 'msg-2',
        position: 14,
        from: 'coordinator',
        text: 'Started the thread.',
        createdAt: '2026-11-24T11:56:00.000Z',
        streamId: 'eve:s1:t1',
        threads: [UUID_3],
        artifacts: ['art-1'],
        activity: {
          tools: [
            { call: 'call-1', name: 'dispatch_run', state: 'done', displayName: 'Dispatch Thread', target: 'Mikka' },
          ],
        },
      },
      {
        id: 'evt-1',
        position: 15,
        from: 'event',
        text: 'Switched to fallback model',
        notice: { kind: 'model_switch' },
        createdAt: '2026-11-24T11:57:00.000Z',
      },
    ],
    approvals: [
      {
        id: 'pa-1',
        action: 'calendar.update',
        title: 'Update standup',
        status: 'pending',
        context: { summary: 'Move to 10:00' },
        createdAt: '2026-11-24T11:58:00.000Z',
      },
    ],
    questions: [
      {
        id: 'q-1',
        prompts: [
          {
            id: 'step-1',
            question: 'Deploy to staging?',
            options: [
              { id: 'yes', title: 'Yes', recommended: true },
              { id: 'no', title: 'Wait' },
            ],
          },
        ],
        createdAt: '2026-11-24T11:59:00.000Z',
      },
    ],
  })

  assert.equal(page.hasMore, true)
  assert.equal(page.nextBefore, '12')
  assert.equal(page.totalItems, 30)
  assert.deepEqual(
    page.items.map((item) => item.type),
    ['message', 'tool', 'message', 'status_notice', 'approval', 'question'],
  )

  const reply = page.items[2]
  assert.equal(reply?.type, 'message')
  if (reply?.type === 'message') {
    assert.deepEqual(reply.dispatchedThreads, [`thread:${UUID_3}`])
    assert.deepEqual(reply.artifactIds, ['art-1'])
    assert.equal(reply.speaker?.kind, 'bot')
    assert.equal(reply.streamId, 'eve:s1:t1')
  }
  const approval = page.items[4]
  assert.equal(approval?.type, 'approval')
  if (approval?.type === 'approval') {
    assert.equal(approval.summary, 'Move to 10:00')
  }
})

test('normalizes Group Chat shell and history page with lossless BigInt ordering and speaker attribution', () => {
  const groupShell = normalizeGroupShell({
    id: UUID_2,
    title: 'Design System Crew',
    workspaceId: 'ws-1',
    createdAt: '2026-11-24T09:00:00.000Z',
    lastMessage: { body: 'Ready to ship', createdAt: '2026-11-24T12:10:00.000Z' },
    unreadCount: '4',
    answering: [{ memberType: 'bot', id: UUID_1 }],
    memberCount: 3,
  })

  assert.equal(groupShell.kind, 'group')
  assert.equal(groupShell.id, `group:${UUID_2}`)
  assert.equal(groupShell.status, 'running')
  assert.equal(groupShell.canReply, true)
  assert.equal(groupShell.canRetry, false)
  assert.equal(groupShell.unreadCount, 4)
  assert.equal(groupShell.updatedAt, '2026-11-24T12:10:00.000Z')
  assert.doesNotThrow(() => assertConversationShellInvariants(groupShell))

  // SQL returns messages newest-first with > 2^53 bigint positions.
  const page = normalizeGroupHistoryPage(UUID_2, {
    viewerId: 'user-alex',
    nextBefore: '9007199254740993',
    members: [
      { id: 'user-alex', name: 'Alex', memberType: 'user', avatarUrl: 'https://example.com/a.png' },
      { id: UUID_1, name: 'Architect Bot', memberType: 'bot', color: 'teal', shape: 'diamond' },
    ],
    messages: [
      {
        id: 'gm-3',
        position: '9007199254740995',
        authorType: 'agent',
        authorId: 'agent-unknown',
        body: 'Review complete.',
        createdAt: '2026-11-24T12:03:00.000Z',
      },
      {
        id: 'gm-2',
        position: '9007199254740994',
        authorType: 'bot',
        authorId: UUID_1,
        body: 'Checking contracts now.',
        createdAt: '2026-11-24T12:02:00.000Z',
      },
      {
        id: 'gm-1',
        position: '9007199254740993',
        authorType: 'user',
        authorId: 'user-alex',
        body: 'Align all 4 chat protocols.',
        createdAt: '2026-11-24T12:01:00.000Z',
      },
    ],
    exchanges: [
      {
        type: 'agent_exchange',
        linkId: 'link-1',
        anchorPosition: '9007199254740994',
        count: '2',
        participants: [
          { id: UUID_1, name: 'Architect Bot', memberType: 'bot' },
          { id: 'agent-unknown', name: 'Verifier', memberType: 'agent' },
        ],
      },
    ],
  })

  assert.equal(page.hasMore, true)
  assert.equal(page.nextBefore, '9007199254740993')
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['gm-1', 'gm-2', 'exchange:link-1', 'gm-3'],
  )

  const first = page.items[0]
  assert.equal(first?.type, 'message')
  if (first?.type === 'message') {
    assert.equal(first.mine, true)
    assert.equal(first.role, 'user')
    assert.equal(first.speaker?.name, 'Alex')
    assert.equal(first.position, '9007199254740993')
  }

  const last = page.items[3]
  assert.equal(last?.type, 'message')
  if (last?.type === 'message') {
    assert.equal(last.mine, false)
    assert.equal(last.role, 'assistant')
    assert.equal(last.speaker?.kind, 'agent')
    assert.equal(last.speaker?.name, 'Agent')
  }
})

test('normalizes Task Thread shell & history (cancelling orphaned running steps and embedding subagent summaries)', () => {
  const threadShell = normalizeThreadShell({
    id: UUID_3,
    liveRunId: 'run-attempt-2',
    title: 'MIK-42 Unify conversation protocol',
    status: 'succeeded',
    outcome: 'done',
    issueId: 'issue-42',
    by: 'Mikka Coordinator',
    harness: 'claude_code',
    createdAt: '2026-11-24T11:00:00.000Z',
    finishedAt: '2026-11-24T11:15:00.000Z',
    canReply: true,
    unread: false,
  })

  assert.equal(threadShell.kind, 'thread')
  assert.equal(threadShell.id, `thread:${UUID_3}`)
  assert.equal(threadShell.liveRunId, 'run-attempt-2')
  assert.equal(threadShell.status, 'completed')
  assert.equal(threadShell.finishedAt, '2026-11-24T11:15:00.000Z')
  assert.equal(threadShell.updatedAt, '2026-11-24T11:15:00.000Z')
  assert.equal(threadShell.issueId, 'issue-42')
  assert.equal(threadShell.readOnly, false)
  assert.equal(threadShell.canReply, true)
  assert.doesNotThrow(() => assertConversationShellInvariants(threadShell))

  // A thread with canReply: false becomes readOnly: true consistently.
  const noAgentThread = normalizeThreadShell({
    id: UUID_3,
    status: 'stopped',
    canReply: false,
    createdAt: '2026-11-24T11:00:00.000Z',
  })
  assert.equal(noAgentThread.readOnly, true)
  assert.equal(noAgentThread.canReply, false)
  assert.doesNotThrow(() => assertConversationShellInvariants(noAgentThread))

  const page = normalizeThreadHistoryPage(UUID_3, {
    active: false,
    working: false,
    items: [
      { kind: 'person', id: 'p-1', text: 'Implement track 3', author: 'Alex', mine: true, at: 1732446000000 },
      {
        kind: 'steps',
        id: 'steps-1',
        at: 1732446005000,
        steps: [
          { id: 't-1', name: 'Read', kind: 'read', status: 'ok', target: 'lib/mobile-threads.ts', ms: 40 },
          { id: 't-2', name: 'Bash', kind: 'shell', status: 'running', command: 'pnpm test' },
        ],
      },
      { kind: 'agent', id: 'a-1', text: 'Done.', at: 1732446020000 },
      { kind: 'error', id: 'e-1', text: 'Transient timeout', at: 1732446025000 },
    ],
    subagents: [
      {
        id: UUID_4,
        harness: 'codex',
        status: 'succeeded',
        createdAt: '2026-11-24T11:01:00.000Z',
        finishedAt: '2026-11-24T11:03:00.000Z',
        brief: 'Verify edge cases',
      },
    ],
  })

  assert.equal(page.hasMore, false)
  assert.equal(page.nextBefore, null)
  assert.deepEqual(
    page.items.map((item) => item.type),
    ['message', 'tool', 'tool', 'message', 'status_notice', 'subagent_summary'],
  )

  const orphanedTool = page.items[2]
  assert.equal(orphanedTool?.type, 'tool')
  if (orphanedTool?.type === 'tool') {
    assert.equal(orphanedTool.status, 'cancelled')
  }

  const subagentItem = page.items[5]
  assert.equal(subagentItem?.type, 'subagent_summary')
  if (subagentItem?.type === 'subagent_summary') {
    assert.equal(subagentItem.conversationId, `thread:${UUID_3}`)
    assert.equal(subagentItem.subagentId, `subagent:${UUID_4}`)
    assert.equal(subagentItem.parentThreadId, `thread:${UUID_3}`)
    assert.equal(subagentItem.readOnly, true)
    assert.equal(subagentItem.canReply, false)
    assert.equal(subagentItem.durationMs, 120_000)
  }

  // Subagent's own read-only history page uses canonical `subagent:<id>` conversationId.
  const subagentHistory = normalizeSubagentHistoryPage(UUID_4, {
    active: false,
    items: [{ kind: 'agent', id: 'sa-1', text: 'Verified.', at: '2026-11-24T11:02:30.000Z' }],
  })
  assert.equal(subagentHistory.items[0]?.conversationId, `subagent:${UUID_4}`)
})

// ── 6. Unified Shell Collection (prevents hostShell omission) & Turn Grouping ────────────────

test('buildConversationShellCollection retains all 4 kinds, deduplicates, and sorts pinned then recency', () => {
  const bot = normalizeConversationShell({
    kind: 'bot',
    id: UUID_1,
    name: 'Coordinator',
    updatedAt: '2026-11-24T10:00:00.000Z',
    pinned: true,
  })
  const group = normalizeConversationShell({
    kind: 'group',
    id: UUID_2,
    title: 'Core Eng',
    updatedAt: '2026-11-24T12:00:00.000Z',
  })
  const thread = normalizeConversationShell({
    kind: 'thread',
    id: UUID_3,
    title: 'Fix P0 shell',
    status: 'running',
    updatedAt: '2026-11-24T12:05:00.000Z',
  })
  const subagent = normalizeConversationShell({
    kind: 'subagent',
    id: UUID_4,
    parentRunId: UUID_3,
    title: 'Code reviewer',
    status: 'succeeded',
    createdAt: '2026-11-24T12:01:00.000Z',
    finishedAt: '2026-11-24T12:04:00.000Z',
  })

  const collection = buildConversationShellCollection([group, subagent, thread, bot, group])
  assert.deepEqual(collection.counts, { bot: 1, group: 1, thread: 1, subagent: 1 })
  assert.deepEqual(
    collection.items.map((shell) => shell.id),
    [`bot:${UUID_1}`, `thread:${UUID_3}`, `subagent:${UUID_4}`, `group:${UUID_2}`],
  )
  assert.equal(collection.byId[`group:${UUID_2}`]?.kind, 'group')
  assert.equal(collection.byId[`thread:${UUID_3}`]?.kind, 'thread')
  assert.equal(filterShellsByKind(collection.items, 'subagent')[0]?.readOnly, true)
})

test('groupItemsIntoTurns folds flat protocol items into Codex-style turns with lifecycle statuses', () => {
  const convId = threadConversationId(UUID_3)
  const items = normalizeThreadHistoryPage(UUID_3, {
    active: false,
    items: [
      { kind: 'person', id: 'u1', text: 'First ask', mine: true, at: '2026-11-24T10:00:00.000Z' },
      { kind: 'agent', id: 'a1', text: 'First answer', at: '2026-11-24T10:00:10.000Z' },
      { kind: 'person', id: 'u2', text: 'Second ask', mine: true, at: '2026-11-24T10:01:00.000Z' },
      { kind: 'error', id: 'e2', text: 'Rate limit exceeded', at: '2026-11-24T10:01:05.000Z' },
    ],
  }).items

  const turns = groupItemsIntoTurns(convId, items, { rootTurnId: UUID_3 })
  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.status, 'completed')
  assert.equal(turns[0]?.durationMs, 10_000)
  assert.equal(turns[0]?.rootTurnId, UUID_3)
  assert.equal(turns[1]?.status, 'failed')
  assert.deepEqual(turns[1]?.error, { message: 'Rate limit exceeded', code: null })
  assert.equal(turns[1]?.durationMs, 5_000)

  const liveTurns = groupItemsIntoTurns(convId, items.slice(0, 1), { working: true })
  assert.equal(liveTurns[0]?.status, 'in_progress')
  assert.equal(liveTurns[0]?.completedAt, null)
  assert.equal(liveTurns[0]?.durationMs, null)
})

test('normalizes status helpers and standalone approval/question items consistently', () => {
  assert.equal(normalizeConversationStatus({ status: 'succeeded', outcome: 'blocked' }), 'failed')
  assert.equal(normalizeConversationStatus({ status: 'succeeded', outcome: 'needs_input' }), 'waiting_input')
  assert.equal(normalizeConversationStatus({ status: 'stopped', stopReason: 'asked_human' }), 'waiting_input')
  assert.equal(normalizeConversationStatus('pendingInit'), 'queued')
  assert.equal(normalizeConversationStatus('inProgress'), 'running')
  assert.equal(normalizeConversationStatus('shutdown'), 'stopped')

  assert.equal(isActiveConversationStatus('waiting_input'), true)
  assert.equal(isWorkingConversationStatus('waiting_input'), false)
  assert.equal(isWorkingConversationStatus('running'), true)
  assert.equal(isTerminalConversationStatus('completed'), true)
  assert.equal(isTerminalConversationStatus('paused'), false)

  const approval = normalizeApprovalItem({ id: 'a1', action: 'git.push', status: 'denied' })
  assert.equal(approval.status, 'declined')
  assert.equal(approval.title, 'git.push')

  const question = normalizeQuestionItem({
    id: 'q1',
    prompts: [{ id: 'p1', question: 'Pick env', options: [{ id: 'stage', title: 'Staging' }] }],
  })
  assert.equal(question.questionGroupId, 'q1')
  assert.equal(question.status, 'pending')

  // Raw group `timeline` extracts `agent_exchange` entries automatically without separate `exchanges`.
  const groupFromTimeline = normalizeGroupHistoryPage(UUID_2, {
    messages: [
      {
        id: 'm-1',
        position: '500',
        authorType: 'user',
        authorId: 'u-1',
        body: 'Check this',
        createdAt: '2026-11-24T12:00:00.000Z',
      },
    ],
    timeline: [
      { type: 'message', id: 'm-1', position: '500' },
      { type: 'agent_exchange', linkId: 'ex-9', anchorPosition: '500', count: 3 },
    ],
  })
  assert.deepEqual(
    groupFromTimeline.items.map((item) => item.id),
    ['m-1', 'exchange:ex-9'],
  )

  // Legacy Bot DM items without `activity.tools` fall back to `tools[]`.
  const legacyBotPage = normalizeBotHistoryPage(UUID_1, {
    items: [
      {
        id: 'legacy-reply',
        position: 5,
        from: 'coordinator',
        text: 'Checked.',
        tools: ['read_file'],
        createdAt: '2026-11-24T12:00:00.000Z',
      },
    ],
  })
  assert.deepEqual(
    legacyBotPage.items.map((item) => item.type),
    ['tool', 'message'],
  )

  // Flat `SubagentRunCard` shape (from lib/subagent-runs.ts) normalizes cleanly.
  const flatCardShell = normalizeSubagentShell({
    id: UUID_4,
    name: 'Browser Worker',
    profile: { icon: 'lens', color: 'teal' },
    brief: 'Collect pricing table',
    status: 'failed',
    model: 'anthropic/claude-haiku-5-5',
    botId: UUID_1,
    lastReply: 'Site timed out',
    createdAt: '2026-11-24T12:00:00.000Z',
    finishedAt: '2026-11-24T12:01:00.000Z',
  })
  assert.equal(flatCardShell.readOnly, true)
  assert.equal(flatCardShell.canReply, false)
  assert.equal(flatCardShell.parentThreadId, `bot:${UUID_1}`)
  assert.equal(flatCardShell.status, 'failed')
  assert.equal(flatCardShell.finishedAt, '2026-11-24T12:01:00.000Z')
  assert.equal(flatCardShell.preview, 'Site timed out')
  assert.doesNotThrow(() => assertConversationShellInvariants(flatCardShell))
})

test('interleaves subagent summaries chronologically and keeps parent max turn completion timestamp', () => {
  const convId = threadConversationId(UUID_3)
  const page = normalizeThreadHistoryPage(UUID_3, {
    active: false,
    items: [
      { kind: 'person', id: 'u1', text: 'Audit and fix', mine: true, at: '2026-11-24T10:00:00.000Z' },
      { kind: 'agent', id: 'a1', text: 'Final synthesis', at: '2026-11-24T10:02:00.000Z' },
    ],
    subagents: [
      {
        id: UUID_4,
        harness: 'codex',
        status: 'succeeded',
        createdAt: '2026-11-24T10:00:10.000Z',
        finishedAt: '2026-11-24T10:01:00.000Z',
        brief: 'Inspect edge cases',
      },
    ],
  })

  // Subagent started at 10:00:10 is interleaved before the 10:02:00 final reply.
  assert.deepEqual(
    page.items.map((item) => item.type),
    ['message', 'subagent_summary', 'message'],
  )

  const turns = groupItemsIntoTurns(convId, page.items, { rootTurnId: UUID_3 })
  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.startedAt, '2026-11-24T10:00:00.000Z')
  assert.equal(turns[0]?.completedAt, '2026-11-24T10:02:00.000Z')
  assert.equal(turns[0]?.durationMs, 120_000)

  // Even when a child item sits last in a turn with an earlier completedAt, turn uses max timestamp.
  const reorderedTurns = groupItemsIntoTurns(
    convId,
    [page.items[0]!, page.items[2]!, page.items[1]!],
    { rootTurnId: UUID_3 },
  )
  assert.equal(reorderedTurns[0]?.completedAt, '2026-11-24T10:02:00.000Z')
  assert.equal(reorderedTurns[0]?.durationMs, 120_000)
})

test('mergeHistoryPages preserves anchored placement for updated group exchange markers on delta reads', () => {
  const older = normalizeGroupHistoryPage(UUID_2, {
    nextBefore: '10',
    messages: [
      {
        id: 'gm-2',
        position: '12',
        authorType: 'bot',
        authorId: UUID_1,
        body: 'Working on it',
        createdAt: '2026-11-24T12:02:00.000Z',
      },
      {
        id: 'gm-1',
        position: '11',
        authorType: 'user',
        authorId: 'u-1',
        body: 'Start',
        createdAt: '2026-11-24T12:01:00.000Z',
      },
    ],
    exchanges: [{ type: 'agent_exchange', linkId: 'link-1', anchorPosition: '11', count: '2' }],
  })

  // Delta read appends gm-3 and resends updated link-1 (now count=5) anchored to gm-1.
  const delta = normalizeGroupHistoryPage(UUID_2, {
    messages: [
      {
        id: 'gm-3',
        position: '13',
        authorType: 'bot',
        authorId: UUID_1,
        body: 'Finished',
        createdAt: '2026-11-24T12:05:00.000Z',
      },
    ],
    exchanges: [{ type: 'agent_exchange', linkId: 'link-1', anchorPosition: '11', count: '5' }],
  })

  const merged = mergeHistoryPages(older, delta)
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ['gm-1', 'exchange:link-1', 'gm-2', 'gm-3'],
  )
  const updatedExchange = merged.items[1]
  assert.equal(updatedExchange?.type, 'status_notice')
  if (updatedExchange?.type === 'status_notice') {
    assert.equal(updatedExchange.meta?.count, '5')
  }
})
