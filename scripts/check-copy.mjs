/**
 * Guards the parts of mikka-hosted-ui/docs/design/copy.md that a script can decide without
 * reading the component. Run it with `node scripts/check-copy.mjs`; it exits
 * non-zero and lists every offender.
 *
 * Whether a sentence needs 「请」 depends on what the component renders next to
 * it (C-04), so this script does not guess with a regex. It checks only:
 *
 * - C-04 label keys: button, label, placeholder, title and heading strings
 *   (picked by key name) never contain an imperative 「请」.
 * - C-04 retry-button keys: strings listed in `retryButtonKeys` are rendered
 *   next to a retry or matching action button, so they must not repeat the
 *   action as 「请重试」 / "try again". Add a key here when you put its text
 *   beside such a button; remove it when the button goes away.
 * - C-02 colloquial words in zh-CN (「没能」「打不开了」, sentence-final 吧/呢/哦/啊).
 * - C-03 apologies and interjections (「抱歉」「请稍等」, "sorry", "oops").
 * - R-44 greeting headlines: a title or heading names the place or period,
 *   never 「欢迎回来」 / 「早上好，…」 / "Welcome back".
 * - R-40 exclamation marks: interface text states, it does not exclaim.
 * - R-43 the worker that runs a thread is an Agent: no "harness" or 「执行器」 in
 *   copy. Keys and ICU placeholders such as `{harness}` are identifiers and stay.
 *
 * - C-11 label shape, as a ratchet: a label, button, tab or title ends without a
 *   full stop and has no parenthetical note, except the optional-field mark
 *   「（选填）」 / 「（可选）」 / "(optional)". Strings that broke this before the rule
 *   are listed in `check-copy-baseline.json`; only new ones fail. When you fix
 *   one, delete its baseline line.
 *
 * It does not check English contractions (Microsoft recommends them), 「请」 in
 * full sentences, or whether a status line offers a next step. Reviewers judge
 * those against mikka-hosted-ui docs/design/copy.md.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const imperativeQing = /(?<![邀申])请(?!求)/
const labelKey = /(Button|Label|Placeholder|Title|Heading|Tab|Tooltip|Cta)\d*$|^(label|placeholder|title|heading|button|cta)\d*$/
const zhRetry = /请.{0,12}(重试|再试)/
const enRetry = /\b(try again|retry)\b/i
const zhColloquial = /没能|没发出去|打不开了|[吧呢哦啊](?=[。！？!?，]|$)/
const zhApology = /抱歉|对不起|不好意思|哎呀|哎哟|请稍等|请稍候/
const enApology = /\b(sorry|oops|whoops|uh-oh|apologi[sz]e)\b/i
const greetingKey = /(Title|Heading)\d*$|^(title|heading|welcome)\d*$/
const greeting = /^(欢迎回来|欢迎|早上好|下午好|晚上好|你好)|^(welcome( back)?|good (morning|afternoon|evening)|hi|hey|hello)\b/i
const exclamation = /[!！]/
const workerTerm = /harness|执行器/i
const withoutPlaceholders = value => value.replace(/\{\s*\w+/g, '{')

// C-11: labels, buttons, tabs and titles. Tooltips and placeholders are left out: they may be sentences.
const shortLabelKey = /(Button|Label|Title|Heading|Tab|Cta)\d*$|^(label|title|heading|button|cta)\d*$/
const optionalMark = /[（(](?:选填|可选|optional)[）)]/gi
/** The literal text of an ICU message: every `{…}` argument, nested plural branches included, removed. */
const literalText = value => {
  let out = ''
  let depth = 0
  for (const ch of value) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += ch
  }
  return out.trim()
}

