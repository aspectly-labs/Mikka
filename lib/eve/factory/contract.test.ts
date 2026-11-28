import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVE_FACTORY_CONTRACT_VERSION, EVE_FACTORY_MAX_SESSION_OPENS, eveFactoryPlanSchema,
  eveFactoryRoleForStage, eveFactoryRouteReceipt, readEveFactoryPlan, readEveFactoryRoute,
  isEveFactoryDefinition, EVE_FACTORY_EXECUTOR,
} from './contract'
import { admitEveFactoryProvider, assertEveFactoryRoleCapability } from './providers'
import { eveFactoryReportFor, eveFactoryResultFromMessages } from './evidence'
import { EVE_FACTORY_ROLE_TOOLS, eveFactorySessionAuth, eveFactoryScopeAuth } from './session'
import { FactoryError } from '../../factory/contract'

const plan = (overrides: Record<string, unknown> = {}) => ({
  version: EVE_FACTORY_CONTRACT_VERSION, role: 'implementer', provider: 'openrouter',
  model: 'openrouter/anthropic/claude-sonnet-4.5', effort: null, sessionOpens: 0,
  sessionId: null, deliveryId: null, capabilityLimitations: [], releasedWhileWaiting: true, ...overrides,
})

describe('eve factory role/stage mapping', () => {
  test('maps the four template roles onto Mikka-owned stages only', () => {
    assert.equal(eveFactoryRoleForStage('clarify'), 'classifier')
    assert.equal(eveFactoryRoleForStage('spec'), 'analyst')
    assert.equal(eveFactoryRoleForStage('execute'), 'implementer')
    assert.equal(eveFactoryRoleForStage('review'), 'reviewer')
    // verify/approval/publish/monitor remain host-owned, never an Eve role.
    assert.equal(eveFactoryRoleForStage('verify'), null)
    assert.equal(eveFactoryRoleForStage('approval'), null)
    assert.equal(eveFactoryRoleForStage('publish'), null)
    assert.equal(eveFactoryRoleForStage('monitor'), null)
  })
})

describe('provider admission', () => {
  test('missing provider refuses with the dedicated code, never a fallback', () => {
    for (const provider of ['', 'no-such-vendor', 42, null, undefined]) {
      assert.throws(() => admitEveFactoryProvider({ provider }),
        (error: unknown) => error instanceof FactoryError && error.code === 'eveFactoryProviderUnavailable')
    }
  })
  test('unregistered provider refuses', () => {
    assert.throws(() => admitEveFactoryProvider({ provider: 'anthropic-direct' }),
      (error: unknown) => error instanceof FactoryError && error.code === 'eveFactoryProviderUnavailable')
  })
  test('model outside the descriptor catalogue refuses', () => {
    assert.throws(() => admitEveFactoryProvider({ provider: 'openrouter', effort: 'extreme' }),
      (error: unknown) => error instanceof FactoryError && error.code === 'eveFactoryProviderUnavailable')
  })
  test('registered provider admits and keeps caller model/effort', () => {
    const { descriptor, model, effort } = admitEveFactoryProvider({ provider: 'openrouter', model: 'openrouter/anthropic/claude-sonnet-4.5', effort: 'high' })
    assert.equal(descriptor.id, 'openrouter')
    assert.equal(model, 'openrouter/anthropic/claude-sonnet-4.5')
    assert.equal(effort, 'high')
  })
})

describe('reviewer capability', () => {
  test('a provider without isolated principals refuses reviewer dispatch and reports the limitation', () => {
    const descriptor = { id: 'vendor-x', models: ['*'], defaultModel: 'vendor-x/model', effort: [], independentReviewer: false, workspaceWrite: true }
    assert.throws(() => assertEveFactoryRoleCapability(descriptor, 'reviewer'),
      (error: unknown) => error instanceof FactoryError && error.code === 'eveFactoryReviewerUnavailable')
    // The limitation is still reported as evidence for the other roles.
    assert.deepEqual(assertEveFactoryRoleCapability(descriptor, 'analyst'), ['independent_vendor_reviewer'])
  })
  test('a provider without workspace write refuses every role', () => {
    const descriptor = { id: 'vendor-y', models: ['*'], defaultModel: 'm', effort: [], independentReviewer: true, workspaceWrite: false }
    assert.throws(() => assertEveFactoryRoleCapability(descriptor, 'analyst'),
      (error: unknown) => error instanceof FactoryError && error.code === 'eveFactoryComputeUnavailable')
  })
})

