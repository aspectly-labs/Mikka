import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PREFERENCES } from './preferences'
import { desktopCandidateReason, filterDesktopCandidates, type DesktopCandidate } from './platform/desktop-notifications'
import { DEFAULT_DND_SCHEDULE, DND_DAYS, NOTIFICATION_SOUNDS, inDndWindow, pushAllowed, type DndSchedule } from './push-allowed'
import { SETTINGS_REGISTRY, parseSettingsPatch, resolveSettingValue, settingsSchema } from './settings/registry'

const WS_C_KEYS = [
  'memoryAutoApprove',
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'dndDays',
  'notifyMobileDecide',
  'notifyMobileReview',
  'notifyMobileFinished',
  'notifyMobileBriefing',
  'notifyDesktopDecide',
  'notifyDesktopReview',
  'notifyDesktopFinished',
  'notifyDesktopBriefing',
  'notifyEmailInvitations',
  'notificationSound',
] as const

test('every WS-C personal setting resolves null -> default and explicit override -> personal without workspace leakage', () => {
  const sampleOverrides: Record<(typeof WS_C_KEYS)[number], boolean | string | string[]> = {
    memoryAutoApprove: true,
    dndEnabled: true,
    dndStart: '21:30',
    dndEnd: '07:15',
    dndDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    notifyMobileDecide: false,
    notifyMobileReview: false,
    notifyMobileFinished: false,
    notifyMobileBriefing: false,
    notifyDesktopDecide: false,
    notifyDesktopReview: false,
    notifyDesktopFinished: false,
    notifyDesktopBriefing: false,
    notifyEmailInvitations: false,
    notificationSound: 'chime',
  }

  for (const key of WS_C_KEYS) {
    const def = SETTINGS_REGISTRY[key]
    assert.deepEqual(resolveSettingValue(key, null, null), { value: def.defaultValue, source: 'default' }, `${key} null falls back to default`)
    // Personal-only settings ignore any hypothetical workspace value.
    assert.deepEqual(resolveSettingValue(key, null, sampleOverrides[key]), { value: def.defaultValue, source: 'default' }, `${key} ignores workspace value`)
    assert.deepEqual(resolveSettingValue(key, sampleOverrides[key], null), { value: sampleOverrides[key], source: 'personal' }, `${key} explicit override resolves as personal`)
    // Explicit false / empty array still resolves as personal override, never default.
    if (def.type === 'boolean') {
      assert.deepEqual(resolveSettingValue(key, false, null), { value: false, source: 'personal' })
      assert.deepEqual(resolveSettingValue(key, true, null), { value: true, source: 'personal' })
    }
  }
  assert.deepEqual(resolveSettingValue('dndDays', [], null), { value: [], source: 'personal' })

  const schema = settingsSchema()
  for (const key of WS_C_KEYS) {
    const entry = schema.find(item => item.key === key)
    assert.ok(entry, `${key} is in settingsSchema`)
    assert.deepEqual(entry.scope, ['personal'])
    assert.deepEqual(entry.writeAccess, { personal: 'owner' })
    assert.equal(entry.page, key === 'memoryAutoApprove' ? 'instructions' : 'notifications')
    assert.equal(entry.group, key === 'memoryAutoApprove' ? 'memory' : 'notifications')
    assert.ok(entry.label.en.length > 0 && entry.label['zh-CN'].length > 0)
  }
})

test('parseSettingsPatch validates HH:mm, weekday arrays, sound presets, and rejects workspace writes', () => {
  for (const key of WS_C_KEYS) {
    assert.throws(() => parseSettingsPatch('workspace', { values: { [key]: SETTINGS_REGISTRY[key].defaultValue } }), `${key} rejects workspace scope`)
  }
  for (const badTime of ['8:00', '24:00', '22:60', '22:00:00', 'night', 2200]) {
    assert.throws(() => parseSettingsPatch('personal', { values: { dndStart: badTime } }))
    assert.throws(() => parseSettingsPatch('personal', { values: { dndEnd: badTime } }))
  }
  for (const badDays of [['monday'], ['mon', 'mon'], 'mon', [1]]) {
    assert.throws(() => parseSettingsPatch('personal', { values: { dndDays: badDays } }))
  }
  for (const badSound of ['custom.mp3', 'loud', '', false, 42]) {
    assert.throws(() => parseSettingsPatch('personal', { values: { notificationSound: badSound } }))
  }
  for (const sound of NOTIFICATION_SOUNDS) {
    assert.deepEqual(parseSettingsPatch('personal', { values: { notificationSound: sound } }), { notificationSound: sound })
  }
  assert.deepEqual(
    parseSettingsPatch('personal', { values: { dndEnabled: true, dndStart: '00:00', dndEnd: '23:59', dndDays: [...DND_DAYS], memoryAutoApprove: null } }),
    { dndEnabled: true, dndStart: '00:00', dndEnd: '23:59', dndDays: [...DND_DAYS], memoryAutoApprove: null },
  )
})

