import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { startDaemon, DAEMON_VERSION } from '../../packages/daemon/src/main'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http'
import { installCloudCredential } from '../../packages/daemon/src/cloud-bootstrap'

const origin = new URL(process.env.MIKKA_TEST_REGISTER_URL ?? '')
const dataDir = process.env.MIKKA_TEST_DATA_DIR ?? ''
assert.equal(origin.hostname, '127.0.0.1')
assert.ok(isAbsolute(dataDir))
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())
const bootstrap = typeof input.bootstrap === 'string' ? JSON.parse(input.bootstrap) : input
assert.equal(typeof bootstrap.credential, 'string')
await installCloudCredential(dataDir, { ...bootstrap, server: origin.href })

const daemon = await startDaemon({
  dataDir, flavor: 'dev', credential: bootstrap.credential,
  link: new HttpServerLink(origin.href, fetch, DAEMON_VERSION),
  // Registration validates the executable path. This fixture never starts a model CLI.
  harnessBinaries: { codex: process.execPath },
  hostedSubscriptions: true, retainResources: true, modelProbe: false, quotaSource: null,
})
try {
  await daemon.syncWithServer()
  assert.equal(daemon.status().deviceId, bootstrap.deviceId)
  process.stdout.write('mikka-task-worker-registered\n')
} finally {
  await daemon.stop()
}
