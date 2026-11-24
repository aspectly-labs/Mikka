import assert from 'node:assert/strict'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
import { EnvironmentError } from '../test-accounts/environment.mjs'
import { TestAccountError } from '../test-accounts/pool.mjs'
import { decode } from '../../lib/desktop-rpc/wire.ts'
import { READ_ACTIONS, ReadCacheAcceptanceError, ReadCacheDiagnosticError, createReadClient, discoverReadActions, exerciseReadCases, publicFailure, requestAllowed } from './read-cache.mjs'
import { observedAction, publishedReadActions, readRpcActions, rpcReadRequest } from './read-action-transport.mjs'

// The CI entry is plain node --test; scope TypeScript alias resolution to this
// real production schema instead of depending on a process-wide test loader.
const { desktopActionSchemas } = await tsImport('../../lib/desktop-rpc/schemas.ts', import.meta.url)

const environment = { origin: 'http://127.0.0.1:3110', basePath: '/mikka' }
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const refs = readRpcActions
const actionInit = name => rpcReadRequest(name, [], environment, refs).init
const page = '<script type="module" src="/mikka/assets/index-realbuild.js"></script>'
const manifest = { version: 1, target: 'web', usedActions: [...Object.values(readRpcActions), 'coordinator.sendCoordinatorMessage'] }

test('failure evidence preserves registered account and environment codes without private diagnostics', () => {
  const privateText = 'private account, response and SQL parameter'
  for (const error of [new TestAccountError('TEST_ACCOUNT_HTTP_FAILED'), new TestAccountError('ACCOUNT_INITIALIZATION_FAILED'), new EnvironmentError('DEPLOYMENT_IDENTITY_MISMATCH')]) {
    error.message = privateText
    error.cause = new Error(privateText)
    assert.deepEqual(publicFailure(error), { status: 'fail', code: error.code })
  }
  for (const error of [new TestAccountError(privateText), new EnvironmentError(privateText), Object.assign(new Error(privateText), { code: privateText })]) {
    assert.deepEqual(publicFailure(error), { status: 'fail', code: 'read_cache_acceptance_failed' })
  }
  assert.deepEqual(publicFailure(Object.assign(new Error(privateText), { code: '23503', detail: privateText })), { status: 'fail', code: 'read_cache_acceptance_failed', sqlState: '23503' })
  assert.deepEqual(publicFailure(new TypeError(privateText)), { status: 'fail', code: 'read_cache_acceptance_failed', errorType: 'TypeError' })
})

