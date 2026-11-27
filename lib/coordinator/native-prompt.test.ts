import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinatorPresentation, personalCoordinatorInstructions } from './native-prompt'
import { coordinatorRuntimeSchema, nativeCoordinatorCommandSchema } from '@mikka/protocol/coordinator'

test('personal instructions use clean Markdown presentation and forbid OpenUI DSL', () => {
  const instructions = personalCoordinatorInstructions()
  const presentation = coordinatorPresentation()
  assert.match(instructions, /everyday life/)
  assert.match(instructions, /send_email/)
  // Agents never ask for permission (ADR 2026-11-27-1615): no approval steering.
  assert.doesNotMatch(instructions, /awaiting_approval|policy ask|missing permission/)
  assert.match(instructions, /never ask for a separate yes/)
  assert.doesNotMatch(instructions, /host's real approval workflow/)
  assert.match(presentation, /^Presentation:\n/)
  assert.match(presentation, /Reply in clean, concise Markdown/)
  assert.match(presentation, /\[\[issue:<id>\]\]/)
  assert.match(presentation, /\[\[run:<id>\]\]/)
  assert.match(presentation, /Never output OpenUI Lang/)
  assert.doesNotMatch(instructions, /TextContent\(|BeTable\(|BarChart\(|LineChart\(|AreaChart\(|DonutChart\(|RadialChart\(|EditableTable\(|BeStat\(|BeAlert\(|BeBadge\(|BeTimeline\(|ShadcnTable\(|ReuiFrame\(|ComputerCard\(/)
  assert.ok(instructions.endsWith(presentation))
  assert.doesNotMatch(instructions, /Prime/)
})

test('runtime selection is explicit and does not accept arbitrary commands or a third party identity', () => {
  assert.deepEqual(coordinatorRuntimeSchema.parse({ harness: 'ai_sdk' }), { harness: 'ai_sdk' })
  assert.equal(coordinatorRuntimeSchema.safeParse({ harness: 'codex' }).success, false)
  assert.equal(coordinatorRuntimeSchema.safeParse({ harness: 'codex', deviceId: 'not-a-uuid' }).success, false)
  assert.equal(coordinatorRuntimeSchema.safeParse({ harness: 'ai_sdk', userId: 'victim' }).success, false)
  assert.equal(coordinatorRuntimeSchema.safeParse({ harness: 'prime' }).success, false)
})

test('native completion preserves source exactly and rejects whitespace-only replies', () => {
  const text = '你好，已为你整理好今天的事项。\n'
  assert.equal(nativeCoordinatorCommandSchema.parse({ type: 'complete', text }).type, 'complete')
  assert.deepEqual(nativeCoordinatorCommandSchema.parse({ type: 'complete', text }), { type: 'complete', text })
  assert.equal(nativeCoordinatorCommandSchema.safeParse({ type: 'complete', text: '  ' }).success, false)
})
