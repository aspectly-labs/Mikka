import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { digest, makeSnapshot } from '@/lib/agent-kit/definition'
import { withReadbackBinding, withWritePolicy } from './policy-authorization'
import type { OperationIntent } from './ledger'

function fixture() {
 const run = randomUUID(), bot = randomUUID(), workspace = randomUUID(), id = randomUUID()
 const binding: OperationIntent = { operationId: id, ownerId: 'owner', workspaceId: 'personal:owner', provider: 'fixture', accountId: 'account', action: 'send_slack_message', target: 'target', approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64), executionRunId: run, policyScope: { botId: bot, workspaceId: workspace, version: '1' } }
 const revision = randomUUID()
 const definition = { ...DEFAULT_AGENT_DEFINITION, tools: ['send_slack_message'] as typeof DEFAULT_AGENT_DEFINITION.tools }
 const snapshot = makeSnapshot(revision, 1, definition, 'host', { harness:'ai_sdk', model:'openai/gpt-6-luna' })
 const state = { choice: 'allow', version: '1', status: 'running', bindingChecks: 0 }
 const tx = { query: async (sql: string) => sql.includes('pg_advisory_xact_lock') ? { rows: [] } : sql.includes('workspace_computer_policies') ? { rows: [{ external_write_permissions: { send_slack_message: state.choice }, external_write_policy_version: state.version }] } : sql.includes('agent_kit_heads') ? { rows: [{ workspace_id: workspace, active_version: revision }] } : sql.includes('agent_kit_executions') ? { rows: [{ status: state.status, version_id: revision, snapshot }] } : { rows: [{ definition, digest:digest(definition) }] } } as unknown as Parameters<ReturnType<typeof withWritePolicy>>[0]
 const authorize = withWritePolicy(async (_tx, b) => { state.bindingChecks++; if (b.accountId !== 'account' || b.target !== 'target') throw Error('binding changed') })
 const readback = withReadbackBinding(async (_tx, b) => { state.bindingChecks++; if (b.accountId !== 'account' || b.target !== 'target') throw Error('binding changed') })
 return { run, binding, state, tx, authorize, readback }
}
test('there is no approval step: allow and an old stored ask run, deny blocks', async () => {
 const f = fixture()
 await f.authorize(f.tx, f.binding, f.run, 'invoke'); assert.equal(f.state.bindingChecks, 1)
 f.state.choice = 'ask'; await f.authorize(f.tx, f.binding, f.run, 'invoke'); assert.equal(f.state.bindingChecks, 2)
 f.state.choice = 'deny'; await assert.rejects(f.authorize(f.tx, f.binding, f.run, 'invoke'), /writeDenied/)
})
test('revocation, changed binding and wrong run cannot pass invocation', async () => {
 const f = fixture(); f.state.version = '2'
 await assert.rejects(f.authorize(f.tx, f.binding, f.run, 'invoke'), /writePolicyChanged/)
 f.state.version = '1'
 await assert.rejects(f.authorize(f.tx, { ...f.binding, accountId: 'other' }, f.run, 'invoke'), /binding changed/)
 await assert.rejects(f.authorize(f.tx, f.binding, randomUUID(), 'invoke'), /writePolicyUnavailable/)
})

test('an ended run authorizes nothing, not even a readback', async () => {
 for (const status of ['failed', 'completed']) {
  const f = fixture(); f.state.status = status
  for (const phase of ['read', 'reconcile', 'reserve', 'claim', 'invoke', 'settle'] as const) await assert.rejects(f.authorize(f.tx, f.binding, f.run, phase), /writeRunUnavailable/)
 }
})

test('readback reads and reconciles an ended run under any policy version, and can never send', async () => {
 for (const status of ['running', 'failed', 'completed']) {
  const f = fixture(); f.state.status = status; f.state.version = '9'; f.state.choice = 'deny'
  for (const phase of ['read', 'reconcile'] as const) await f.readback(f.tx, f.binding, f.run, phase)
  for (const phase of ['reserve', 'claim', 'invoke', 'settle'] as const) await assert.rejects(f.readback(f.tx, f.binding, f.run, phase), /operationReadbackOnly/)
  await assert.rejects(f.readback(f.tx, { ...f.binding, accountId: 'other' }, f.run, 'read'), /binding changed/)
  await assert.rejects(f.readback(f.tx, f.binding, randomUUID(), 'reconcile'), /writePolicyUnavailable/)
 }
})
