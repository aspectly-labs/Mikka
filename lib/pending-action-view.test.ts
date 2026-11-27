import assert from 'node:assert/strict'
import test from 'node:test'

import { actionOutcome } from './pending-action-view'

test('keeps only ids and the link from a result', () => {
  assert.deepEqual(actionOutcome({ response_data: { id: 'e1', htmlLink: 'https://calendar.google.com/e1', attendees: [] } }), { id: 'e1', htmlLink: 'https://calendar.google.com/e1' })
  assert.deepEqual(actionOutcome({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }), { id: 'm1', threadId: 't1' })
})
