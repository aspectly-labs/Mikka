import test from 'node:test'
import { MailboxError } from '@/lib/mailbox-error'
import assert from 'node:assert/strict'
import { approvedWriteHandler } from './write-http'
import { OperationError } from './ledger'
import type { ApprovedWriteView } from './approved-writes'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const read = { op: 'view', action: 'send_slack_message', id }
const decision = { op: 'decide', action: 'send_slack_message', id, approve: true }
const session = { user: { id: 'owner' }, session: { id: 'session' } }
const view = { id, action: 'send_slack_message', status: 'running', error: 'operationUncertain' } as unknown as ApprovedWriteView
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://candidate.invalid/approved-writes', {
  method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid', ...headers }, body: JSON.stringify(body),
})

test('malformed requests and the retired propose fail before constructing an operation service', async () => {
  let calls = 0
  const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => { calls++; throw Error('unexpected service') })
  const proposal = { op: 'propose', action: 'send_slack_message', intentId: id, input: { channel: 'C12345678', text: 'Fixture' } }
  for (const body of [null, [], {}, proposal, { ...read, id: 'run-1' }, { ...read, ownerId: 'other' }, { ...decision, approve: 'true' }]) {
    const response = await handler(request(body))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const malformed = new Request('https://candidate.invalid/approved-writes', { method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid' }, body: '{' })
  assert.equal((await handler(malformed)).status, 400)
  assert.equal(calls, 0)
})

test('nothing waits for approval: a decision is refused without constructing an operation service', async () => {
  let calls = 0
  const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => { calls++; throw Error('unexpected service') })
  for (const approve of [true, false]) {
    const response = await handler(request({ ...decision, approve }))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'pendingActionUnavailable' })
  }
  assert.equal(calls, 0)
})

test('browser authority is checked before operation creation', async () => {
  let calls = 0
  const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => { calls++; throw Error('unexpected service') })
  for (const body of [read, decision]) {
    assert.equal((await handler(request(body, { authorization: 'Bearer synthetic' }))).status, 401)
    assert.equal((await handler(request(body, { cookie: '' }))).status, 401)
    assert.equal((await handler(request(body, { origin: 'https://other.invalid' }))).status, 403)
  }
  assert.equal((await handler(new Request('https://candidate.invalid/approved-writes'))).status, 405)
  assert.equal(calls, 0)
})

test('native session bearer passes the real human session identity and cannot fall back to cookies', async () => {
  const authorization = `Bearer ${'n'.repeat(32)}`
  let reads = 0
  const handler = approvedWriteHandler({ api: { getSession: async ({ headers, query }) => {
    assert.equal(headers.get('authorization'), authorization)
    assert.equal(headers.has('cookie'), false)
    assert.equal(query.disableCookieCache, true)
    reads++
    return session
  } } }, () => ({
    view: async (actor, actionId) => { assert.deepEqual(actor, { userId: 'owner', sessionId: 'session' }); assert.equal(actionId, id); return view },
  }))
  assert.equal((await handler(request(read, { authorization }))).status, 200)
  assert.equal((await handler(request(read, { authorization, origin: 'https://foreign.invalid' }))).status, 403)
  assert.equal((await handler(request(read, { authorization: `Bearer mkp_${'x'.repeat(43)}` }))).status, 401)
  assert.equal(reads, 1)
})

test('session and infrastructure failures are sanitized unavailable outcomes, conflicts retain their code', async () => {
  const brokenAuth = approvedWriteHandler({ api: { getSession: async () => { throw Error('private authentication diagnostic') } } }, () => { throw Error('unexpected service') })
  const unavailable = await brokenAuth(request(read))
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'writeServiceUnavailable' })
  for (const error of [new Error('private database diagnostic'), new OperationError('operationIntentAmbiguous'), new OperationError('operationUncertain')]) {
    const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => ({ view: async () => { throw error } }))
    const response = await handler(request(read))
    assert.equal(response.status, error instanceof OperationError ? 409 : 503)
    assert.deepEqual(await response.json(), { error: error instanceof OperationError ? error.message : 'writeServiceUnavailable' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const absent = approvedWriteHandler({ api: { getSession: async () => null } }, () => { throw Error('unexpected service') })
  assert.equal((await absent(request(read))).status, 401)
})

test('a receipt read carries the session identity and stays unresolved on repeat', async () => {
  let reads = 0
  const handler = approvedWriteHandler({ api: { getSession: async ({ query }) => { assert.equal(query.disableCookieCache, true); return session } } }, action => {
    assert.equal(action, read.action)
    return { view: async (actor, actionId) => { reads++; assert.deepEqual(actor, { userId: 'owner', sessionId: 'session' }); assert.equal(actionId, id); return view } }
  })
  for (let i = 0; i < 2; i++) {
    const response = await handler(request(read))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'running'); assert.equal(body.error, 'operationUncertain'); assert.ok(Date.parse(body.observedAt))
  }
  assert.equal(reads, 2)
})

test('real HTTP envelope passes request signal/actor and preserves unconfirmed vs committed without diagnostics',async()=>{
 const req=request(read);let seen=false
 const service=approvedWriteHandler({api:{getSession:async()=>session}},(_action,context)=>{
  assert.equal(context?.signal,req.signal);assert.deepEqual(context?.actor,{userId:'owner',sessionId:'session'});seen=true
  return {view:async()=>{throw new MailboxError('private database diagnostic',409,'unconfirmed')}}
 })
 const response=await service(req);assert.equal(seen,true);assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'writeCommitUnconfirmed',commitState:'unconfirmed'})
 const committed=approvedWriteHandler({api:{getSession:async()=>session}},()=>({view:async()=>{throw new MailboxError('private cleanup diagnostic',503,'committed')}}))
 assert.deepEqual(await (await committed(request(read))).json(),{error:'writeCommitFinalizationFailed',commitState:'committed'})
})