describe('frozen plan and route receipts', () => {
  test('plan schema bounds session opens and requires releasedWhileWaiting', () => {
    assert.equal(eveFactoryPlanSchema.safeParse(plan()).success, true)
    assert.equal(eveFactoryPlanSchema.safeParse(plan({ sessionOpens: EVE_FACTORY_MAX_SESSION_OPENS + 1 })).success, false)
    assert.equal(eveFactoryPlanSchema.safeParse(plan({ releasedWhileWaiting: false })).success, false)
  })
  test('route receipt matches the #3081 cloud.eve_factory shape', () => {
    const receipt = eveFactoryRouteReceipt('openrouter')
    assert.deepEqual(receipt, { version: 1, routeId: 'cloud.eve_factory', place: 'cloud', executor: 'eve_factory', harness: null, provider: 'openrouter', declared: true })
  })
  test('readEveFactoryPlan/readEveFactoryRoute never throw on malformed output', () => {
    assert.equal(readEveFactoryPlan(null), null)
    assert.equal(readEveFactoryRoute({ executionRoute: { routeId: 'cloud.claude_code' } }), null)
    assert.equal(readEveFactoryPlan({ eveFactory: plan() })?.role, 'implementer')
  })
  test('isEveFactoryDefinition accepts only a frozen adapter definition', () => {
    assert.equal(isEveFactoryDefinition({ executor: EVE_FACTORY_EXECUTOR, provider: 'openrouter' }), true)
    assert.equal(isEveFactoryDefinition({ harness: 'claude_code' }), false)
    assert.equal(isEveFactoryDefinition({ executor: 'eve_factory' }), false)
    assert.equal(isEveFactoryDefinition(null), false)
  })
})

describe('role sessions and tool scopes', () => {
  test('analyst and reviewer get read-only toolsets; implementer may write in sandbox only', () => {
    assert.deepEqual([...EVE_FACTORY_ROLE_TOOLS.analyst].sort(), ['bash', 'glob', 'grep', 'read_file'].sort())
    assert.deepEqual([...EVE_FACTORY_ROLE_TOOLS.reviewer].sort(), ['bash', 'glob', 'grep', 'read_file'].sort())
    assert.ok(EVE_FACTORY_ROLE_TOOLS.implementer.includes('write_file'))
    assert.ok(EVE_FACTORY_ROLE_TOOLS.implementer.includes('edit_file'))
  })
  test('factory session auth carries the frozen role plan and surface=factory', () => {
    const auth = eveFactoryScopeAuth('owner', { botId: 'b', workspaceId: 'w' }, {
      ...plan(), runId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222',
      attemptId: '33333333-3333-4333-8333-333333333333', readOnly: false,
    } as never)
    assert.equal(auth.attributes?.surface, 'factory')
    const parsed = eveFactorySessionAuth(auth as never)
    assert.equal(parsed?.role, 'implementer')
    assert.equal(parsed?.provider, 'openrouter')
  })
})

describe('role result → RunReport conversion', () => {
  const messages = (value: unknown) => [{ role: 'assistant', content: [{ type: 'result', value }] }]
  test('missing or malformed structured result fails closed', () => {
    assert.equal(eveFactoryResultFromMessages(undefined), null)
    assert.equal(eveFactoryResultFromMessages([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]), null)
    assert.equal(eveFactoryResultFromMessages(messages({ summary: 'x', filesChanged: 'not-an-array' })), null)
  })
  test('implementer publish is a host receipt: pushed only when the remote ref matches the worktree head', () => {
    const result = eveFactoryResultFromMessages(messages({ summary: 'done', filesChanged: ['a.ts'] }))!
    const report = eveFactoryReportFor('implementer', result, {
      headSha: 'a'.repeat(40), branchRefSha: 'a'.repeat(40), filesChanged: [],
      verify: { status: 'not_run' }, publicationBranch: 'mikka/al-1',
    })
    assert.deepEqual(report.publish, { branch: 'mikka/al-1', commit: 'a'.repeat(40), pushed: true, remote: 'origin' })
    const unPushed = eveFactoryReportFor('implementer', result, {
      headSha: 'a'.repeat(40), branchRefSha: 'b'.repeat(40), filesChanged: [],
      verify: { status: 'not_run' }, publicationBranch: 'mikka/al-1',
    })
    assert.equal(unPushed.publish?.pushed, false)
    assert.equal(unPushed.publish?.commit, null)
  })
  test('reviewer report binds the frozen candidate sha and host verify result, never agent claims', () => {
    const result = eveFactoryResultFromMessages(messages({
      summary: 'checked', reviewVerdict: 'passed', filesChanged: ['tampered.ts'],
      criteria: [{ text: 'criterion', status: 'passed' }],
    }))!
    const report = eveFactoryReportFor('reviewer', result, {
      headSha: 'c'.repeat(40), branchRefSha: null, filesChanged: [],
      verify: { status: 'passed', command: 'pnpm test', exitCode: 0, signal: null, timedOut: false, output: 'ok' },
      check: { sha: 'c'.repeat(40), command: 'pnpm test', reportOnly: false },
    })
    assert.deepEqual(report.check, { sha: 'c'.repeat(40), readOnly: true })
    assert.equal(report.verify.status, 'passed')
    assert.equal(report.verify.exitCode, 0)
    // Host-computed working tree wins over the agent-supplied list.
    assert.deepEqual(report.filesChanged, [])
    assert.equal(report.reviewVerdict, 'passed')
  })
})
