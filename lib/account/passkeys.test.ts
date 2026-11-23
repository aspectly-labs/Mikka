import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopActionSchemas } from '@/lib/desktop-rpc/schemas'
import { toPasskeySummary } from './passkeys'
import {
  deletePasskeyInputSchema,
  PASSKEY_NAME_MAX,
  renamePasskeyBodySchema,
  renamePasskeyInputSchema,
} from './passkeys-contract'

test('toPasskeySummary omits credential secrets and resolves known authenticator AAGUIDs', () => {
  const summary = toPasskeySummary({
    id: 'pk_123',
    name: 'Work MacBook',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: 'internal, hybrid , ',
    createdAt: new Date('2026-11-22T00:00:00.000Z'),
    aaguid: 'BADA5566-A7AA-401F-BD96-45619A55120D',
    ...({ publicKey: 'SECRET_PUBLIC_KEY', credentialID: 'SECRET_CRED_ID', counter: 42, userId: 'user_1' } as Record<string, unknown>),
  })
  assert.deepEqual(summary, {
    id: 'pk_123',
    name: 'Work MacBook',
    providerName: '1Password',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: ['internal', 'hybrid'],
    createdAt: '2026-11-22T00:00:00.000Z',
    aaguid: 'BADA5566-A7AA-401F-BD96-45619A55120D',
  })
  assert.equal(Object.hasOwn(summary, 'publicKey'), false)
  assert.equal(Object.hasOwn(summary, 'credentialID'), false)
  assert.equal(Object.hasOwn(summary, 'counter'), false)
  assert.equal(Object.hasOwn(summary, 'userId'), false)

  const anonymous = toPasskeySummary({
    id: 'pk_anon',
    name: null,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: '',
    createdAt: null,
    aaguid: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(anonymous.providerName, null)
  assert.deepEqual(anonymous.transports, [])
  assert.equal(anonymous.createdAt, null)
})

test('passkey schemas and Desktop RPC schemas enforce strict owner-free inputs', () => {
  assert.deepEqual(renamePasskeyInputSchema.parse({ id: 'pk_1', name: '  Touch ID  ' }), { id: 'pk_1', name: 'Touch ID' })
  assert.deepEqual(renamePasskeyBodySchema.parse({ name: 'Security Key' }), { name: 'Security Key' })
  assert.deepEqual(deletePasskeyInputSchema.parse({ id: 'pk_1' }), { id: 'pk_1' })

  for (const bad of [
    { id: '', name: 'Key' },
    { id: 'pk_1', name: '   ' },
    { id: 'pk_1', name: 'x'.repeat(PASSKEY_NAME_MAX + 1) },
    { id: 'pk_1', name: 'Key', userId: 'forged_owner' },
  ]) {
    assert.equal(renamePasskeyInputSchema.safeParse(bad).success, false)
  }

  assert.equal(desktopActionSchemas['passkeys.listPasskeys'].safeParse([]).success, true)
  assert.equal(desktopActionSchemas['passkeys.listPasskeys'].safeParse([{ userId: 'forged' }]).success, false)
  assert.equal(desktopActionSchemas['passkeys.renamePasskey'].safeParse([{ id: 'pk_1', name: 'Key' }]).success, true)
  assert.equal(desktopActionSchemas['passkeys.renamePasskey'].safeParse([{ id: 'pk_1', name: 'Key', userId: 'forged' }]).success, false)
  assert.equal(desktopActionSchemas['passkeys.deletePasskey'].safeParse([{ id: 'pk_1' }]).success, true)
  assert.equal(desktopActionSchemas['passkeys.deletePasskey'].safeParse([{ id: 'pk_1', userId: 'forged' }]).success, false)
})
