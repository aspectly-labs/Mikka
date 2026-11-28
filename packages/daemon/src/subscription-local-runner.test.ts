import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { cleanupTempDirs, makeRepo, tempDir } from '../test/helpers'
import { NoSandbox } from './agents/sandbox'
import { ToolApprovalGate } from './agents/tool-approval'
import { buildChildEnv } from './env'
import { createLogger } from './log'
import { createLocalSubscriptionRunner } from './subscription-local-runner'

afterEach(cleanupTempDirs)

const token = 'mkg_' + 'a'.repeat(43)
const baseUrl = 'https://mikka.test/api/model-gateway/anthropic'
const runId = 'local-subscription'

async function fixture() {
  const stateDir = join(tempDir(), 'adapters')
  const runner = createLocalSubscriptionRunner({
    stateDir, claude: { sandbox: new NoSandbox(), stateDir, binary: resolve(import.meta.dirname, '../test/fakes/fake-claude-subscription.mjs') },
    codex: { sandbox: new NoSandbox(), stateDir },
  })
  const assignment = {
    runId, deviceId: 'device-1', harness: 'claude_code', model: 'claude-test',
    subscriptionBinding: { bindingId: 'b', ownerId: 'o', workspaceId: 'w', consumerId: 'c', route: 'claude_code_cli' },
    subscriptionContext: { route: 'claude_code_cli', modelId: 'claude-test', revision: 3, accountId: 'acct-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    modelCredential: { kind: 'provider', protocol: 'anthropic', baseUrl, key: token },
  } as unknown as RunAssignment
  const options = {
    runId, cwd: await makeRepo(), prompt: 'hello', model: 'claude-test', env: buildChildEnv(),
    log: createLogger({ level: 'silent' }), toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
  }
  return { runner, assignment, options, stateDir }
}

it('routes a local subscription through the trusted gateway credential only', async () => {
  const f = await fixture()
  const previous = process.env.FIXTURE_MACHINE_AUTH
  process.env.FIXTURE_MACHINE_AUTH = '1'
  try {
    const session = await f.runner.start(f.assignment, f.options)
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
    const recorded = JSON.parse(readFileSync(join(f.stateDir, 'runs', runId, 'native-home', '.claude', 'fixture-auth.json'), 'utf8'))
    expect(recorded).toEqual({ tokenSha: createHash('sha256').update(token).digest('hex'), baseUrl })
    expect(JSON.stringify(events)).not.toContain(token)
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_MACHINE_AUTH
    else process.env.FIXTURE_MACHINE_AUTH = previous
  }
})

it.each(['missing-context', 'wrong-model', 'direct-key'] as const)('fails closed for %s without starting an official CLI', async reason => {
  const f = await fixture()
  if (reason === 'missing-context') delete f.assignment.subscriptionContext
  if (reason === 'wrong-model') f.assignment.subscriptionContext!.modelId = 'other'
  if (reason === 'direct-key') f.assignment.modelCredential!.key = 'not-a-run-gateway-token'
  await expect(f.runner.start(f.assignment, f.options)).rejects.toMatchObject({
    code: 'subscription_local_runtime_unavailable', detail: reason === 'wrong-model' ? 'model_mismatch' : 'assignment_invalid',
  })
})
