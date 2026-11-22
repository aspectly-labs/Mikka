import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { act, useState } from 'react'
import { Window } from 'happy-dom'
import type { BotModelMenu } from '../lib/bot-model-menu-view'
import { PersistentReadCache } from '../lib/swr/persistent-cache'

const initial: BotModelMenu = {
  current: { id: 'old', modelId: 'gpt-6-luna', provider: 'codex',
    kind: 'subscription', available: true, availability: 'available', chosen: true },
  groups: [
    { kind: 'subscription', provider: 'codex', options: [{ id: 'old', modelId: 'gpt-6-luna', provider: 'codex' }] },
    { kind: 'subscription', provider: 'claude', options: [{ id: 'haiku', modelId: 'claude-haiku-5-5', provider: 'claude' }] },
  ],
}
let chooseResult: Promise<BotModelMenu | { error: string }> = Promise.resolve(initial)
let refreshes = 0
let failures = 0
let choices: string[] = []
let fixtureMenu: BotModelMenu | undefined = initial
const fixtureScope = (userId: string, workspaceId: string) => new PersistentReadCache({ userId, workspaceId, role: 'admin', build: 'fixture' })
let fixtureCache: Map<string, unknown> = new Map()
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key } })
mock.module('sonner', { namedExports: { toast: { error: () => { failures++ } } } })
mock.module('swr', { namedExports: { useSWRConfig: () => ({ cache: fixtureCache }) }, defaultExport: function useFixtureSWR() {
  const [data, setData] = useState(fixtureMenu)
  return { data, error: undefined, mutate: async (update: () => Promise<BotModelMenu>, options: {
    optimisticData?: BotModelMenu; rollbackOnError?: boolean
  } = {}) => {
    if (options.optimisticData) setData(options.optimisticData)
    try {
      const updated = await update()
      setData(updated)
      return updated
    } catch (error) {
      if (options.rollbackOnError) setData(initial)
      throw error
    }
  } }
} })
mock.module(new URL('../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: {
  getBotModelMenu: async () => initial,
  chooseBotModel: async (_botId: string | null, id: string) => { choices.push(id); return chooseResult },
  refreshBotModelMenuAction: async () => { refreshes++; return initial },
} })

const browser = new Window({ url: 'https://mikka.test/mikka' })
let createRoot: typeof import('react-dom/client')['createRoot']
let useBotModelPicker: typeof import('../hooks/use-bot-model-picker')['useBotModelPicker']
before(async () => {
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useBotModelPicker } = await import('../hooks/use-bot-model-picker'))
})

test('rapid choices are saved in order and sending waits for the last requested choice', async () => {
  const releases: Array<(menu: BotModelMenu) => void> = []
  const deferred = () => new Promise<BotModelMenu>(resolve => { releases.push(resolve) })
  chooseResult = deferred()
  choices = []
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  let picker!: ReturnType<typeof useBotModelPicker>
  function Probe() { picker = useBotModelPicker(null); return null }
  const haiku: BotModelMenu = { ...initial, current: { ...initial.current, id: 'haiku', modelId: 'claude-haiku-5-5', provider: 'claude' } }
  try {
    await act(async () => { root.render(<Probe />) })
    let first!: Promise<boolean>, second!: Promise<boolean>
    await act(async () => { first = picker.choose('haiku') })
    let ready = false
    const send = picker.waitForSave().then(() => { ready = true })
    await act(async () => { second = picker.choose('old'); picker.chooseItem('haiku') })
    assert.deepEqual(choices, ['haiku'])
    chooseResult = deferred()
    await act(async () => { releases[0](haiku); await first })
    assert.deepEqual(choices, ['haiku', 'old'])
    assert.equal(ready, false, 'sending also waits for choices queued after the first send attempt')
    chooseResult = deferred()
    await act(async () => { releases[1](initial); await second })
    assert.deepEqual(choices, ['haiku', 'old', 'haiku'], 'the final choice cannot be skipped against a stale optimistic menu')
    await Promise.resolve()
    assert.equal(ready, false)
    await act(async () => { releases[2](haiku); await send })
    assert.equal(picker.menu?.current.id, 'haiku')
    await act(async () => { picker.chooseItem('haiku'); await picker.waitForSave() })
    assert.deepEqual(choices, ['haiku', 'old', 'haiku'], 'a confirmed current selection does not write again')
  } finally { await act(async () => root.unmount()) }
})

