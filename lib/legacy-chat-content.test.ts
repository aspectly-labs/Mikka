import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractLegacyOpenUIMarkdown,
  extractLegacyOpenUIText,
  isLegacyOpenUIReply,
  legacyChatContent,
} from './legacy-chat-content'

const WELCOME = `root = Stack([TextContent("你好，Alex！我是你的 Coordinator。"), BeQuestions("我可以帮你管理任务和日程。", [{id:"start", title:"想先从哪里开始？", options:[{value:"a", label:"整理收件箱"}, {value:"b", label:"看看今天的日程"}], allowCustom:true}])])`

test('legacyChatContent leaves ordinary Markdown unchanged', () => {
  const markdown = '## Summary\n\nAll checks passed on [[issue:11111111-1111-4111-8111-111111111111]].'
  assert.deepEqual(legacyChatContent(markdown), { format: 'markdown', text: markdown })
  assert.equal(isLegacyOpenUIReply(markdown), false)
  assert.equal(extractLegacyOpenUIMarkdown(markdown), null)
  assert.equal(extractLegacyOpenUIText(markdown), null)
})

test('ordinary code blocks mentioning root = are never misclassified as legacy OpenUI', () => {
  for (const sample of [
    '```python\nroot = Path(__file__).parent\n```',
    '```python\nroot = Stack()\nroot.push(1)\n```',
    '```python\nroot = Stack([TextContent("not a card")])\n```',
    '```text\nroot = Stack()\nroot.push(1)\n```',
    '```\nroot = Stack()\nroot.push(1)\n```',
    'Set `root = /var/www` in nginx.conf.',
    '```\nroot = 1\n```',
    'Talk about Stack(1) in prose.',
  ]) {
    assert.equal(isLegacyOpenUIReply(sample), false, sample)
    assert.equal(extractLegacyOpenUIText(sample), null, sample)
    assert.equal(extractLegacyOpenUIMarkdown(sample), null, sample)
    assert.equal(legacyChatContent(sample).format, 'markdown', sample)
  }

  // A plain-text fence wrapping a complete recognized OpenUI card still projects cleanly.
  const textFencedCard = '```text\nroot = Stack([TextContent("Your report is ready.")])\n```'
  assert.equal(isLegacyOpenUIReply(textFencedCard), true)
  assert.equal(extractLegacyOpenUIText(textFencedCard), 'Your report is ready.')
  assert.equal(extractLegacyOpenUIMarkdown(textFencedCard), 'Your report is ready.')
  assert.deepEqual(legacyChatContent(textFencedCard), { format: 'markdown', text: 'Your report is ready.' })
})

