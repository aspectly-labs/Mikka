import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

test('desktop decisions read completion preferences only for a currently owned completion', async t => {
  const userId = 'notification-owner', workspaceId = '10000000-0000-4000-8000-000000000001'
  const requestHeaders = new Headers({ 'x-fixture': 'desktop-notification' })
  let session: { user: { id: string } } | null = { user: { id: userId } }
  let runs: { issueId: string; status: string; issueTitle: string; agentName: string }[] = []
  let preferences = { proactive: true, pushFinished: true }
  let preferenceFailure: Error | null = null
  let runtime = {
    dnd: { enabled: false, start: '22:00', end: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const },
    timeZone: null as string | null,
    mobile: { decide: null, review: null, finished: null, briefing: null },
    desktop: { decide: null as boolean | null, review: null, finished: null as boolean | null, briefing: null },
    emailInvitations: null,
    sound: 'default' as const,
    legacyPushDecide: null as boolean | null,
  }
  let runReads = 0, preferenceReads = 0, runtimeReads = 0, decisions = 0
  const judged: string[][] = []
  const mocks = [
    mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => requestHeaders } }),
    mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
      getSession: async (input: { headers: Headers }) => { assert.equal(input.headers, requestHeaders); return session },
    } } } }),
    mock.module(new URL('../app/actions/task-runs.ts', import.meta.url).href, { namedExports: {
      listTaskRuns: async () => { runReads++; return runs },
    } }),
    mock.module(new URL('../lib/preferences.ts', import.meta.url).href, { namedExports: {
      readPreferences: async (owner: string) => {
        assert.equal(owner, userId, 'preferences always belong to the authenticated person')
        preferenceReads++
        if (preferenceFailure) throw preferenceFailure
        return preferences
      },
    } }),
    mock.module(new URL('../lib/settings/notification-preferences.ts', import.meta.url).href, { namedExports: {
      readDesktopNotificationRuntime: async (owner: string) => {
        assert.equal(owner, userId, 'desktop notification runtime always belongs to the authenticated person')
        runtimeReads++
        return runtime
      },
    } }),
    mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: {
      decide: async (kind: string, source: string, questions: { name: string }[]) => {
        assert.equal(kind, 'desktop-notify')
        decisions++; judged.push(source.split('\n').map(line => line.split(': ')[0]))
        return new Map(questions.map(question => [question.name, { type: 'predicate', name: question.name, probability: 1 }]))
      },
    } }),
    mock.module(new URL('../lib/abuse/context.ts', import.meta.url).href, { namedExports: {
      hostedBillingScope: { run: async (scope: { workspaceId: string; ownerId: string }, work: () => unknown) => {
        assert.deepEqual(scope, { workspaceId, ownerId: userId }); return work()
      } },
    } }),
    mock.module(new URL('../lib/execution-settings.ts', import.meta.url).href, { namedExports: {
      executionWorkspace: async (owner: string, bot: null) => { assert.equal(owner, userId); assert.equal(bot, null); return workspaceId },
    } }),
  ]
  const candidate = (kind: 'awaiting' | 'failed' | 'finished', issueId: string = kind) => ({ id: `run:${issueId}:${kind}:1`, issueId, kind })
  const owned = (issueId: string, status: string) => ({ issueId, status, issueTitle: 'Fixture task', agentName: 'Fixture agent' })
  try {
    const { chooseDesktopNotifications } = await import('../app/actions/desktop-notifications')
    await t.test('unauthenticated, empty, malformed, foreign and stale-state candidates never read preferences or ask the model', async () => {
      session = null
      assert.deepEqual(await chooseDesktopNotifications([candidate('finished')]), { error: 'authRequired', params: undefined })
      assert.equal(runReads, 0)
      session = { user: { id: userId } }
      assert.deepEqual(await chooseDesktopNotifications([]), { show: [] })
      assert.deepEqual(await chooseDesktopNotifications([{ ...candidate('finished'), kind: 'unknown' }]), { show: [] })
      assert.equal(runReads, 0)
      assert.deepEqual(await chooseDesktopNotifications([candidate('finished', 'foreign')]), { show: [] })
      runs = [owned('finished', 'running')]
      assert.deepEqual(await chooseDesktopNotifications([candidate('finished')]), { show: [] })
      assert.equal(preferenceReads, 0); assert.equal(decisions, 0)
    })
    await t.test('awaiting and failed decisions keep their existing path without reading completion settings', async () => {
      runs = [owned('awaiting', 'waiting_input'), owned('failed', 'failed')]
      const candidates = [candidate('awaiting'), candidate('failed')]
      assert.deepEqual(await chooseDesktopNotifications(candidates), { show: candidates.map(item => item.id) })
      assert.equal(preferenceReads, 0); assert.equal(decisions, 1)
    })
    await t.test('a finished event with either switch off is rejected before a model decision', async () => {
      runs = [owned('finished', 'succeeded')]
      for (const setting of [{ proactive: true, pushFinished: false }, { proactive: false, pushFinished: true }]) {
        preferences = setting
        assert.deepEqual(await chooseDesktopNotifications([candidate('finished')]), { show: [] })
      }
      assert.equal(preferenceReads, 2); assert.equal(decisions, 1)
    })
    await t.test('one current preference read covers all owned completions and filters only finished candidates', async () => {
      runs = [owned('finished', 'succeeded'), owned('another', 'succeeded'), owned('awaiting', 'waiting_input')]
      preferences = { proactive: true, pushFinished: false }
      const candidates = [candidate('finished'), candidate('finished', 'another'), candidate('awaiting')]
      assert.deepEqual(await chooseDesktopNotifications(candidates), { show: [candidates[2].id] })
      assert.equal(preferenceReads, 3); assert.equal(decisions, 2)
      assert.deepEqual(judged.at(-1), [candidates[2].id])
      preferences = { proactive: true, pushFinished: true }
      assert.deepEqual(await chooseDesktopNotifications(candidates), { show: candidates.map(item => item.id) })
      assert.equal(preferenceReads, 4, 'the next event reads fresh settings instead of an earlier cache')
      assert.equal(decisions, 3)
      assert.deepEqual(judged.at(-1), candidates.map(item => item.id))
    })
    await t.test('a failed preference read cannot produce a completion notification', async () => {
      preferenceFailure = new Error('fixture preference unavailable')
      await assert.rejects(chooseDesktopNotifications([candidate('finished')]), error => error === preferenceFailure)
      assert.equal(preferenceReads, 5); assert.equal(decisions, 3)
      preferenceFailure = null
    })
    await t.test('scheduled DND and per-channel desktop overrides filter candidates before asking the model', async () => {
      runs = [owned('finished', 'succeeded'), owned('awaiting', 'waiting_input')]
      preferences = { proactive: true, pushFinished: false }
      runtime = { ...runtime, desktop: { ...runtime.desktop, decide: false, finished: true } }
      assert.deepEqual(await chooseDesktopNotifications([candidate('finished'), candidate('awaiting')]), { show: [candidate('finished').id] })
      assert.equal(decisions, 4)

      runtime = { ...runtime, dnd: { enabled: true, start: '00:00', end: '00:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } }
      const beforeReads = preferenceReads
      assert.deepEqual(await chooseDesktopNotifications([candidate('finished'), candidate('awaiting')]), { show: [] })
      assert.equal(preferenceReads, beforeReads, 'active DND exits before reading legacy preferences or calling decide')
      assert.equal(decisions, 4)
      assert.ok(runtimeReads >= 2)
    })
  } finally { for (const handle of mocks.reverse()) handle.restore() }
})
