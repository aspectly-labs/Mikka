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
    'Set `root = /var/www` in nginx.conf.',
    '```\nroot = 1\n```',
    'Talk about Stack(1) in prose.',
  ]) {
    assert.equal(isLegacyOpenUIReply(sample), false, sample)
    assert.equal(extractLegacyOpenUIText(sample), null, sample)
    assert.equal(legacyChatContent(sample).format, 'markdown', sample)
  }
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