test('opening a cached picker does not refresh subscriptions, and an unsaved choice rolls back', async () => {
  let release!: (result: BotModelMenu | { error: string }) => void
  chooseResult = new Promise(resolve => { release = resolve })
  refreshes = 0
  failures = 0
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  let picker!: ReturnType<typeof useBotModelPicker>
  function Probe() { picker = useBotModelPicker(null); return null }
  try {
    await act(async () => { root.render(<Probe />) })
    await act(async () => { picker.setOpen(true) })
    assert.equal(picker.open, true)
    assert.equal(refreshes, 0, 'opening a menu cannot block on refreshing provider catalogues')
    let save!: Promise<boolean>
    await act(async () => { save = picker.choose('haiku') })
    assert.equal(picker.menu?.current.id, 'haiku', 'the selection is visible before server acknowledgement')
    assert.equal(picker.menu?.current.availability, 'checking')
    await act(async () => { release({ error: 'notSaved' }); await save })
    assert.equal(await save, false)
    assert.equal(picker.menu?.current.id, 'old', 'a failed save restores the confirmed model')
    assert.equal(failures, 1)
  } finally { await act(async () => root.unmount()) }
})

test('the pending Coordinator chip follows the authenticated read cache across account and workspace switches', async () => {
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  const alice = fixtureScope('alice', 'home')
  let chip: ReturnType<typeof useBotModelPicker>['last'] = null
  function Probe() { chip = useBotModelPicker(null).last; return null }
  async function mount(key: string, cache: Map<string, unknown>, menu?: BotModelMenu) {
    fixtureCache = cache
    fixtureMenu = menu
    await act(async () => { root.render(<Probe key={key} />) })
    return chip
  }
  try {
    browser.localStorage.setItem('mikka:model-chip:coordinator', JSON.stringify({ id: 'legacy', modelId: 'fixture', provider: 'codex' }))
    assert.equal(await mount('legacy chip', alice), null)
    await mount('first', alice, initial)
    assert.deepEqual(await mount('reload', fixtureScope('alice', 'home')), {
      id: 'old', modelId: 'gpt-6-luna', provider: 'codex',
    })
    assert.equal(await mount('switch workspace', fixtureScope('alice', 'other')), null)
    assert.equal(await mount('switch account', fixtureScope('bob', 'home')), null)
    assert.equal(await mount('unresolved workspace', new Map()), null)
  } finally {
    fixtureCache = new Map()
    fixtureMenu = initial
    await act(async () => root.unmount())
  }
})

test('a row says why it cannot run, else its price on Mikka 额度 only; its tooltip names the route (Figma 1318:71)', async () => {
  const { modelRowEnd, modelRouteTitle } = await import('../hooks/use-bot-model-picker')
  const t = ((key: string, values?: Record<string, string>) => values ? `${key}(${Object.values(values).join(',')})` : key) as never
  const credits = { source: 'credits' as const, connectionId: null, label: '' }
  assert.equal(modelRowEnd(t, { route: credits, price: { input: 3, output: 15 } }), '$3 / $15')
  assert.equal(modelRowEnd(t, { route: credits, price: { input: 0, output: 0 } }), 'route.free')
  assert.equal(modelRowEnd(t, { route: { source: 'subscription', connectionId: 'c', label: 'Max' }, price: { input: 3, output: 15 } }), null, 'a subscription row has no price')
  assert.equal(modelRowEnd(t, { route: { source: 'byok', connectionId: 'k', label: '····1234' } }), null, 'a key row has no price')
  assert.equal(modelRowEnd(t, { route: credits, price: { input: 3, output: 15 }, unavailable: { reason: 'points' } }), 'route.noCredits')
  assert.equal(modelRowEnd(t, { route: { source: 'subscription', connectionId: 'c', label: 'Max' }, unavailable: { reason: 'quota', resetsAt: null } }), 'route.usedUp')
  assert.match(modelRowEnd(t, { unavailable: { reason: 'quota', resetsAt: '2099-01-01T15:00:00.000Z' } }) ?? '', /^route\.usedUntil\(/)
  assert.equal(modelRouteTitle(t, { kind: 'hosted', options: [] }), 'route.via(creditsGroup)')
  assert.equal(modelRouteTitle(t, { kind: 'apiKey', credentialLabel: 'Mine ····1234', options: [] }), 'route.via(apiKey · Mine ····1234)')
})
