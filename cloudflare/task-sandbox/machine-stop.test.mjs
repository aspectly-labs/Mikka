import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { machineGrant } from './grant.mjs'

test('parking a native writer prunes archives once, after persisting its stop and releasing compute', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskMachine
  try { ({ TaskMachine } = await import('./machine.mjs')) } finally { hooks.deregister() }

  const grant = machineGrant({ ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    operationId: randomUUID(), repositoryKey: 'v2/github.com/owner/repo', expiresAt: Date.now() + 60_000 })
  const data = new Map([['nativeWriter', 'writer'], ['run', { grant, admittedAt: Date.now(), state: 'running' }]])
  const checkpoint = { id: randomUUID(), sha256: 'a'.repeat(64), bytes: 3 }
  const events = []
  const container = {
    running: true, async exec() { events.push('quiesce'); return { async output() { return { exitCode: 0 } } } },
    async destroy() { events.push('destroy'); this.running = false },
  }
  const machine = Object.assign(Object.create(TaskMachine.prototype), {
    queue: Promise.resolve(), ctx: { id: 'instance', container, storage: {
      async get(key) { return data.get(key) }, async delete(key) { return data.delete(key) },
      async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key,value]] : Object.entries(key)) data.set(k, v) },
      async setAlarm() {}, async deleteAlarm() {}, async list() { return new Map() },
    } }, env: {
      TASKS: { idFromName() { return 'instance' } },
      CAPACITY: { getByName() { return { async release() { events.push('release') } } } },
    }, workspace: {
      async checkpoint() { events.push('backup'); return checkpoint },
      async prune() {
        events.push('prune')
        assert.equal(data.get('run').state, 'stopped', 'archive maintenance must not block machine retirement')
      },
    },
  })
  const result = await machine.park(grant)
  assert.deepEqual(result.checkpoint, checkpoint)
  assert.equal(result.state, 'stopped')
  assert.deepEqual(events, ['quiesce', 'backup', 'destroy', 'release', 'prune'])

  const abandoned = { ...grant, operationId: randomUUID(), expiresAt: 0, metered: true }
  assert.deepEqual(await machine.park(abandoned), { state: 'absent' })
  assert.deepEqual(await machine.meter(abandoned, 0, false), { notStarted: true })
  assert.equal(data.get('closed-operation:' + abandoned.operationId), true)
  assert.equal(data.get('run').grant.operationId, grant.operationId)
})

test('the machine starts the billed instance type its grant carries, defaulting to standard-3', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskMachine
  try { ({ TaskMachine } = await import('./machine.mjs')) } finally { hooks.deregister() }

  const started = []
  const container = {
    running: true,
    images: { task: 'image-ref' },
    start(options) { started.push(options) },
    monitor() { return new Promise(() => {}) },
    async setInactivityTimeout() {},
  }
  const machine = Object.assign(Object.create(TaskMachine.prototype), { ctx: { container }, env: {} })
  const run = size => ({ grant: size === undefined ? {} : { size }, expiresAt: Date.now() + 60_000 })
  await machine.startImage(run('standard-4'))
  assert.equal(started[0].instance, 'standard-4')
  await machine.startImage(run('standard-4-16'))
  assert.equal(started[1].instance, 'standard-4-16', 'a grant minted after verified quota passes its size through')
  await machine.startImage(run())
  assert.equal(started[2].instance, 'standard-3', 'grants without a size keep the default')
})

test('an expired lease stops the machine: checkpoint, destroy, capacity release, alarm cleared', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskMachine
  try { ({ TaskMachine } = await import('./machine.mjs')) } finally { hooks.deregister() }

  const grant = machineGrant({ ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    operationId: randomUUID(), repositoryKey: 'v2/github.com/owner/repo', expiresAt: Date.now() - 1 })
  const data = new Map([['run', { grant, admittedAt: Date.now() - 300_000, state: 'running', expiresAt: grant.expiresAt }]])
  const events = []
  const container = { running: true, async destroy() { events.push('destroy'); this.running = false } }
  const machine = Object.assign(Object.create(TaskMachine.prototype), {
    queue: Promise.resolve(), ctx: { id: 'instance', container, storage: {
      async get(key) { return data.get(key) }, async delete(key) { return data.delete(key) },
      async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key,value]] : Object.entries(key)) data.set(k, v) },
      async setAlarm() { events.push('rearm') }, async deleteAlarm() { events.push('dealarm') }, async list() { return new Map() },
    } }, env: {
      TASKS: { idFromName() { return 'instance' } },
      CAPACITY: { getByName() { return { async release() { events.push('release') } } } },
    }, workspace: {
      async checkpoint() { events.push('backup'); return { id: randomUUID(), bytes: 3, sha256: 'a'.repeat(64) } },
      async prune() { events.push('prune') },
    },
  })
  await machine.alarm()
  const stopped = data.get('run')
  assert.equal(stopped.outcome, 'deadline')
  assert.equal(stopped.state, 'stopped')
  assert.ok(stopped.stoppedAt)
  assert.equal(data.get('closed-operation:' + grant.operationId), true, 'the operation fence commits with the stop')
  assert.deepEqual(events, ['rearm', 'backup', 'destroy', 'release', 'prune', 'dealarm'],
    'a deadline stop re-arms the alarm during cleanup, saves, destroys and releases before clearing it')
})

