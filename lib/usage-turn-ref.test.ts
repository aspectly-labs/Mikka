import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde'
import { eveTurnRef, groupTurnRef, isUsageTurnRef, runTurnRef } from './usage-turn-ref'
import { eveStreamId } from './eve/projection'
import { HostedWorkflowModel } from './abuse/workflow-model'

test('a Bot chat turn reference is the id its saved reply carries', () => {
  const session = '5b0f6a2e-0c6d-4c39-9b8b-2a1d4a1b9c01', turn = 'turn_01JD8XK2'
  assert.equal(eveTurnRef(session, turn), eveStreamId(session, turn))
})

test('references are plain ids or nothing', () => {
  assert.equal(groupTurnRef('8d6f6a6e-1b1d-4e8c-9a51-0b0d5f7e2a10'), 'group:8d6f6a6e-1b1d-4e8c-9a51-0b0d5f7e2a10')
  assert.equal(runTurnRef('r1', 't1'), 'run:r1:t1')
  for (const bad of [eveTurnRef('', 't'), groupTurnRef('a b'), groupTurnRef("x'; drop"), runTurnRef('r', '')]) assert.equal(bad, null)
  assert.equal(isUsageTurnRef('thread:1'), false)
  assert.equal(isUsageTurnRef(`group:${'a'.repeat(401)}`), false)
})

test('the Bot model keeps its turn across durable steps', () => {
  const model = new HostedWorkflowModel('owner', 'bot', 'claude-sonnet', 'eve:s:t')
  const copy = HostedWorkflowModel[WORKFLOW_DESERIALIZE](HostedWorkflowModel[WORKFLOW_SERIALIZE](model))
  assert.equal(copy.turnRef, 'eve:s:t')
  // A step serialized before turns were recorded still loads, with no turn.
  assert.equal(HostedWorkflowModel[WORKFLOW_DESERIALIZE]({ ownerId: 'owner', botId: null, modelId: 'm' }).turnRef, null)
})
