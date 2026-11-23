import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const RUN = '20000000-0000-4000-8000-000000000001'
const SANDBOX = { id: 'sandbox-one' }
let rows: Record<string, unknown>[] = []
let browserState: { targetId: string; url?: string; guarded?: boolean } | Error | null = { targetId: 'target-one' }
let installed = 0, granted: { role?: string } | null = null

mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: {
  pool: { query: async () => ({ rows }) },
} })
mock.module(new URL('../computer/e2b-provider.ts', import.meta.url).href, { namedExports: {
  connectComputer: async () => SANDBOX,
} })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  installSubagentRuntime: async () => { installed += 1 },
  runtimeRequest: async () => {
    if (browserState instanceof Error) throw browserState
    return browserState
  },
  grant: async (_sandbox: unknown, _binding: unknown, role: string) => {
    granted = { role }
    return { endpoint: 'https://sandbox.e2b.app/agents/run-one?token=tok', expiresAt: 1_700_000_000_000 }
  },
  endpointPath: (endpoint: string, path: string) => { const url = new URL(endpoint); url.pathname += path; return url.toString() },
} })

const { resolveThreadBrowserViewer, resolveThreadBrowserTarget } = await import('./subagent-browser')

const machine = (extra: Record<string, unknown> = {}) => ({ runId: RUN, ownerId: 'owner', workspaceId: 'workspace-one', state: 'running', sandboxId: 'sandbox-one', targetId: 'target-one', epoch: 1, botId: 'bot', ...extra })
const input = { userId: 'owner', workspaceId: 'workspace-one', runId: RUN }

beforeEach(() => { rows = [machine()]; browserState = { targetId: 'target-one' }; installed = 0; granted = null })

test('a view ticket is minted only against a live browser registration', async () => {
  const viewer = await resolveThreadBrowserViewer(input)
  assert.equal(viewer.url, 'wss://sandbox.e2b.app/agents/run-one/viewer?token=tok')
  assert.equal(installed, 1, 'the runtime is installed on the thread machine before minting')
  assert.equal(granted?.role, 'view')
})

test('a thread without a browser gets no ticket', async () => {
  rows = [machine({ targetId: null })]
  await assert.rejects(resolveThreadBrowserViewer(input), /Thread browser unavailable/)
  assert.equal(granted, null, 'no capability is minted when the run never opened a browser')
})

test('a stopped browser registration gets no ticket', async () => {
  browserState = new Error('Browser runtime unavailable')
  await assert.rejects(resolveThreadBrowserViewer(input), /Browser runtime unavailable/)
  assert.equal(granted, null)
})

test('the broker path still refuses a guarded or foreign page', async () => {
  browserState = { targetId: 'other-target', url: 'https://example.com/', guarded: false }
  await assert.rejects(resolveThreadBrowserTarget(input), /Thread browser unavailable/)
  browserState = { targetId: 'target-one', url: 'https://example.com/', guarded: true }
  await assert.rejects(resolveThreadBrowserTarget(input), /Thread browser unavailable/)
})