/** C-11 shape problems of one string, `[{ rule, message }]`. A label ends without a full stop and has no parenthetical note. */
export function labelShapeProblems(key, value) {
  if (!shortLabelKey.test(key.split('.').at(-1))) return []
  const text = literalText(value)
  const problems = []
  if (/[。．]$/.test(text) || (text.endsWith('.') && !text.endsWith('...'))) problems.push({ rule: 'C-11-period', message: 'C-11 标签/按钮/标题不带句号' })
  if (/[（(]/.test(text.replace(optionalMark, ''))) problems.push({ rule: 'C-11-paren', message: 'C-11 标签/按钮/标题不加括号注释（只允许「（选填）」）' })
  return problems
}

/** Ratchet: C-11 hits not in the baseline fail; baseline ids that no longer hit are stale and should be deleted. */
export function applyBaseline(hits, baseline) {
  const known = new Set(baseline)
  const seen = new Set(hits.map(hit => hit.id))
  return { fresh: hits.filter(hit => !known.has(hit.id)), stale: baseline.filter(id => !seen.has(id)) }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

/** Keys whose component renders a retry or matching action button beside the text. */
const retryButtonKeys = new Set([
  'Issue.create.createError',
  'Auth.oauthFailed',
  'Auth.githubStartFailed',
  'Auth.googleStartFailed',
  'Auth.connectionFailed',
  'Auth.testWorkspaceFailed',
  'Invite.signOutFailed',
  'Invite.acceptFailed',
  'Invite.errors.createFailed',
  'Workspace.detail.documentNotConnected',
  'Workspace.detail.autosaveFailed',
  'IssueDetail.restoreFailed',
  'IssueDetail.history.restoreFailed',
  'IssueDetail.history.restoreIncomplete',
  'Members.readFailed',
  'Members.keptPrevious',
  'Members.addFailed',
  'Members.removeFailed',
  'Projects.loadErrorTitle',
  'DeviceAuthorization.failed',
  'Shell.newTaskDialog.failed',
  'FeatureCopy.c_85f5c4d3',
  'FeatureCopy.c_281364f7',
  'FeatureCopy.c_3f765954',
  'AgentCopy.aCardOrTableInThisResponse',
  'AgentCopy.unableToCreateWorkspacePleaseTryAgain',
  'AgentCopy.submissionFailedYourChoicesAndAnswersAre',
])

const flatten = (node, path = [], out = new Map()) => {
  if (typeof node === 'string') out.set(path.join('.'), node)
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) flatten(value, [...path, key], out)
  return out
}

if (isMain) {
  const problems = []
  const report = (file, key, rule, value) => problems.push(`${file} ${key}: ${rule} — ${value}`)
  const labelHits = []
  for (const [file, lang] of [['messages/zh-CN.json', 'zh'], ['messages/en.json', 'en']]) {
    const strings = flatten(JSON.parse(readFileSync(file, 'utf8')))
    for (const key of retryButtonKeys) if (!strings.has(key)) report(file, key, 'retryButtonKeys 中的 key 不存在', '')
    for (const [key, value] of strings) {
      const leaf = key.split('.').at(-1)
      if (greetingKey.test(leaf) && greeting.test(value)) report(file, key, 'R-44 标题不写问候，写这里是什么', value)
      if (exclamation.test(value)) report(file, key, 'R-40 界面文字不用感叹号', value)
      if (workerTerm.test(withoutPlaceholders(value))) report(file, key, 'R-43 the worker is an Agent, not harness/执行器', value)
      if (key.startsWith('Coordinator.activity.') && /^(?:使用工具|Use a tool)$/.test(value)) report(file, key, 'R-83 a tool call says what it did to what, never a bare 「使用工具」', value)
      for (const hit of labelShapeProblems(key, value)) labelHits.push({ id: `${file} ${key} ${hit.rule}`, file, key, message: hit.message, value })
      if (lang === 'zh') {
        if (labelKey.test(leaf) && imperativeQing.test(value)) report(file, key, 'C-04 标签/按钮/占位符/标题里不写「请」', value)
        if (retryButtonKeys.has(key) && zhRetry.test(value)) report(file, key, 'C-04 旁边已有重试按钮，文字不写「请重试」', value)
        if (zhColloquial.test(value)) report(file, key, 'C-02 口语化', value)
        if (zhApology.test(value)) report(file, key, 'C-03 道歉/客套', value)
      } else {
        if (retryButtonKeys.has(key) && enRetry.test(value)) report(file, key, 'C-04 retry button already rendered; drop "try again"', value)
        if (enApology.test(value)) report(file, key, 'C-03 apology or interjection', value)
      }
    }
  }

  const baseline = JSON.parse(readFileSync(new URL('./check-copy-baseline.json', import.meta.url), 'utf8')).c11
  const { fresh, stale } = applyBaseline(labelHits, baseline)
  for (const hit of fresh) report(hit.file, hit.key, hit.message, hit.value)
  for (const id of stale) console.log(`C-11 baseline entry is fixed; delete it from scripts/check-copy-baseline.json: ${id}`)

  if (problems.length) {
    console.error(`Copy check failed: ${problems.length} string(s)\n`)
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log('Copy check passed: labels without 「请」, no retry text beside retry buttons, no colloquial or apologetic copy, Agent for the worker, no greeting titles or exclamation marks, no bare 「使用工具」, no new full stops or parenthetical notes in labels (C-11).')
}
