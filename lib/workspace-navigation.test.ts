import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalHref,
  nextMark,
  readLocation,
  readMark,
  sameLocation,
  sectionFor,
  sectionFromQuery,
  stepsToOrigin,
  taskOrigin,
  workspaceHref,
  workspaceLink,
  workspaceSearch,
  workspaceSectionLink,
  writeSectionQuery,
  type EntryMark,
  type WorkspaceLocation,
} from './workspace-navigation'

const BOT = '3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f'
const ISSUE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const RUN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const GROUP = '7c6b5a49-3827-4165-a4b3-c2d1e0f9a8b7'
const TEAM = '1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a'
const PROJECT = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const ARTIFACT = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901'
const SESSION = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8'
const WORKSPACE = '5f4e3d2c-1b0a-4987-8675-64534231201f'
const at = (path: string) => new URL(`https://app.example${path}`)
const NOWHERE = { bot: null, group: null, session: null, team: null, project: null, issue: null, task: null, thread: null, artifact: null, threads: null }
const place = (keys: Partial<WorkspaceLocation> & Pick<WorkspaceLocation, 'section'>): WorkspaceLocation => ({ ...NOWHERE, ...keys })

test('the task board survives a reload and a shared link', () => {
  const params = new URLSearchParams('bot=b1')
  writeSectionQuery(params, 'all-issues')
  assert.equal(params.toString(), 'bot=b1&section=all-issues')
  assert.equal(sectionFromQuery(params.get('section') ?? undefined), 'all-issues')
})

test('sections without a link of their own drop the section, and so does the Coordinator', () => {
  for (const section of ['team-issues', 'coordinator'] as const) {
    const params = new URLSearchParams('section=all-issues')
    writeSectionQuery(params, section)
    assert.equal(params.toString(), '')
  }
})

test('unknown or missing sections open the chat; older ?section=coordinator links still read', () => {
  assert.equal(sectionFromQuery(undefined), 'coordinator')
  assert.equal(sectionFromQuery('team-home'), 'coordinator')
  assert.equal(sectionFromQuery('projects'), 'projects')
  assert.deepEqual(readLocation(new URLSearchParams(`section=coordinator&bot=${BOT}`)), place({ section: 'coordinator', bot: BOT }))
})

test('an address reads back as the place it was written for', () => {
  for (const where of [
    place({ section: 'coordinator' }),
    place({ section: 'coordinator', bot: BOT }),
    place({ section: 'coordinator', bot: BOT, issue: ISSUE }),
    place({ section: 'coordinator', thread: RUN }),
    place({ section: 'coordinator', bot: BOT, issue: ISSUE, thread: RUN }),
    place({ section: 'all-issues', issue: ISSUE }),
    place({ section: 'artifacts', thread: RUN }),
    place({ section: 'projects' }),
    place({ section: 'group', group: GROUP }),
    place({ section: 'group', group: GROUP, thread: RUN, artifact: ARTIFACT }),
    place({ section: 'agent', session: SESSION }),
    place({ section: 'projects', project: PROJECT }),
    place({ section: 'team-home', team: TEAM }),
    place({ section: 'team-issues', team: TEAM, issue: ISSUE }),
    place({ section: 'team-projects', team: TEAM, project: PROJECT }),
    place({ section: 'coordinator', bot: BOT, artifact: ARTIFACT }),
    place({ section: 'artifacts', artifact: ARTIFACT }),
    place({ section: 'coordinator', threads: 'all' }),
    place({ section: 'all-issues', issue: ISSUE, thread: RUN, threads: BOT }),
  ]) {
    const href = workspaceHref(at('/mikka/zh-CN'), where)
    assert.ok(href.startsWith('/mikka/zh-CN'), href)
    assert.ok(sameLocation(readLocation(new URL(href, 'https://app.example').searchParams), where), href)
  }
})

test('links built from nothing and explicit workspace section links', () => {
  assert.equal(workspaceLink({ issue: ISSUE }), `/?issue=${ISSUE}`)
  assert.equal(workspaceLink({ bot: BOT }), `/?bot=${BOT}`)
  assert.equal(workspaceLink({ section: 'coordinator' }), '/')
  assert.equal(workspaceSearch({ section: 'all-issues' }), '?section=all-issues')
  assert.equal(workspaceSectionLink('artifacts', WORKSPACE), `/?section=artifacts&workspace=${WORKSPACE}`)
})

test('a team page without its team is the page it would scope', () => {
  assert.equal(sectionFor('team-projects', null), 'projects')
  assert.equal(sectionFor('team-issues', null), 'all-issues')
  assert.equal(sectionFor('team-home', null), 'coordinator')
  assert.equal(sectionFor('team-home', TEAM), 'team-home')
  assert.equal(sectionFor('all-issues', null), 'all-issues')
})

test('taskOrigin, canonicalHref, and entry marks behave consistently', () => {
  const origin = (search: string) => taskOrigin(new URLSearchParams(search))
  assert.deepEqual(origin(`section=coordinator&issue=${ISSUE}`), { section: 'coordinator', bot: null })
  assert.deepEqual(origin(`bot=${BOT}&issue=${ISSUE}`), { section: 'coordinator', bot: BOT })
  assert.equal(origin(`issue=${ISSUE}`), null)
  assert.equal(canonicalHref(at(`/mikka?bot=${BOT}&thread=${RUN}`), () => false), `/mikka?thread=${RUN}`)

  const doc = 'load-1'
  let mark: EntryMark | null = null
  mark = nextMark(mark, null, ISSUE, 'push', doc, false)
  assert.equal(stepsToOrigin(mark, doc), 1)
  mark = nextMark(mark, ISSUE, ISSUE, 'push', doc, false)
  mark = nextMark(mark, ISSUE, RUN, 'push', doc, true)
  assert.equal(stepsToOrigin(mark, doc), 3)
  assert.equal(stepsToOrigin(mark, 'load-2'), 0)
  assert.deepEqual(readMark({ __NA: true, mikkaEntry: { index: 2, task: { start: 2, doc, list: true } } }), { index: 2, task: { start: 2, doc, list: true } })
})
