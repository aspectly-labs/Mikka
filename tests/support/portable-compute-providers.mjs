import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { newWebSocketRpcSession, RpcTarget } from 'capnweb'
import { WebSocketServer } from 'ws'
import { bodyBytes, bodyJson, json } from '../fakes/http.mjs'
import { startExternalServices } from '../fakes/external-services.mjs'
import { portableComputeGuest } from './portable-compute-guest.mjs'

const e2bDirectory = '/home/user/.mikka/worker'
const cfDirectory = '/workspace'
const isId = value => /^[0-9a-f-]{36}$/.test(value ?? '')

export async function startPortableComputeProviders(t, options) {
  const map = { e2b: new Map(), cloudflare: new Map() }
  const objects = new Map(), cloudflare = [], boots = []
  const fail = { cloudflare: false }
  const guest = (provider, id) => {
    const previous = map[provider].get(id)
    if (previous) return previous
    assert.match(id, /^[a-z0-9-]+$/)
    const created = portableComputeGuest(join(options.root, provider, id), provider === 'e2b' ? e2bDirectory : cfDirectory)
    map[provider].set(id, created)
    return created
  }
  const startE2b = async (sandbox, sourcePath, runId) => {
    const vm = guest('e2b', sandbox.id)
    const data = sandbox.files.get(sourcePath)
    assert.ok(data)
    const archive = e2bDirectory + '/portable-workspaces/' + runId + '.tar.zst'
    const bytes = sandbox.files.get(archive)
    if (bytes) await vm.write(archive, bytes)
    await options.registerE2B(vm, runId, data)
    boots.push({ provider: 'e2b', runId })
  }
  const e2b = await startExternalServices({ e2b: {
    templates: ['codex-fixture'],
    geometry: { cpuCount: 2, memoryMB: 8192 },
    initialFiles: { '/opt/mikka/worker-source-sha': options.workerSha },
    async commands(command, { sandbox }) {
      const vm = guest('e2b', sandbox.id)
      if (!sandbox.files.has('/opt/mikka/worker-source-sha'))
        sandbox.files.set('/opt/mikka/worker-source-sha', Buffer.from(options.workerSha))
      if (command.startsWith('exec /opt/mikka/runtime/node/bin/node ') && command.includes('brokerSha256')) {
        const runId = /"runId":"([a-f0-9-]{36})"/.exec(command)?.[1]
        const leaseId = /"leaseId":"([a-f0-9-]{36})"/.exec(command)?.[1]
        assert.ok(runId && leaseId)
        return { exitCode: 0, stdout: 'mikka-worker-broker-attestation ' + JSON.stringify({
          version: 1, runId, leaseId, sourceSha: options.workerSha, broker: false,
        }) + '\n' }
      }
      if (command.startsWith('env -i ')) {
        const path = /\/tmp\/mikka-task-workspace-[\w-]+\.tar\.zst/.exec(command)?.[0]
        const runId = /\/worktrees\/([\w-]+) \/tmp/.exec(command)?.[1]
        assert.ok(path && isId(runId))
        const receipt = await vm.capture(runId, path)
        sandbox.files.set(path, await vm.read(path))
        return { stdout: JSON.stringify(receipt), exitCode: 0 }
      }
      if (command.startsWith('install -d -m 700 ') && command.includes('test ! -L')) {
        const source = /\/tmp\/mikka-task-workspace-[\w-]+\.tar\.zst/.exec(command)?.[0]
        const sealed = /\/run\/mikka-task-archives\/[\w-]+\.tar\.zst/.exec(command)?.[0]
        assert.ok(source && sealed && sandbox.files.has(source))
        sandbox.files.set(sealed, sandbox.files.get(source))
        sandbox.files.delete(source)
        return { exitCode: 0 }
      }
      if (command.startsWith('umask 077; cat -- ')) {
        const scratch = /cat -- '([^']+)'\/\*\.part/.exec(command)?.[1]
        const destination = /mv -- '[^']+' '([^']+)'/.exec(command)?.[1]
        assert.ok(scratch && destination)
        const parts = [...sandbox.files.entries()].filter(([key]) => key.startsWith(scratch + '/') && key.endsWith('.part'))
        assert.ok(parts.length)
        sandbox.files.set(destination, Buffer.concat(parts.sort(([a], [b]) => a.localeCompare(b)).map(([, bytes]) => bytes)))
        return { exitCode: 0 }
      }
      if (command.includes('/home/user/.mikka/bootstrap.next')) {
        const handoff = /\/run\/mikka-viewer\/thread-[\w-]+\.json/.exec(command)?.[0]
        assert.ok(handoff)
        const runId = JSON.parse(sandbox.files.get(handoff + '.run')).runId
        assert.ok(isId(runId))
        await startE2b(sandbox, handoff, runId)
        return { exitCode: 0, stdout: options.e2bRegisteredMessage }
      }
      if (command.startsWith('rm -f -- ')) {
        for (const path of command.slice('rm -f -- '.length).split(' ')) sandbox.files.delete(path)
        return { exitCode: 0 }
      }
      // Only directories owned by the negotiated archive staging flow.
      if (command.startsWith('install -d -m 700 ') || command.startsWith('rm -rf -- ')) return { exitCode: 0 }
      return { exitCode: 127 }
    },
  } })
  t.after(() => e2b.close())
  const e2bCreate = e2b.e2b.state
  const instances = new Map()
  const archives = new Map()
  const cloudToken = 'portable-fixture-internal'
  const instance = grant => {
    const value = instances.get(grant.operationId)
    if (!value || value.runId !== grant.runId) throw new Error('Wrong Cloudflare fixture operation')
    return value
  }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (path.startsWith('/fixture-archives/')) {
        if (request.method === 'PUT') {
          assert.equal(request.headers['if-none-match'], '*')
          if (objects.has(path)) { response.writeHead(412).end(); return }
          objects.set(path, await bodyBytes(request)); response.writeHead(200).end(); return
        }
        if (request.method === 'GET') {
          const object = objects.get(path)
          response.writeHead(object ? 200 : 404).end(object); return
        }
        if (request.method === 'DELETE') { response.writeHead(objects.delete(path) ? 204 : 404).end(); return }
      }
      assert.equal(request.headers.authorization, 'Bearer ' + cloudToken)
      cloudflare.push(path)
      if (path === '/v1/stage-portable-archive') {
        const grant = JSON.parse(Buffer.from(request.headers['x-mikka-task-grant'], 'base64').toString())
        const bytes = await bodyBytes(request), receipt = grant.portableWorkspace
        assert.equal(receipt.size, bytes.byteLength)
        assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'))
        await instance(grant).vm.write(cfDirectory + '/portable-workspaces/' + grant.runId + '.tar.zst', bytes)
        return json(response, receipt)
      }
      const { grant, operation, id, index } = await bodyJson(request)
      if (path === '/v1/open') {
        if (fail.cloudflare) return json(response, { error: 'capacity_unavailable' }, 503)
        if (!instances.has(grant.operationId)) {
          const instanceId = createHash('sha256').update(grant.operationId).digest('hex')
          instances.set(grant.operationId, { instanceId, runId: grant.runId, vm: guest('cloudflare', instanceId), state: 'running' })
        }
        return json(response, { state: 'running', instanceId: instance(grant).instanceId })
      }
      if (path === '/v1/compute-meter') {
        if (!instances.has(grant.operationId)) return json(response, { notStarted: true })
        instance(grant)
        return json(response, { index: index ?? 0, provisionedMs: 300_000, activeVcpuMs: 200_000, observedAt: Date.now() })
      }
      if (['/v1/status', '/v1/park'].includes(path) && !instances.has(grant.operationId)) return json(response, { state: 'absent' })
      const vm = instance(grant)
      if (path === '/v1/portable-archive' && isId(id)) {
        const temporary = '/tmp/' + id + '.tar.zst'
        if (operation === 'capture') {
          const receipt = await vm.vm.capture(grant.runId, temporary)
          archives.set(id, grant.operationId)
          return json(response, receipt)
        }
        assert.equal(archives.get(id), grant.operationId)
        if (operation === 'read') {
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          return await pipeline(Readable.fromWeb(vm.vm.stream(temporary)), response)
        }
        if (operation === 'delete') {
          archives.delete(id); await vm.vm.remove(temporary)
          return json(response, {})
        }
      }
      if (path === '/v1/park' || path === '/v1/status') {
        if (path === '/v1/park') vm.state = 'stopped'
        return json(response, { state: vm.state, instanceId: vm.instanceId, stoppedAt: new Date().toISOString(), outcome: 'settled' })
      }
      return json(response, { error: 'unexpected_fixture_operation' }, 404)
    } catch (error) {
      if (process.env.MIKKA_PORTABLE_FIXTURE_DEBUG) console.error(error)
      if (!response.headersSent) json(response, { error: 'invalid_fixture_operation' }, 400)
      else response.destroy()
    }
  })
  const socketServer = new WebSocketServer({ noServer: true })
  class Handle extends RpcTarget {
    constructor(remote) { super(); this.remote = remote }
    wait() { return this.remote.wait() }
    kill() { return this.remote.kill() }
  }
  class Session extends RpcTarget {
    async spawn(grant, config) {
      assert.ok(config.stdin)
      const vm = instance(grant).vm
      const remote = await options.spawnCloudflare(vm, grant.runId)
      const [errors, stderr] = remote.stderr.tee()
      void new Response(errors).text().then(errors => { if (process.env.MIKKA_PORTABLE_FIXTURE_DEBUG) console.error(errors) })
      boots.push({ provider: 'cloudflare', runId: grant.runId })
      return { pid: remote.pid, stdout: remote.stdout, stderr, stdin: remote.stdin, handle: new Handle(remote) }
    }
  }
  server.on('upgrade', (request, socket, bytes) => {
    if (request.url !== '/v1/process' || request.headers.authorization !== 'Bearer ' + cloudToken) { socket.destroy(); return }
    cloudflare.push('/v1/process')
    socketServer.handleUpgrade(request, socket, bytes, connection => newWebSocketRpcSession(connection, new Session()))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const previous = getGlobalDispatcher()
  const dispatcher = new Agent({ connect(options, complete) {
    if (options.hostname !== 'task-machine.internal' && options.hostname !== '127.0.0.1') {
      complete(new Error('Test rejected external HTTP'), null)
      return
    }
    const socket = createConnection({ host: '127.0.0.1', port: options.hostname === 'task-machine.internal' ? port : +options.port })
    const failure = error => complete(error, null)
    socket.once('error', failure).once('connect', () => { socket.off('error', failure); complete(null, socket) })
  } })
  setGlobalDispatcher(dispatcher)
  t.after(async () => {
    setGlobalDispatcher(previous)
    for (const socket of socketServer.clients) socket.terminate()
    await socketServer.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await dispatcher.destroy()
    await Promise.all(Object.values(map).flatMap(group => [...group.values()].map(vm => vm.close())))
  })
  return {
    cloudflare, boots, fail, e2b, guest,
    refuseE2B(status) { e2bCreate.createError = status },
    env: {
      E2B_API_KEY: e2b.e2bOptions.apiKey, E2B_API_URL: e2b.e2bOptions.apiUrl, E2B_SANDBOX_URL: e2b.e2bOptions.sandboxUrl,
      E2B_HTTP_VERSION: '1.1', MIKKA_TASK_MACHINE_BRIDGE_TOKEN: cloudToken,
      S3_ENDPOINT: 'http://127.0.0.1:' + port, S3_TASK_WORKSPACES_BUCKET: 'fixture-archives',
      S3_BUCKET: 'fixture-archives', S3_ACCESS_KEY_ID: 'fixture-id', S3_SECRET_ACCESS_KEY: 'fixture-secret',
    },
  }
}
