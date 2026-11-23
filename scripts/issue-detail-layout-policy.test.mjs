import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { auditRepository, containerSteps, descendantButtonMinHeight, needleOutsideElement, viewportSteps, FILES } from './issue-detail-layout-policy.mjs'

const FIXTURE = {
  [FILES.properties]: '<div id={contentId}>{relations}</div>',
  [FILES.header]: '<header className="@container/header px-3" />',
  [FILES.taskDetail]: '<Textarea className="text-2xl font-semibold" />',
}
const read = path => {
  for (const candidate of [new URL(`../${path}`, import.meta.url), new URL(`../.hosted-ui/web/${path}`, import.meta.url)]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  return undefined
}
const readWithFallback = path => read(path) ?? FIXTURE[path]
const rules = (files = {}) => auditRepository(path => files[path] ?? readWithFallback(path)).map(finding => finding.rule)

test('the repository as it stands passes every ALE-17 invariant', () => {
  assert.deepEqual(auditRepository(read), [])
})

test('a descendant button min-height is a finding', () => {
  assert.deepEqual(descendantButtonMinHeight('<section className="[&_button]:min-h-11 lg:[&_button]:min-h-0">'), ['[&_button]:min-h-11'])
  assert.deepEqual(rules({ [FILES.properties]: '<section className="[&_button]:min-h-11" />' }), ['properties/descendant-button-min-height'])
})

test('relations outside the controlled region is a finding', () => {
  const inside = '<div id={contentId}><section /><div>{relations}</div></div>'
  const outside = '<div id={contentId}><section /></div><div>{relations}</div>'
  assert.equal(needleOutsideElement(inside, 'id={contentId}', '{relations}'), false)
  assert.equal(needleOutsideElement(outside, 'id={contentId}', '{relations}'), true)
})

test('viewport breakpoints in the header are a finding, container steps are counted', () => {
  assert.deepEqual(viewportSteps('<header className="px-3 sm:px-4" />'), ['sm'])
  assert.deepEqual(viewportSteps('<header className="@container/header px-3 @sm/header:px-4" />'), [])
  assert.deepEqual(containerSteps('<header className="@md/header:hidden @lg/header:inline @xl/header:inline" />', 'header'), ['lg', 'md', 'xl'])
  assert.deepEqual(rules({ [FILES.header]: '<header className="px-3 sm:px-4" />' }), ['header/viewport-breakpoints'])
  assert.deepEqual(rules({ [FILES.header]: '<header className="@sm/header:a @md/header:b @lg/header:c @xl/header:d" />' }), ['header/too-many-container-steps'])
})

test('a comment naming a utility is not the utility', () => {
  assert.deepEqual(viewportSteps('// the old `sm:`/`md:` mix went away\n<header className="px-3" />'), [])
  assert.deepEqual(descendantButtonMinHeight('<i>{/* no `[&_button]:min-h-11` */}</i><section className="gap-3" />'), [])
})

test('an !important title size is a finding', () => {
  const rulesWith = taskDetail => auditRepository(path => path === FILES.taskDetail ? taskDetail : readWithFallback(path)).map(f => f.rule)
  assert.deepEqual(rulesWith('<Textarea className="text-2xl! font-semibold" />'), ['title/important-font-size'])
  assert.deepEqual(rulesWith('<Textarea className="text-2xl font-semibold md:text-2xl" />'), [])
})