test('scheduled DND handles overnight and same-day windows in IANA time zones with UTC fallback', () => {
  const overnightAllDays: DndSchedule = { enabled: true, start: '22:00', end: '08:00', days: DND_DAYS }
  // America/New_York on 2026-11-20 (EST = UTC-5):
  // 2026-11-21T02:59:00Z = Fri 21:59 EST (outside)
  // 2026-11-21T03:00:00Z = Fri 22:00 EST (start inclusive -> inside)
  // 2026-11-21T07:30:00Z = Sat 02:30 EST (overnight -> inside)
  // 2026-11-21T13:00:00Z = Sat 08:00 EST (end exclusive -> outside)
  assert.equal(inDndWindow(overnightAllDays, 'America/New_York', new Date('2026-11-21T02:59:00Z')), false)
  assert.equal(inDndWindow(overnightAllDays, 'America/New_York', new Date('2026-11-21T03:00:00Z')), true)
  assert.equal(inDndWindow(overnightAllDays, 'America/New_York', new Date('2026-11-21T07:30:00Z')), true)
  assert.equal(inDndWindow(overnightAllDays, 'America/New_York', new Date('2026-11-21T13:00:00Z')), false)

  // Overnight weekday boundary: Friday night only ('fri' 22:00 -> Sat 08:00)
  const fridayNightOnly: DndSchedule = { enabled: true, start: '22:00', end: '08:00', days: ['fri'] }
  assert.equal(inDndWindow(fridayNightOnly, 'America/New_York', new Date('2026-11-20T07:30:00Z')), false, 'Fri 02:30 EST belongs to Thu night')
  assert.equal(inDndWindow(fridayNightOnly, 'America/New_York', new Date('2026-11-21T03:30:00Z')), true, 'Fri 22:30 EST belongs to Fri night')
  assert.equal(inDndWindow(fridayNightOnly, 'America/New_York', new Date('2026-11-21T07:30:00Z')), true, 'Sat 02:30 EST belongs to Fri night')
  assert.equal(inDndWindow(fridayNightOnly, 'America/New_York', new Date('2026-11-22T03:30:00Z')), false, 'Sat 22:30 EST belongs to Sat night')
  assert.equal(inDndWindow(fridayNightOnly, 'America/New_York', new Date('2026-11-22T07:30:00Z')), false, 'Sun 02:30 EST belongs to Sat night')

  // Same-day window in Asia/Shanghai (UTC+8): 12:00 -> 14:00 on Wednesday (2026-11-18)
  const lunchBreak: DndSchedule = { enabled: true, start: '12:00', end: '14:00', days: ['wed'] }
  assert.equal(inDndWindow(lunchBreak, 'Asia/Shanghai', new Date('2026-11-18T03:59:00Z')), false)
  assert.equal(inDndWindow(lunchBreak, 'Asia/Shanghai', new Date('2026-11-18T04:00:00Z')), true)
  assert.equal(inDndWindow(lunchBreak, 'Asia/Shanghai', new Date('2026-11-18T06:00:00Z')), false)

  // Null / invalid timezone falls back to UTC cleanly; disabled or empty days never suppress.
  assert.equal(inDndWindow(overnightAllDays, null, new Date('2026-11-21T23:00:00Z')), true)
  assert.equal(inDndWindow(overnightAllDays, 'Invalid/Zone', new Date('2026-11-21T12:00:00Z')), false)
  assert.equal(inDndWindow(DEFAULT_DND_SCHEDULE, 'UTC', new Date('2026-11-21T23:00:00Z')), false)
  assert.equal(inDndWindow({ ...overnightAllDays, days: [] }, 'UTC', new Date('2026-11-21T23:00:00Z')), false)
})

test('channel x category overrides decouple mobile and desktop while falling back to user_preferences', () => {
  const legacyFinishedOff = { ...DEFAULT_PREFERENCES, pushFinished: false, pushDecide: true }
  // Unset override falls back to legacy pushFinished=false
  assert.equal(pushAllowed(legacyFinishedOff, ['finished'], { overrides: { finished: null } }), false)
  // Explicit per-channel override=true wins over legacy pushFinished=false
  assert.equal(pushAllowed(legacyFinishedOff, ['finished'], { overrides: { finished: true } }), true)
  // Explicit per-channel override=false wins over legacy pushDecide=true
  assert.equal(pushAllowed(legacyFinishedOff, ['decide'], { overrides: { decide: false } }), false)
  // Active DND suppresses even when override=true
  assert.equal(pushAllowed(DEFAULT_PREFERENCES, ['decide'], {
    overrides: { decide: true },
    dnd: { enabled: true, start: '22:00', end: '08:00', days: DND_DAYS },
    timeZone: 'UTC',
    now: new Date('2026-11-21T23:30:00Z'),
  }), false)

  const candidates: DesktopCandidate[] = [
    { id: '1', kind: 'awaiting', title: 'Need input', agent: 'Codex' },
    { id: '2', kind: 'failed', title: 'Build failed', agent: 'Codex' },
    { id: '3', kind: 'finished', title: 'Done', agent: 'Codex' },
  ]
  assert.equal(desktopCandidateReason('awaiting'), 'decide')
  assert.equal(desktopCandidateReason('failed'), 'decide')
  assert.equal(desktopCandidateReason('finished'), 'finished')

  assert.deepEqual(
    filterDesktopCandidates(candidates, { overrides: { decide: false }, finishedAllowed: true }).map(c => c.id),
    ['3'],
  )
  assert.deepEqual(
    filterDesktopCandidates(candidates, { overrides: { decide: true }, legacyDecide: false, finishedAllowed: false }).map(c => c.id),
    ['1', '2'],
  )
  assert.deepEqual(
    filterDesktopCandidates(candidates, {
      dnd: { enabled: true, start: '22:00', end: '08:00', days: DND_DAYS },
      timeZone: 'UTC',
      now: new Date('2026-11-21T01:00:00Z'),
    }),
    [],
  )
})
