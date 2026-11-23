import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterSidebarRows,
  groupSidebarRows,
  matchesSidebarFilters,
  matchesSidebarQuery,
  sidebarFilters,
  sidebarGroupBy,
  sidebarOptions,
  sortSidebarRows,
  type SidebarViewRow,
} from './sidebar-view'

const row = (over: Partial<SidebarViewRow> & { name: string }): SidebarViewRow => ({ id: over.name, unread: false, ...over })
const names = (rows: readonly SidebarViewRow[]) => rows.map(item => item.name)

const api = row({ name: 'API Bot', at: '2026-11-18T10:00:00.000Z', unread: true, waitingCount: 2 })
const docs = row({ name: 'Docs Bot', at: '2026-11-19T10:00:00.000Z', working: true })
const ops = row({ name: 'Ops Bot', at: '2026-11-17T10:00:00.000Z', threads: ['#71 Infisical 连接超时排查'] })

test('sortSidebarRows sorts pinned, recent, and name cleanly', () => {
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'pinned')), ['API Bot', 'Docs Bot', 'Ops Bot'])
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'recent')), ['Docs Bot', 'API Bot', 'Ops Bot'])
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'name')), ['API Bot', 'Docs Bot', 'Ops Bot'])
  const quiet = row({ name: 'Quiet Bot', at: null })
  assert.deepEqual(names(sortSidebarRows([quiet, api], 'recent')), ['API Bot', 'Quiet Bot'])
})

test('filterSidebarRows and groupSidebarRows respect bot vs group dimensions', () => {
  assert.equal(matchesSidebarFilters(api, ['unread', 'waiting']), true)
  assert.equal(matchesSidebarFilters(api, ['unread', 'working']), false)
  assert.equal(matchesSidebarQuery(ops, 'Infisical'), true)
  assert.deepEqual(names(filterSidebarRows([api, docs, ops], ['unread'], '')), ['API Bot'])
  assert.deepEqual(groupSidebarRows([api, docs, ops], 'unread').map(bucket => bucket.id), ['unread', 'other'])
  assert.deepEqual(sidebarOptions('group'), { groups: ['none', 'unread'], filters: ['unread'] })
  assert.equal(sidebarGroupBy('group', 'working'), 'none')
  assert.deepEqual(sidebarFilters('group', ['unread', 'working', 'working']), ['unread'])
})