test('driver stage evidence retains the original cause and never claims an unobserved lease cleanup', () => {
  const privateText = 'private account, response and SQL parameter'
  const cause = new TestAccountError('ACCOUNT_INITIALIZATION_FAILED')
  cause.message = privateText
  const error = new ReadCacheDiagnosticError(cause, { stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started', userId: privateText, body: privateText })
  assert.equal(error.cause, cause)
  assert.deepEqual(publicFailure(error), { status: 'fail', code: 'ACCOUNT_INITIALIZATION_FAILED', stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started', leaseCleanup: 'unobserved' })
  const afterCleanup = new ReadCacheDiagnosticError(new ReadCacheAcceptanceError('read_action_reference_missing'), {
    stage: 'action-discovery', completedReads: 2, fixtureCleanup: 'succeeded', leaseCleanup: 'dirty', privateText,
  })
  assert.deepEqual(publicFailure(afterCleanup), { status: 'fail', code: 'read_action_reference_missing', stage: 'action-discovery', completedReads: 2, fixtureCleanup: 'succeeded', leaseCleanup: 'unobserved' })
  const unknown = new ReadCacheDiagnosticError(new Error(privateText), { stage: privateText, completedReads: privateText, fixtureCleanup: privateText, leaseCleanup: privateText })
  assert.deepEqual(publicFailure(unknown), { status: 'fail', code: 'read_cache_acceptance_failed', stage: 'unknown', completedReads: 0, fixtureCleanup: 'unobserved', leaseCleanup: 'unobserved' })
  assert.equal(JSON.stringify([publicFailure(error), publicFailure(afterCleanup), publicFailure(unknown)]).includes(privateText), false)
})

test('the request allowlist admits only scoped GETs and published read actions', () => {
  for (const path of ['/mikka/api/version', '/mikka/api/auth/get-session', '/mikka/api/workspace/switcher', '/mikka/api/settings/issue-prefix', '/mikka', '/mikka/settings?section=preferences', `/mikka?issue=${id(1)}`, '/mikka/assets/index-realbuild.js'])
    assert.equal(requestAllowed(path, {}, environment, refs), true, path)
  for (const name of READ_ACTIONS) assert.equal(requestAllowed('/mikka/api/rpc', actionInit(name), environment, refs), true)
  for (const path of ['https://other.example/mikka', '/api/settings/issue-prefix', '/mikka/api/coordinator/messages', '/mikka/api/mobile/chat', '/mikka/api/bots', '/mikka/api/acceptance', '/mikka?acceptance=1', '/mikka/settings?section=secrets', '/mikka/assets/%2e%2e/private.js', '/mikka/assets/a%2fb.js'])
    assert.equal(requestAllowed(path, {}, environment, refs), false, path)
  assert.equal(requestAllowed('/mikka/api/rpc', { ...actionInit('pollIssue'), method: 'DELETE' }, environment, refs), false)
  assert.equal(requestAllowed('/mikka', actionInit('pollIssue'), environment, refs), false)
  assert.equal(requestAllowed('/mikka/api/rpc', actionInit('pollIssue'), environment, {}), false)
  assert.equal(requestAllowed('/mikka/api/version', { headers: { cookie: 'private' } }, environment), false)
  assert.equal(requestAllowed('/mikka/api/version', { body: 'data' }, environment), false)
  // A read must not switch locale and persistently rename the baseline workspace.
  for (const path of ['/mikka/en', '/mikka/en/settings?section=preferences']) {
    assert.equal(requestAllowed(path, {}, environment, refs), false)
    assert.equal(requestAllowed(path, actionInit('pollIssue'), environment, refs), false)
  }
})

test('missing named references fail closed instead of guessing action IDs', async () => {
  await assert.rejects(discoverReadActions(async () => new Response('<html></html>'), environment, id(1)), { code: 'read_action_reference_missing' })
})

test('Vite discovery uses the actual published used-actions manifest and never widens the five-read boundary', async () => {
  const calls = []
  const discovered = await discoverReadActions(async path => {
    calls.push(path)
    assert.equal(requestAllowed(path, {}, environment), true)
    return path.endsWith('/renderer-manifest.json')
      ? Response.json(manifest)
      : new Response(page)
  }, environment, id(1))
  assert.deepEqual(discovered.refs, readRpcActions)
  assert.equal(discovered.diagnostics.transport, 'rpc')
  assert.equal(discovered.diagnostics.manifestsRead, 1)
  assert.deepEqual(calls, ['/mikka', `/mikka?issue=${id(1)}`, '/mikka/settings?section=preferences', '/mikka/renderer-manifest.json'])
  for (const invalid of [{ ...manifest, target: 'desktop' }, { ...manifest, version: 2 },
    { ...manifest, usedActions: manifest.usedActions.slice(1) },
    { ...manifest, usedActions: [...manifest.usedActions, manifest.usedActions[0]] },
    { ...manifest, usedActions: undefined, exports: manifest.usedActions }]) assert.throws(() => publishedReadActions(invalid))
  for (const path of ['/mikka/assets/../private.js', '/mikka/assets/a%2fb.js', 'https://foreign.example/mikka/assets/app.js', '/mikka/renderer-manifest.json?override=1']) {
    assert.equal(requestAllowed(path, {}, environment), false)
  }
})

test('Vite discovery follows the production deployment pin to the same published read manifest', async () => {
  const pin = '370cc898-local-prebuilt-1'
  const manifestPath = '/mikka/renderer-manifest.json?dpl=' + pin
  const calls = []
  const discovered = await discoverReadActions(async path => {
    calls.push(path)
    assert.equal(requestAllowed(path, {}, environment), true, path)
    return path === manifestPath ? Response.json(manifest)
      : new Response('<script type="module" crossorigin src="/mikka/assets/renderer-realbuild.js?dpl=' + pin + '"></script>')
  }, environment, id(1))
  assert.deepEqual(discovered.refs, readRpcActions)
  assert.equal(discovered.diagnostics.transport, 'rpc')
  assert.equal(discovered.diagnostics.manifestsRead, 1)
  assert.deepEqual(calls, ['/mikka', '/mikka?issue=' + id(1), '/mikka/settings?section=preferences', manifestPath])
  assert.equal(Object.hasOwn(discovered.refs, 'sendCoordinatorMessage'), false)
})

test('Vite asset and manifest queries accept only one valid public deployment pin', () => {
  for (const path of ['/mikka/assets/renderer-realbuild.js', '/mikka/renderer-manifest.json']) {
    for (const query of ['', '?dpl=370cc898-local-prebuilt-1'])
      assert.equal(requestAllowed(path + query, {}, environment), true, path + query)
    for (const query of ['?other=1', '?dpl=', '?dpl=bad%2Fpath', '?dpl=' + 'a'.repeat(33),
      '?dpl=first&dpl=second', '?dpl=valid&other=1', '?dpl=bad%2Fpath', '?dpl=bad%20value', '?dpl=valid#fragment'])
      assert.equal(requestAllowed(path + query, {}, environment), false, path + query)
    assert.equal(requestAllowed('https://foreign.example' + path + '?dpl=valid', {}, environment), false)
    assert.equal(requestAllowed(path + '?dpl=valid', { method: 'POST' }, environment), false)
  }
  const { path, init } = rpcReadRequest('pollIssue', [id(1)], environment, readRpcActions)
  assert.equal(requestAllowed(path + '?dpl=valid', init, environment, readRpcActions), false)
})

test('Vite discovery rejects invalid or conflicting pins before fetching an action manifest', async () => {
  const script = query => '<script type="module" src="/mikka/assets/renderer-realbuild.js' + query + '"></script>'
  for (const html of [
    script('?dpl='), script('?dpl=bad%2Fpath'), script('?dpl=first&amp;dpl=second'),
    script('?dpl=valid&amp;other=1'), script('?dpl=' + 'a'.repeat(33)),
    script('?dpl=first') + script('?dpl=second'), script('') + script('?dpl=valid'),
  ]) {
    const calls = []
    await assert.rejects(discoverReadActions(async path => {
      calls.push(path)
      assert.ok(!path.includes('renderer-manifest.json'))
      return new Response(html)
    }, environment), { code: 'read_action_reference_missing' })
    assert.deepEqual(calls, ['/mikka', '/mikka/settings?section=preferences'])
  }
  let pages = 0
  await assert.rejects(discoverReadActions(async path => {
    assert.ok(!path.includes('renderer-manifest.json'))
    return new Response(script('?dpl=page' + ++pages))
  }, environment), { code: 'read_action_reference_missing' })
  assert.equal(pages, 2)
})

test('only the exact published RPC read with the real same-origin protocol is allowed', () => {
  const { path, init } = rpcReadRequest('pollIssue', [id(1)], environment, readRpcActions)
  assert.equal(requestAllowed(path, init, environment, readRpcActions), true)
  assert.equal(requestAllowed(path, init, environment, {}), false)
  for (const changed of [
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.deleteIssue', args: [id(1)] }) },
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.pollIssue', args: [], owner: id(1) }) },
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.pollIssue', args: {} }) },
    ...['origin', 'x-mikka-rpc', 'content-type', 'accept'].map(name => ({ ...init, headers: { ...init.headers, [name]: 'wrong' } })),
    ...['authorization', 'cookie', 'host', 'x-mikka-session-cache', 'x-mikka-session-token', 'next-action'].map(name => ({ ...init, headers: { ...init.headers, [name]: 'private' } })),
  ]) assert.equal(requestAllowed(path, changed, environment, readRpcActions), false)
  assert.equal(requestAllowed(path + '?override=1', init, environment, readRpcActions), false)
  assert.throws(() => rpcReadRequest('sendCoordinatorMessage', [], environment, readRpcActions))
})

test('RPC read accounting waits for actual JSON and rejects protocol errors without retaining private content', async () => {
  const complete = Promise.withResolvers(), records = []
  let payload = { version: 1, ok: true, result: { issue: { text: 'private fixture content', at: { $mikka: 'date', value: '2026-11-05T00:00:00.000Z' } } } }
  let calls = 0
  const client = createReadClient({ request: async (path, init) => {
    calls++
    assert.equal(path, '/mikka/api/rpc')
    assert.equal(init.headers.origin, environment.origin)
    assert.deepEqual(JSON.parse(init.body), { version: 1, action: 'issues.pollIssue', args: [id(1)] })
    await complete.promise
    return Response.json(payload)
  } }, environment, 'owner', records, readRpcActions)
  const reading = client.action('pollIssue', [id(1)], 'task-detail', 'cold')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.length, 0)
  complete.resolve()
  const result = await reading
  assert.equal(result.issue.at.toISOString(), '2026-11-05T00:00:00.000Z')
  assert.equal(records[0].httpBytes, Buffer.byteLength(JSON.stringify(payload)))
  assert.equal(records[0].jsonBytes, Buffer.byteLength(JSON.stringify(result)))
  assert.doesNotMatch(JSON.stringify(records), /private fixture/)
  for (payload of [{ ok: true, result: [] }, { version: 1, ok: true }, { version: 1, ok: false, error: { code: 'private' } }]) {
    await assert.rejects(client.action('pollIssue', [id(1)], 'task-detail', 'cold'), { code: 'read_action_response_invalid' })
  }
  assert.equal(records.length, 1)
  assert.equal(calls, 4)
})

test('response observation identifies browser RPC only by its actual request envelope', () => {
  const request = { method: () => 'POST', headers: () => ({ 'x-mikka-rpc': '1' }), postDataJSON: () => ({ version: 1, action: 'issues.pollIssue', args: [] }) }
  assert.deepEqual(observedAction(request, '/mikka/api/rpc', '/mikka', new Map()), { kind: 'rpc', action: 'issues.pollIssue' })
  assert.equal(observedAction({ ...request, headers: () => ({}) }, '/mikka/api/rpc', '/mikka', new Map()), null)
  assert.equal(observedAction({ ...request, postDataJSON: () => ({ action: 'issues.pollIssue' }) }, '/mikka/api/rpc', '/mikka', new Map()), null)
  assert.equal(observedAction(request, '/mikka/api/rpc?other', '/mikka', new Map()), null)
})

test('discovery before selecting an existing task uses only the main and settings pages and still requires every read action', async () => {
  const pages = []
  const found = await discoverReadActions(async path => {
    if (path.endsWith('/renderer-manifest.json')) return Response.json(manifest)
    pages.push(path)
    return new Response(page)
  }, environment)
  assert.deepEqual(pages, ['/mikka', '/mikka/settings?section=preferences'])
  assert.deepEqual(found.refs, refs)
  await assert.rejects(discoverReadActions(async () => new Response('<html></html>'), environment), { code: 'read_action_reference_missing' })
})

test('transport rejects writes before request and reports only byte counts and trace IDs', async () => {
  let calls = 0
  const records = [], privateText = 'sensitive fixture text must stay in memory'
  const client = createReadClient({ request: async (path, init) => {
    assert.equal(path, '/mikka/api/rpc')
    calls++
    assert.match(init.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    return Response.json({ version: 1, ok: true, result: { issue: { text: privateText } } })
  } }, environment, 'owner', records, refs)
  await assert.rejects(client.request('/mikka/api/coordinator/messages', { method: 'POST', body: '{}' }), { code: 'business_request_forbidden' })
  assert.throws(() => client.action('sendCoordinatorMessage', ['hello'], 'chat', 'bad'), { code: 'read_action_forbidden' })
  assert.equal(calls, 0)
  assert.equal((await client.action('pollIssue', [id(1)], 'task-detail', 'cold')).issue.text, privateText)
  assert.equal(calls, 1)
  assert.equal(records[0].httpStatus, 200)
  assert.ok(records[0].httpBytes > records[0].jsonBytes)
  assert.equal(JSON.stringify(records).includes(privateText), false)
  assert.deepEqual(publicFailure(new Error(privateText)), { status: 'fail', code: 'read_cache_acceptance_failed' })
  assert.deepEqual(publicFailure(new ReadCacheAcceptanceError('read_action_forbidden')), { status: 'fail', code: 'read_action_forbidden' })
})

test('the HTTP scenario exercises real cursor arguments, account isolation, deltas and deletion without a write action', async () => {
  const calls = [], issueIds = [id(1), id(2), id(3)], runIds = [id(4), id(5), id(6)], botId = id(7)
  const version = 'a'.repeat(32), changed = 'b'.repeat(32)
  const positions = ids => ids.map(value => ({ id: value, version }))
  let phase = 'cold'
  const fixture = { issueIds, runIds, botId, change: async () => { phase = 'changed' }, remove: async () => { phase = 'removed' } }
  const client = actor => ({
    json: async path => { assert.equal(path, '/mikka/api/settings/issue-prefix'); return { suggested: 'TEST', teamKeys: [] } },
    action: async (name, args, surface, scenario) => {
      calls.push({ name, args, actor, surface, scenario })
      assert.ok(READ_ACTIONS.includes(name))
      const sent = JSON.parse(rpcReadRequest(name, args, environment, readRpcActions).init.body)
      assert.deepEqual(desktopActionSchemas[sent.action].parse(decode(sent.args)), args)
      if (name === 'syncCoordinatorChat' && scenario === 'reload-restored') assert.equal(args[1], undefined)
      if (actor === 'peer') {
        if (name === 'syncCoordinatorChat') return { error: 'botNotFound' }
        if (name === 'pollIssue') return { error: 'issueNotFound' }
        return { snapshot: { version: changed, items: [], positions: [] } }
      }
      if (name === 'syncCoordinatorChat') {
        assert.equal(args[0], botId)
        if (phase === 'removed') return { chat: { version: changed, items: [{ position: 2 }, { position: 13 }] } }
        if (phase === 'changed') return { chat: { version: changed, after: 12, items: [{ position: 13 }] } }
        if (args.length === 1) return { chat: { version, items: Array.from({ length: 12 }, (_, index) => ({ position: index + 1 })), continuation: { after: 12, cursor: 12, prefix: version } } }
        assert.deepEqual(args[2], { after: 12, cursor: 12, prefix: version, sourceIds: [], artifactIds: [] })
        return { chat: args[1] === undefined ? { after: 12, items: [] } : { unchanged: true } }
      }
      if (name === 'pollIssue') {
        if (phase === 'removed') return { error: 'issueNotFound' }
        if (phase === 'changed') return { version: changed, issue: { title: 'Read cache changed' } }
        return args.length === 1 ? { version, issue: { content: { type: 'doc' } } } : { unchanged: true, version }
      }
      if (name === 'loadEarlierIssueActivity') {
        assert.deepEqual(args, [issueIds[0], 3, id(10)])
        return { page: { items: [], hasMore: false, predecessor: null, cursor: null } }
      }
      if (name === 'pollIssueActivityPage') {
        if (phase === 'removed') return { error: 'issueNotFound' }
        if (phase === 'changed') return { snapshot: { version: changed, hasMore: false, predecessor: null, items: [id(8), id(9), id(10), id(11)].map((value, index) => ({ id: value, revision: index + 1 })) } }
        if (args.length === 1) return { snapshot: { version, hasMore: false, predecessor: null, items: [id(8), id(9), id(10)].map((value, index) => ({ id: value, revision: index + 1 })) } }
        assert.equal(args[1], version)
        return { snapshot: { unchanged: true, version } }
      }
      const ids = name === 'syncIssueList' ? issueIds : name === 'syncThreadList' ? runIds : [id(8), id(9), id(10)]
      if (phase === 'removed') return { snapshot: { delta: true, items: [], positions: positions(ids.slice(1)), version: changed } }
      if (phase === 'changed') return { snapshot: { delta: true, items: [{ id: ids[0] }], positions: positions(ids), version: changed } }
      const cold = args.length === 0
      if (!cold) {
        assert.equal(args[0], version)
        assert.deepEqual(args.at(-1), positions(ids))
      }
      return { snapshot: cold ? { version, items: ids.map(value => ({ id: value })), positions: positions(ids) } : { unchanged: true, version } }
    },
  })
  await exerciseReadCases({ owner: client('owner'), peer: client('peer'), fixture, environment })
  assert.equal(phase, 'removed')
  for (const scenario of ['cold', 'warm', 'reload-restored', 'peer-denied', 'peer-isolation', 'one-row-delta', 'deleted']) assert.ok(calls.some(call => call.scenario === scenario), scenario)
  assert.ok(calls.some(call => call.name === 'pollIssueActivityPage' && call.scenario === 'deleted'))
})
