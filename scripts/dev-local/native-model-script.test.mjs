import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeLocalModelAnswer } from './native-model-script.mjs'

const marker = '123e4567-e89b-42d3-a456-426614174000'
const issue = '123e4567-e89b-42d3-a456-426614174001'
const captureId = '123e4567-e89b-42d3-a456-426614174002'
const branch = 'mikka/test-1'
const prUrl = 'https://github.com/mikka-e2e/core-loop/pull/41'
const tools = ['submit', 'submit_capture', 'Bash'].map(name => ({ name }))
const promptText = `Create the fixture implementation. local acceptance ${marker}\n<!-- mikka-issue:${issue} -->\nusing head ${branch}.`
const shellResult = output => ({ type: 'tool-result', toolName: 'Bash', output })
const captureResult = output => ({ type: 'tool-result', toolName: 'submit_capture', output })

function request(parts = []) {
  return { tools, prompt: [{ role: 'user', content: promptText }, { role: 'tool', content: parts }] }
}

function toolCall(answer) {
  assert.equal(answer.finishReason, 'tool-calls')
  const part = answer.content[0]
  assert.equal(part.type, 'tool-call')
  return { ...part, input: JSON.parse(part.input) }
}

const delivered = [
  shellResult(`git diff --check origin/trunk HEAD\n${prUrl}\nFIXTURE_COMMIT_PUSHED`),
  shellResult('checks passed\nFIXTURE_CHECKS_PASSED'),
]

test('native fixture renders verification output, submits it as a capture, and declares it publicly safe', () => {
  const render = toolCall(nativeLocalModelAnswer(request(delivered)))
  assert.equal(render.toolName, 'Bash')
  assert.match(render.input.command, /npm test 2>&1/)
  assert.match(render.input.command, /ffmpeg .*drawtext/)
  assert.ok(render.input.command.includes('receipt="$TMPDIR/mikka-local-acceptance-evidence.txt"'), 'capture input stays in the daemon-owned temp root rather than dirtying the candidate worktree')
  assert.ok(render.input.command.includes('textfile=${receipt}:expansion=none'), 'zsh-compatible shell expansion keeps the receipt path intact')
  assert.match(render.input.command, /FIXTURE_CAPTURE_READY/)
  assert.ok(render.input.command.includes(`marker: ${marker}`))

  const withReceipt = request([...delivered, shellResult('rendered\nFIXTURE_CAPTURE_PATH=/tmp/fixture-evidence.png\nFIXTURE_CAPTURE_READY')])
  const capture = toolCall(nativeLocalModelAnswer(withReceipt))
  assert.equal(capture.toolName, 'submit_capture')
  assert.deepEqual(capture.input, { path: '/tmp/fixture-evidence.png', title: `Local acceptance ${marker} verification output` })

  const withCapture = request([...delivered,
    shellResult('rendered\nFIXTURE_CAPTURE_PATH=/tmp/fixture-evidence.png\nFIXTURE_CAPTURE_READY'),
    captureResult({ captureId, status: 'queued' }),
  ])
  const submit = toolCall(nativeLocalModelAnswer(withCapture))
  assert.equal(submit.toolName, 'submit')
  assert.deepEqual(submit.input.visualEvidence, [{ captureId, publicSafe: true }])
  assert.equal(submit.input.criteria[0].passed, true)
})

test('native fixture fails closed when the capture tool or capture id is absent', () => {
  const withoutCaptureTool = nativeLocalModelAnswer({ ...request(delivered), tools: tools.filter(tool => tool.name !== 'submit_capture') })
  assert.deepEqual(withoutCaptureTool, { status: 422, code: 'fixture_capture_tool_missing' })

  const badCapture = request([...delivered,
    shellResult('rendered\nFIXTURE_CAPTURE_PATH=/tmp/fixture-evidence.png\nFIXTURE_CAPTURE_READY'),
    captureResult({ status: 'queued' }),
  ])
  assert.deepEqual(nativeLocalModelAnswer(badCapture), { status: 422, code: 'fixture_capture_id_missing' })
})