test('a live lease only re-arms its alarm; a settled lease still stops through the alarm', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskMachine
  try { ({ TaskMachine } = await import('./machine.mjs')) } finally { hooks.deregister() }

  const grant = machineGrant({ ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    operationId: randomUUID(), repositoryKey: 'v2/github.com/owner/repo', expiresAt: Date.now() + 300_000 })
  const fixture = run => {
    const data = new Map([['run', run]])
    const events = []
    const alarmAt = []
    return { data, events, alarmAt, machine: Object.assign(Object.create(TaskMachine.prototype), {
      queue: Promise.resolve(), ctx: { id: 'instance', container: { running: true, async destroy() { events.push('destroy'); this.running = false } }, storage: {
        async get(key) { return data.get(key) }, async delete(key) { return data.delete(key) },
        async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key,value]] : Object.entries(key)) data.set(k, v) },
        async setAlarm(at) { alarmAt.push(at) }, async deleteAlarm() { events.push('dealarm') }, async list() { return new Map() },
      } }, env: {
        TASKS: { idFromName() { return 'instance' } },
        CAPACITY: { getByName() { return { async release() { events.push('release') } } } },
      }, workspace: {
        async checkpoint() { events.push('backup'); return { id: randomUUID(), bytes: 3, sha256: 'a'.repeat(64) } },
        async prune() { events.push('prune') },
      },
    }) }
  }

  const live = fixture({ grant, state: 'running', expiresAt: grant.expiresAt })
  assert.equal(await live.machine.alarm(), undefined)
  assert.deepEqual(live.events, [], 'a live run keeps compute and touches nothing')
  assert.deepEqual(live.alarmAt, [grant.expiresAt], 'the alarm re-arms at the paid deadline')

  const settled = fixture({ grant, state: 'running', expiresAt: grant.expiresAt, settledAt: Date.now(), outcome: 'settled' })
  await settled.machine.alarm()
  assert.equal(settled.data.get('run').state, 'stopped')
  assert.equal(settled.data.get('run').outcome, 'settled', 'the recorded outcome survives the backstop alarm')
  assert.ok(settled.events.includes('destroy') && settled.events.includes('release'),
    'a lease already settling still releases its compute')
})

test('an uncommitted first checkpoint is reclaimed without removing a committed checkpoint or other files', async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@cloudflare/sandbox') return {
      shortCircuit: true, url: 'data:text/javascript,export class DirectoryBackup {}',
    }
    return next(specifier, context)
  } })
  let TaskWorkspace
  try { ({ TaskWorkspace } = await import('./workspace.mjs')) } finally { hooks.deregister() }

  const prefix = 'task-workspaces/v1/this-task/'
  const id = randomUUID()
  const orphan = prefix + id + '.tar.zst'
  const otherTask = 'task-workspaces/v1/other-task/' + id + '.tar.zst'
  const note = prefix + 'other-format'
  const objects = new Set([otherTask, note])
  let manifest
  const workspace = Object.assign(Object.create(TaskWorkspace.prototype), {
    prefix,
    storage: {
      get() { return manifest },
      put() { throw Error('manifest write interrupted') },
    },
    backups: { async backup() {
      objects.add(orphan)
      return { id, size: 3, sha256: 'a'.repeat(64) }
    } },
    bucket: {
      async list({ prefix }) {
        return { objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }
      },
      async delete(keys) { for (const key of keys) objects.delete(key) },
    },
  })
  await assert.rejects(workspace.checkpoint(), /manifest write interrupted/)
  assert.equal(await workspace.restore(), false)
  await workspace.prune()
  assert.deepEqual(objects, new Set([otherTask, note]))

  manifest = { id: randomUUID(), size: 3, sha256: 'b'.repeat(64) }
  const committed = prefix + manifest.id + '.tar.zst'
  objects.add(committed)
  objects.add(orphan)
  await workspace.prune()
  await workspace.prune()
  assert.deepEqual(objects, new Set([otherTask, note, committed]))
})

test('each workspace runs up to WORKSPACE_MACHINES machines at once, with no platform-wide cap', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskCapacity, TaskMachine, WORKSPACE_MACHINES
  try { ({ TaskCapacity, TaskMachine } = await import('./machine.mjs')); ({ WORKSPACE_MACHINES } = await import('./grant.mjs')) } finally { hooks.deregister() }
  assert.equal(WORKSPACE_MACHINES, 25)
  const objects = new Map()
  const capacity = name => {
    if (!objects.has(name)) {
      const data = new Map()
      const storage = { async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))) },
        async put(key, value) { data.set(key, value) }, async delete(key) { return data.delete(key) } }
      objects.set(name, Object.assign(Object.create(TaskCapacity.prototype), { ctx: { storage: { ...storage, transaction: operation => operation(storage) } } }))
    }
    return objects.get(name)
  }
  const machine = Object.assign(Object.create(TaskMachine.prototype), { env: { CAPACITY: { getByName: capacity } } })
  const [one, two] = [randomUUID(), randomUUID()]
  for (let i = 0; i < WORKSPACE_MACHINES; i++) assert.equal(await machine.admission({ workspaceId: one }).acquire('m' + i), true)
  assert.equal(await machine.admission({ workspaceId: one }).acquire('extra'), false)
  assert.equal(await machine.admission({ workspaceId: two }).acquire('other'), true, 'another workspace has its own machines')
  await machine.admission({ workspaceId: one }).release('m0')
  assert.equal(await machine.admission({ workspaceId: one }).acquire('extra'), true)
})
