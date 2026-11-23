import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ServiceIdentityRequestError, type ServiceCredentialState, type ServiceIdentityPage, type ServiceIdentityRow } from '../../lib/governance/service-identity-client'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const identityId = '22222222-2222-4222-8222-222222222222'
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8'))
const lookup = (path: string) => path.split('.').reduce((node, part) => node?.[part], zh)
const translator = (namespace: string) => Object.assign((key: string, values?: Record<string, unknown>) => {
  const value = lookup(`${namespace}.${key}`)
  assert.equal(typeof value, 'string', `missing ${namespace}.${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] === undefined ? match : String(values[name]))
}, { has: (key: string) => typeof lookup(`${namespace}.${key}`) === 'string' })

mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'zh-CN', useTranslations: translator } })
mock.module(new URL('../../app/actions/tokens.ts', import.meta.url).href, {
  namedExports: {
    listAccessTokens: async () => [],
    createAccessToken: async () => ({ token: 'mkp_test' }),
    revokeAccessToken: async () => ({ id: identityId }),
  },
})

let serverIdentity: ServiceIdentityRow
let serverConfigured: boolean
const calls: string[] = []

mock.module('@/lib/governance/service-identity-client', {
  namedExports: {
    ServiceIdentityRequestError,
    serviceIdentityClient: () => ({
      list: async (): Promise<ServiceIdentityPage> => ({ identities: [{ ...serverIdentity }], nextCursor: null }),
      create: async (name: string): Promise<ServiceIdentityRow> => {
        serverIdentity = { id: identityId, workspaceId, name, enabled: true, revision: 1 }
        serverConfigured = false
        calls.push(`create:${name}@1`)
        return { ...serverIdentity }
      },
      change: async (row: ServiceIdentityRow, change: { action: 'rename'; name: string } | { action: 'disable' | 'restore' }): Promise<ServiceIdentityRow> => {
        if (row.revision !== serverIdentity.revision) throw new ServiceIdentityRequestError(409, 'service_identity_changed')
        serverIdentity = {
          ...serverIdentity,
          name: change.action === 'rename' ? change.name : serverIdentity.name,
          enabled: change.action === 'disable' ? false : change.action === 'restore' ? true : serverIdentity.enabled,
          revision: serverIdentity.revision + 1,
        }
        if (change.action === 'disable') serverConfigured = false
        calls.push(`${change.action}@${serverIdentity.revision}`)
        return { ...serverIdentity }
      },
      credential: async (): Promise<ServiceCredentialState> => ({
        enabled: serverIdentity.enabled,
        revision: serverIdentity.revision,
        configured: serverConfigured,
        expiresAt: null,
      }),
      rotate: async (_id: string, revision: number): Promise<ServiceCredentialState & { token: string }> => {
        if (revision !== serverIdentity.revision) throw new ServiceIdentityRequestError(409, 'service_identity_changed')
        serverIdentity = { ...serverIdentity, revision: serverIdentity.revision + 1 }
        serverConfigured = true
        calls.push(`rotate@${serverIdentity.revision}`)
        return { enabled: serverIdentity.enabled, revision: serverIdentity.revision, configured: true, expiresAt: null, token: `mksvc_rev_${serverIdentity.revision}` }
      },
      revoke: async (_id: string, revision: number): Promise<ServiceCredentialState> => {
        if (revision !== serverIdentity.revision) throw new ServiceIdentityRequestError(409, 'service_identity_changed')
        serverIdentity = { ...serverIdentity, revision: serverIdentity.revision + 1 }
        serverConfigured = false
        calls.push(`revoke@${serverIdentity.revision}`)
        return { enabled: serverIdentity.enabled, revision: serverIdentity.revision, configured: false, expiresAt: null }
      },
    }),
  },
})

mock.module('swr', {
  defaultExport: (key: unknown, fetcher: () => Promise<unknown>) => {
    const k = JSON.stringify(key)
    const [data, setData] = useState<unknown>(() => {
      if (k.includes('service-identity-credential')) return { enabled: serverIdentity.enabled, revision: serverIdentity.revision, configured: serverConfigured, expiresAt: null }
      if (k.includes('service-identities')) return { identities: [{ ...serverIdentity }], nextCursor: null }
      return []
    })
    return {
      data,
      error: undefined,
      mutate: async (next?: unknown, opts?: { revalidate?: boolean }) => {
        const resolved = opts?.revalidate === false && next !== undefined ? next : await fetcher()
        setData(resolved)
        return resolved
      },
    }
  },
})

const browser = new Window({ url: 'https://fixture.example/mikka/settings?section=developer' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let AccessTokensSettings: typeof import('./access-tokens-settings')['AccessTokensSettings']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AccessTokensSettings } = await import('./access-tokens-settings'))
})

beforeEach(() => {
  serverIdentity = { id: identityId, workspaceId, name: 'Deploy Bot', enabled: true, revision: 1 }
  serverConfigured = false
  calls.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
after(() => browser.close())

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === text) as HTMLButtonElement | undefined

test('service account dialog keeps identity and credential revisions synchronized across rotate, rename, disable, restore and revoke', async () => {
  await act(async () => {
    root.render(<AccessTokensSettings workspaceId={workspaceId} />)
  })

  await act(async () => {
    buttonByText('管理')!.click()
  })

  // 1. Issue & rotate key -> revision advances to 2 and 3
  await act(async () => {
    buttonByText('签发密钥')!.click()
  })
  await act(async () => {
    buttonByText('轮换密钥')!.click()
  })

  // 2. Rename immediately after rotate -> must send revision 3 (not stale 1!) -> advances to 4
  const nameInput = document.querySelector<HTMLInputElement>('#manage-service-name')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!
    setter.call(nameInput, 'Deploy Bot v2')
    nameInput.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
  await act(async () => {
    buttonByText('重命名')!.click()
  })

  // 3. Disable -> restore -> issue -> revoke -> disable must all use latest revision without 409 conflict
  await act(async () => {
    buttonByText('停用')!.click()
  })
  await act(async () => {
    buttonByText('恢复')!.click()
  })
  await act(async () => {
    buttonByText('签发密钥')!.click()
  })
  await act(async () => {
    buttonByText('撤销密钥')!.click()
  })
  await act(async () => {
    buttonByText('停用')!.click()
  })

  assert.equal(document.body.textContent?.includes('其他管理员已修改设置'), false)
  assert.deepEqual(calls, [
    'rotate@2',
    'rotate@3',
    'rename@4',
    'disable@5',
    'restore@6',
    'rotate@7',
    'revoke@8',
    'disable@9',
  ])
})
