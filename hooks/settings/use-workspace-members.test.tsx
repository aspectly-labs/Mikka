import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { billingManagementPath } from '@/lib/billing/management-path'
import { desktopActionSchemas } from '@/lib/desktop-rpc/schemas'
import type { WorkspaceMembers } from './use-workspace-members'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const payloads: unknown[] = []
const prefetchedKeys: unknown[] = []

mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useFormatter: () => ({}), useTranslations: () => (id: string) => id } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => (message: string) => message } })
mock.module('@/hooks/settings/use-invite-members', { namedExports: { useInviteMembers: () => ({}) } })
mock.module('@/components/settings/api-key-settings', { namedExports: { apiKeysKey: (id: string) => ['api-keys', id], readApiKeys: async () => [] } })
mock.module('@/components/settings/subscription-settings', { namedExports: { readSubscriptionUsage: async () => ({}), readSubscriptions: async () => [], subscriptionUsageKey: (id: string) => ['sub-usage', id], subscriptionsKey: (id: string) => ['subs', id] } })
mock.module('@/components/settings/model-order-settings', { namedExports: { modelOrderKey: (id: string) => ['model-order', id], readModelOrder: async () => [] } })
mock.module('@/components/plugins/connected-apps', { namedExports: { connectedAppsKey: 'connected-apps', readConnectedApps: async () => [] } })
mock.module('swr', {
  defaultExport: () => ({
    data: {
      workspace: { id: workspaceId, name: 'Acme', slug: 'acme', kind: 'team' },
      role: 'admin',
      currentUserId: 'owner-1',
      members: [],
      invitations: [],
    },
    mutate: async () => {},
    isValidating: false,
  }),
  namedExports: { unstable_serialize: JSON.stringify, useSWRConfig: () => ({ mutate: async () => {} }) },
})
mock.module('@/lib/settings-data', {
  namedExports: {
    fetchSettingsData: async () => ({}),
    memberSettingsKey: (id?: string) => ['members', id ?? null],
  },
})
mock.module('@/app/actions/workspace', {
  namedExports: {
    updateWorkspaceMember: async (input: unknown) => {
      payloads.push(input)
      return { ok: true }
    },
    revokeWorkspaceInvitation: async () => ({ ok: true }),
  },
})
mock.module('@/lib/swr/prefetch', {
  namedExports: {
    prefetchScopedRead: (_cache: unknown, _mutate: unknown, key: unknown) => {
      prefetchedKeys.push(key)
      return Promise.resolve()
    },
  },
})

test('useWorkspaceMembers strips confirmation-only name so workspace.updateWorkspaceMember passes strict RPC validation', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceMembers } = await import('./use-workspace-members')
  const root = createRoot(window.document.createElement('main') as unknown as HTMLElement)
  let state!: WorkspaceMembers
  function Probe() { state = useWorkspaceMembers(workspaceId); return null }
  try {
    await act(async () => root.render(<Probe />))
    await act(async () => {
      state.confirm([{ userId: 'member-lin', name: 'Lin Chen', role: 'admin', status: 'active' }])
    })
    await act(async () => { await state.applyChanges() })
    assert.equal(payloads.length, 1)
    assert.equal('name' in (payloads[0] as Record<string, unknown>), false)
    assert.doesNotThrow(() => desktopActionSchemas['workspace.updateWorkspaceMember'].parse([payloads[0]]))
    assert.equal(state.changes, null)
  } finally {
    await act(async () => root.unmount())
    await window.close()
  }
})

test('prefetchSettingsSection gates admin-only reads and avoids eager danger-dialog reads on general', async () => {
  const { prefetchSettingsSection } = await import('@/lib/settings-prefetch')
  const cache = new Map()
  const mutate = (async () => undefined) as never

  prefetchedKeys.length = 0
  for (const section of ['general', 'billing', 'usage', 'audit'] as const) {
    prefetchSettingsSection(section, workspaceId, cache, mutate, { admin: false })
  }
  const memberKeyNames = prefetchedKeys.map(key => JSON.stringify(key))
  assert.equal(memberKeyNames.some(k => k.includes('transfer-targets') || k.includes('deletion-impact')), false)
  assert.equal(memberKeyNames.some(k => k.includes('billing') || k.includes('audit')), false)
  assert.equal(memberKeyNames.some(k => k.includes('workspace:general')), true)
  assert.equal(memberKeyNames.some(k => k.includes('settings:usage')), true)

  prefetchedKeys.length = 0
  for (const section of ['general', 'billing', 'usage', 'audit'] as const) {
    prefetchSettingsSection(section, workspaceId, cache, mutate, { admin: true })
  }
  const adminKeyNames = prefetchedKeys.map(key => JSON.stringify(key))
  const expectedBillingPath = billingManagementPath({ kind: 'workspace', id: workspaceId }, null)
  assert.equal(adminKeyNames.some(k => k.includes('transfer-targets') || k.includes('deletion-impact')), false)
  assert.equal(adminKeyNames.some(k => k.includes(expectedBillingPath)), true)
  assert.equal(adminKeyNames.some(k => k.includes('credit-billing')), true)
  assert.equal(adminKeyNames.some(k => k.includes('settings:audit')), true)
})
