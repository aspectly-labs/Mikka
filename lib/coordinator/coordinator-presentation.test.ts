// i18n-ignore-file: model prompt fixtures, not UI copy.
/**
 * Offline presentation fixture (mikka-hosted-ui/docs/design/decisions/2026-11-25-remove-openui.md):
 * every Coordinator path carries the Markdown presentation block exactly once,
 * uses native Mikka citations, and emits zero OpenUI DSL instructions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeSnapshot } from '@/lib/agent-kit/definition'
import { builtinAgentDefinition } from '@/lib/agent-kit/builtin'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import { coordinatorWelcome } from '@/lib/agent-welcome'
import { COORDINATOR_INSTRUCTIONS } from './instructions'
import { coordinatorPresentation, personalCoordinatorInstructions, withCoordinatorPresentation } from './native-prompt'

const presentation = coordinatorPresentation()
const occurrences = (text: string) => text.split(presentation).length - 1

test('every Coordinator path carries the Markdown presentation block exactly once', () => {
  const definition = builtinAgentDefinition()
  const runtime = { harness: 'ai_sdk' as const, model: 'fixture' }
  const paths = {
    hosted: withCoordinatorPresentation(COORDINATOR_INSTRUCTIONS),
    hostedAgentKit: withCoordinatorPresentation(executionInstructions(makeSnapshot('rev', 1, definition, COORDINATOR_INSTRUCTIONS, runtime))),
    native: personalCoordinatorInstructions(),
    // A native agent-kit snapshot freezes personalCoordinatorInstructions(), which already ends with the block.
    nativeAgentKit: withCoordinatorPresentation(executionInstructions(makeSnapshot('rev', 1, definition, personalCoordinatorInstructions(), runtime))),
  }
  for (const [name, instructions] of Object.entries(paths)) {
    assert.equal(occurrences(instructions), 1, name)
    assert.doesNotMatch(instructions, /openui-lang|BeQuestions\(|BeCardGrid\(|BeImageCard\(/, name)
  }
})

test('the presentation block specifies clean Markdown and native citations across Web, Desktop and Mobile iOS', () => {
  assert.match(presentation, /^Presentation:\n/)
  assert.match(presentation, /Web, Desktop and Mobile iOS/)
  assert.match(presentation, /GFM tables/)
  assert.match(presentation, /\[\[issue:<id>\]\]/)
  assert.match(presentation, /\[\[run:<id>\]\]/)
  assert.match(presentation, /Never output OpenUI Lang/)
  assert.doesNotMatch(presentation, /## Syntax Rules|## Component Signatures|## Hoisting & Streaming/)
})

test('welcome prompts request plain Markdown instead of OpenUI', () => {
  const zh = coordinatorWelcome('Alex', 'zh-CN')
  const en = coordinatorWelcome('Alex', 'en', 'Release Bot')
  for (const prompt of [zh, en]) {
    assert.match(prompt, /plain Markdown/)
    assert.doesNotMatch(prompt, /root = Stack|BeQuestions\(|TextContent\(/)
  }
})
