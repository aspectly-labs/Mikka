import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mock, test } from 'node:test'

test('connecting Linear for automations creates a user-bound PKCE grant with read scope', async () => {
  const saveGrant = mock.fn(async (_row: { userId: string; stateHash: string }) => {})
  const setCookie = mock.fn()
  mock.module('@/lib/auth', { namedExports: { authBaseURL: 'https://mikka.invalid' } })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => ({ id: 'owner' }) } })
  mock.module('@/lib/db', { namedExports: { db: {
    delete: () => ({ where: async () => {} }),
    insert: () => ({ values: saveGrant }),
  }, pool: {} } })
  mock.module('@/lib/live/lists', { namedExports: { ownerWorkspaceSettingsChanged: async () => {} } })
  mock.module('@/lib/server-runtime/headers', { namedExports: { cookies: async () => ({ set: setCookie }) } })
  process.env.LINEAR_CLIENT_ID = 'fixture-id'
  process.env.LINEAR_CLIENT_SECRET = 'fixture-secret'
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  process.env.LINEAR_REDIRECT_URL = 'https://mikka.invalid/api/integrations/linear/callback'
  const actions = await import('../../app/actions/linear-sync')
  const url = new URL((await actions.startLinearOAuth()).url)
  assert.equal(url.searchParams.get('scope'), 'read')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'))
  assert.equal(saveGrant.mock.calls[0].arguments[0].userId, 'owner')
  assert.equal(setCookie.mock.calls[0].arguments[1], url.searchParams.get('state'))
  assert.equal((await actions.getLinearIntegrationState()).enabled, false)
})
