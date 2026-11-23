import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

// A Composio link from the desktop is one use, short lived, and names the link
// Composio gave it so the shared callback and a duplicated navigation find it.
test('a Composio connect intent is single use, short lived and names its link', { skip: !dbUrl }, async t => {
  const [intents, { pool }] = await Promise.all([import('../lib/composio-connect-intent'), import('../lib/db')])
  const user = await seedUser(pool, 'composio-intent')
  t.after(async () => {
    await pool.query('delete from "user" where id = $1', [user])
    await pool.end()
  })
  const make = () => intents.createComposioConnectIntent(pool, {
    userId: user, toolkit: 'gmail', replaceAccountId: 'acct-old',
    returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43),
  })

  await t.test('create → claim once → link → the callback and a duplicated navigation find it', async () => {
    const { token } = await make()
    const intent = await intents.readComposioConnectIntent(pool, token)
    assert.equal(intent?.userId, user)
    assert.equal(intent?.replaceAccountId, 'acct-old')
    const claimed = await intents.claimComposioConnectIntent(pool, token)
    assert.equal(claimed?.toolkit, 'gmail')
    // Single use: the same token claims nothing again.
    assert.equal(await intents.claimComposioConnectIntent(pool, token), null)
    // Before the link is recorded a duplicate navigation still fails.
    assert.equal(await intents.linkedComposioConnectIntent(pool, claimed!.tokenHash), null)
    await intents.linkComposioConnectIntent(pool, claimed!.tokenHash, 'ca_1', 'https://connect.composio.dev/link/ca_1')
    // While fresh, the twin re-reads the recorded provider redirect.
    const again = await intents.linkedComposioConnectIntent(pool, claimed!.tokenHash)
    assert.equal(again?.providerUrl, 'https://connect.composio.dev/link/ca_1')
    // The callback resolves the intent by the connected account Composio completed, while it lives.
    assert.equal((await intents.composioConnectIntentByLink(pool, 'ca_1'))?.tokenHash, claimed!.tokenHash)
    assert.equal(await intents.composioConnectIntentByLink(pool, 'ca_1', new Date(Date.now() + 11 * 60_000)), null)
    assert.equal(await intents.composioConnectIntentByLink(pool, 'ca_none'), null)
  })

  await t.test('an expired intent claims nothing', async () => {
    const { token } = await make()
    await pool.query('UPDATE composio_connect_intents SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1', [user])
    assert.equal(await intents.claimComposioConnectIntent(pool, token), null)
  })

  await t.test('a malformed or unknown token reads nothing', async () => {
    for (const bad of ['x', 'coi_short', null, 'coi_' + 'z'.repeat(43)]) {
      assert.equal(await intents.readComposioConnectIntent(pool, bad), null, String(bad))
      assert.equal(await intents.claimComposioConnectIntent(pool, bad), null, String(bad))
    }
  })

  await t.test('the loopback must be a bare 127.0.0.1 /return URL with a 43-char state', async () => {
    for (const returnTo of ['http://localhost:1/return', 'https://127.0.0.1:1/return', 'http://127.0.0.1/return', 'http://127.0.0.1:1/return?x=1', 'http://127.0.0.1:1/other', 'http://evil.example:1/return', 7]) {
      assert.equal(intents.composioLoopback({ returnTo, returnState: 's'.repeat(43) }), null, String(returnTo))
    }
    assert.equal(intents.composioLoopback({ returnTo: 'http://127.0.0.1:1/return', returnState: 'short' }), null)
    const loopback = intents.composioLoopback({ returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43) })
    assert.deepEqual(loopback, { returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43) })
  })
})