test('legacyChatContent projects historical controls, tabs, accordions, tables, code and ComputerCard safely', () => {
  const archived = `root = Stack([TextContent("Readable saved answer"), BeButton("继续细化", "never execute this prompt", "outline"), ShadcnAccordion([{title:"First section",content:"First saved content"},{title:"Second section",content:"Second saved content"}]), ShadcnTabs([{title:"First tab",children:[TextContent("First pane")]},{title:"Second tab",children:[TextContent("Second pane")] }]), ComputerCard("archived-bot", "archived-run", "Saved computer task", "approval", "Saved bot", "Saved thread")])`
  const result = legacyChatContent(archived)
  assert.equal(result.format, 'markdown')
  for (const text of ['Readable saved answer', 'First saved content', 'Second saved content', 'First pane', 'Second pane', '继续细化', 'Saved computer task', 'Saved thread']) {
    assert.ok(result.text.includes(text), text)
  }
  assert.doesNotMatch(result.text, /never execute|archived-bot|archived-run|root =|Stack\(/)

  const rawCard = 'root = Card([TextContent("Saved raw card"), CodeBlock("js", "const savedRaw = true")])'
  const rawResult = legacyChatContent(rawCard)
  assert.equal(rawResult.format, 'markdown')
  assert.match(rawResult.text, /Saved raw card/)
  assert.match(rawResult.text, /const savedRaw = true/)

  const repeated = 'root = Stack([body,body,BeCodeBlock("const saved = true", "js"),ShadcnTable(["Name","Value"],[["saved","42"]]),TaskChip("11111111-1111-4111-8111-111111111111"),RunChip("22222222-2222-4222-8222-222222222222")])\nbody = TextContent("Repeated saved text")'
  const repResult = legacyChatContent(repeated)
  assert.equal(repResult.format, 'markdown')
  assert.equal(repResult.text.split('Repeated saved text').length - 1, 2)
  assert.match(repResult.text, /\| Name \| Value \|/)
  assert.match(repResult.text, /\| saved \| 42 \|/)
  assert.match(repResult.text, /11111111-1111-4111-8111-111111111111/)
  assert.match(repResult.text, /22222222-2222-4222-8222-222222222222/)
})

test('malformed or unknown historical root components fall back cleanly to source without throwing', () => {
  const unknown = 'root = MissingComponent("<script>execute()</script>")'
  assert.deepEqual(legacyChatContent(unknown), { format: 'source', text: unknown })

  const cyclic = 'root = Stack([a])\na = Stack([b])\nb = Stack([a])'
  assert.deepEqual(legacyChatContent(cyclic), { format: 'source', text: cyclic })
})

test('extractLegacyOpenUIText & extractLegacyOpenUIMarkdown preserve prose, inline citations, fenced programs and chart omission', () => {
  assert.equal(
    extractLegacyOpenUIText(WELCOME),
    '你好，Alex！我是你的 Coordinator。\n想先从哪里开始？\n- 整理收件箱\n- 看看今天的日程',
  )
  assert.equal(
    extractLegacyOpenUIText(`\`\`\`openui\n${WELCOME}\n\`\`\``),
    '你好，Alex！我是你的 Coordinator。\n想先从哪里开始？\n- 整理收件箱\n- 看看今天的日程',
  )
  assert.equal(
    extractLegacyOpenUIMarkdown('先看重点：\nroot = InlineText(["处理 ", TaskChip("6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10"), " 见 ", SourceChip("https://example.com/pr/1", "PR #1")])'),
    '先看重点：\n\n处理 [[issue:6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10]] 见 [PR #1](https://example.com/pr/1)',
  )
  assert.equal(
    extractLegacyOpenUIText('root = Stack([chart])\nchart = BarChart(["周一", "周二"], [{name: "量", values: [4, 9]}])', { omitCharts: true }),
    '',
  )
  assert.equal(
    extractLegacyOpenUIText('Stack([TextContent("没写 root 也是历史卡片")])'),
    '没写 root 也是历史卡片',
  )
})

test('saved forms with @ToAssistant directives and EditableTable project cleanly without leaking action payloads', () => {
  const releaseChecklist = `root = Stack([timeline, form])
timeline = Steps([StepsItem("Wednesday", "Freeze main, tag v2.4.0-rc.1"), StepsItem("Friday 10 AM", "Ship web; run the migration off-peak")])
form = Form("release-checklist", Buttons([Button("Confirm checklist", Action([@ToAssistant("Confirm the v2.4 release checklist")]), "primary")]), [FormControl("Release checklist", EditableTable("checklist", [{type: "text", key: "item", header: "Item"}, {type: "text", key: "owner", header: "Owner"}], [{id: "1", values: ["Multi-currency migration rehearsed on a production snapshot", "Jordan Lee"]}, {id: "2", values: ["Stripe webhook fix is live", "Jordan Lee"]}, {id: "3", values: ["Rollback plan and feature flag", "Alex"]}]))])`
  const projected = legacyChatContent(releaseChecklist)
  assert.equal(projected.format, 'markdown')
  for (const expected of [
    'Wednesday',
    'Freeze main, tag v2.4.0-rc.1',
    'Friday 10 AM',
    'Release checklist',
    '| Item | Owner |',
    'Multi-currency migration rehearsed on a production snapshot',
    'Rollback plan and feature flag',
    'Jordan Lee',
  ]) {
    assert.ok(projected.text.includes(expected), expected)
  }
  assert.doesNotMatch(projected.text, /@ToAssistant|Confirm the v2\.4 release checklist|Action\(|root =/)
})

test('saved EditableTable select columns map option values to visible labels with unmatched fallback', () => {
  const tableWithSelect = `root = Stack([Form("status-board", Buttons([Button("Save", Action([@ToAssistant("Save status")]), "primary")]), [FormControl("Release status", EditableTable("status", [{type: "text", key: "task", header: "Task"}, {type: "select", key: "status", header: "Status", options: [{value: "in_progress", label: "In progress"}, {value: "done", label: "Done"}]}], [{id: "1", values: ["Webhook replay", "in_progress"]}, {id: "2", values: ["Legacy row", "custom_raw"]}]))])])`
  const projected = legacyChatContent(tableWithSelect)
  assert.equal(projected.format, 'markdown')
  assert.match(projected.text, /\| Task \| Status \|/)
  assert.match(projected.text, /\| Webhook replay \| In progress \|/)
  assert.match(projected.text, /\| Legacy row \| custom_raw \|/)
  assert.doesNotMatch(projected.text, /in_progress|@ToAssistant|Save status/)
  assert.ok(extractLegacyOpenUIText(tableWithSelect)?.includes('In progress'))
})

test('saved BeQuestions preserve both question and option descriptions without emitting action identifiers', () => {
  const savedQuestions = `root = Stack([intro, questions])
intro = TextContent("Two blockers left.")
questions = BeQuestions("v2.4 release", [{id: "ios", title: "Should iOS wait?", description: "Affects the Friday mobile cut.", options: [{value: "wait", label: "Wait and ship together", description: "Could slip to next Tuesday"}, {value: "web-first", label: "Web first, iOS next week"}]}])`
  const projected = legacyChatContent(savedQuestions)
  assert.equal(projected.format, 'markdown')
  assert.ok(projected.text.includes('Should iOS wait?'))
  assert.ok(projected.text.includes('Affects the Friday mobile cut.'))
  assert.ok(projected.text.includes('- Wait and ship together — Could slip to next Tuesday'))
  assert.ok(projected.text.includes('- Web first, iOS next week'))
  assert.doesNotMatch(projected.text, /web-first|v2\.4 release|root =/)
})
