import assert from 'node:assert/strict'
import test from 'node:test'
import { chatPreview, chatRowPreview } from './agent-history'

test('a bot row reads Markdown as its plain text', () => {
  assert.equal(chatPreview('## 结论\n\n**已合并** `#781`，见 [PR](https://github.com/x/y/pull/781)。'), '结论 已合并 #781，见 PR。')
})

test('a bot row reads an OpenUI reply as its first words, never its source', () => {
  // Tab titles are short quoted strings; the old quote scan read from one string's end to the next one's start.
  const tabs = 'root = Stack([tabs])\ntabs = BeTabs([{title: "现象", children: [TextContent("E2B 返回 429 后 dispatch 一直重试。")]}, {title: "日志", children: [BeCodeBlock("retry 1/∞", "text")]}])'
  const preview = chatPreview(tabs)
  assert.ok(preview && !/children|TextContent|\[|\(/.test(preview), preview ?? 'null')
  assert.equal(preview, '现象')
  assert.equal(chatPreview('root = Stack([intro])\nintro = TextContent("发版前有两个阻塞。")'), '发版前有两个阻塞。')
  // Inline chips read as their labels; citation tokens go.
  assert.equal(chatPreview('root = InlineText(["评审在 ", SourceChip("https://github.com/x/y/pull/851", "PR #851"), " 里指出", TaskChip("6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10")])'), '评审在 PR #851 里指出')
  // Prose the bot wrote above the card comes first; a reply without `root =` is still a card.
  assert.equal(chatPreview('看一下：\nroot = Stack([TextContent("表格")])'), '看一下：')
  assert.equal(chatPreview('Stack([TextContent("没写 root 也是卡片")])'), '没写 root 也是卡片')
})

test('a card that shows no words reads as null, for the row placeholder', () => {
  assert.equal(chatPreview('root = Stack([chart])\nchart = BarChart(["周一", "周二"], [{name: "多提及消息", values: [4, 9]}])'), null)
  assert.equal(chatPreview('root = LineChart(["10/25"], [{name: "失败率", values: [0]}], "%")'), null)
  // A program the parser cannot read never leaks its source either.
  assert.equal(chatPreview('root = Stack([form])\nform = Form("x", Buttons([Button("确认", Action([@ToAssistant("确认")]), "primary")]))'), null)
})

test('a row preview reads every Markdown form as its words, like a chat app list', () => {
  // Headings, emphasis, quotes, lists, task boxes, rules and tables keep only their words.
  assert.equal(chatPreview('## 第 69 轮：检查结果\n\n- [x] **复核** 通过\n> 引用一句\n\n---\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |'), '第 69 轮：检查结果 复核 通过 引用一句 列 值 a 1')
  // A code fence reads as its first line; inline code keeps its text; HTML tags and images go, an image keeps its alt text.
  assert.equal(chatPreview('改好了：\n```ts\nconst a = 1\nconst b = 2\n```\n见 `fix()`'), '改好了： const a = 1 见 fix()')
  assert.equal(chatPreview('```\n\n```'), '')
  assert.equal(chatPreview('<details><summary>日志</summary>\n\n截图 ![构建图](https://x.test/a.png)</details>'), '日志 截图 构建图')
  // Autolinks read as their address; escaped characters as themselves; strikethrough and *italic* lose their marks.
  assert.equal(chatPreview('看 <https://example.com/a> 和 \\*星号\\*，~~旧~~ *新*'), '看 https://example.com/a 和 *星号*，旧 新')
  // Every typed marker goes, a named chat's too.
  assert.equal(chatPreview('对照 [[issue:6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10]] 和 [[chat:6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a11]]'), '对照 和')
})

test('a long row preview ends in an ellipsis, never in half a character', () => {
  const preview = chatPreview('😀'.repeat(200))
  assert.ok(preview?.endsWith('…'), preview ?? 'null')
  assert.equal(Array.from(preview!).length, 120)
  assert.ok(!/[\uD800-\uDBFF]…$/.test(preview!))
  assert.equal(chatPreview('短句'), '短句')
})

test('a sidebar row names its references, then reads as plain text', () => {
  const label = (reference: { type: string }) => reference.type === 'task' ? '任务' : '线程'
  assert.equal(chatRowPreview('## 对照 [[issue:6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a10]] 和 **[[run:6f1c2c4e-0d7a-4c1b-9a43-2b6c1f3e9a12]]**', label, '[卡片]'), '对照 任务 和 线程')
  assert.equal(chatRowPreview('root = LineChart(["10/25"], [{name: "失败率", values: [0]}], "%")', label, '[卡片]'), '[卡片]')
  assert.equal(chatRowPreview(null, label, '[卡片]'), null)
  assert.equal(chatRowPreview('   ', label, '[卡片]'), null)
})
