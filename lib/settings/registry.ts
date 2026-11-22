import { z } from 'zod'
import { gitAuthorEmailSchema, gitAuthorNameSchema } from '@mikka/protocol/device'
import type { ResolvedSetting, SettingSchemaEntry, SettingScope, SettingValue } from '@mikka/protocol/settings'
import { archiveIdleDays } from '@/lib/conversation-directory-input'
import { DEFAULT_DND_SCHEDULE, DND_DAYS, DND_TIME_PATTERN, NOTIFICATION_SOUNDS } from '@/lib/push-allowed'
import { DEFAULT_TITLE_TRIGGERS, THREAD_TITLE_TRIGGERS, TITLE_INSTRUCTIONS_MAX } from '@/lib/thread-title'
import { settingMetadata } from './metadata'

export interface SettingDefinition extends SettingSchemaEntry {
  guard: z.ZodType<SettingValue>
  /** Existing account preferences stay global; title overrides belong to one workspace. */
  personalContext: 'account' | 'workspace'
}

const inherited = {
  scope: ['personal', 'workspace'] as SettingScope[], personalOverride: true,
  writeAccess: { personal: 'owner', workspace: 'admin' } as const,
}

const personalAccount = {
  scope: ['personal'] as SettingScope[], personalOverride: true,
  writeAccess: { personal: 'owner' } as const, personalContext: 'account' as const,
}

const dndDaysGuard = z.array(z.enum(DND_DAYS)).max(7).refine(days => new Set(days).size === days.length, { message: 'Duplicate days' })

/** Adding a scalar field here gives it validation, typed persistence, reset and schema search. */
export const SETTINGS_REGISTRY = {
  archiveIdleAfterDays: {
    ...inherited, key: 'archiveIdleAfterDays', group: 'threads', page: 'threads',
    ...settingMetadata('archiveIdleAfterDays'),
    type: 'integer', guard: z.literal(archiveIdleDays), defaultValue: 30, options: [...archiveIdleDays],
    personalContext: 'account',
  },
  threadTitleInstructions: {
    ...inherited, key: 'threadTitleInstructions', group: 'threads', page: 'threads',
    ...settingMetadata('threadTitleInstructions'),
    type: 'string', guard: z.string().trim().max(TITLE_INSTRUCTIONS_MAX), defaultValue: '',
    personalContext: 'workspace',
  },
  threadTitleTriggers: {
    ...inherited, key: 'threadTitleTriggers', group: 'threads', page: 'threads',
    ...settingMetadata('threadTitleTriggers'),
    type: 'string', guard: z.enum(THREAD_TITLE_TRIGGERS), defaultValue: DEFAULT_TITLE_TRIGGERS, options: [...THREAD_TITLE_TRIGGERS],
    personalContext: 'workspace',
  },
  gitAuthorName: {
    ...inherited, key: 'gitAuthorName', group: 'git', page: 'git',
    ...settingMetadata('gitAuthorName'),
    type: 'string', guard: gitAuthorNameSchema, defaultValue: '',
    personalContext: 'workspace',
  },
  gitAuthorEmail: {
    ...inherited, key: 'gitAuthorEmail', group: 'git', page: 'git',
    ...settingMetadata('gitAuthorEmail'),
    type: 'string', guard: gitAuthorEmailSchema, defaultValue: '',
    personalContext: 'workspace',
  },
  subagentMaxConcurrent: {
    key: 'subagentMaxConcurrent', scope: ['workspace'], group: 'threads', page: 'threads',
    ...settingMetadata('subagentMaxConcurrent'),
    type: 'integer', guard: z.number().int().min(1).max(20), defaultValue: 6,
    personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace',
  },
  protectManualThreadTitles: {
    ...inherited, key: 'protectManualThreadTitles', group: 'threads', page: 'threads',
    ...settingMetadata('protectManualThreadTitles'),
    type: 'boolean', guard: z.boolean(), defaultValue: true, personalContext: 'workspace',
  },
  keepPinnedThreadsActive: {
    ...inherited, key: 'keepPinnedThreadsActive', group: 'threads', page: 'threads',
    ...settingMetadata('keepPinnedThreadsActive'),
    type: 'boolean', guard: z.boolean(), defaultValue: true, personalContext: 'workspace',
  },
  memoryAutoApprove: {
    ...personalAccount, key: 'memoryAutoApprove', group: 'memory', page: 'instructions',
    ...settingMetadata('memoryAutoApprove'),
    type: 'boolean', guard: z.boolean(), defaultValue: false,
  },
  dndEnabled: {
    ...personalAccount, key: 'dndEnabled', group: 'notifications', page: 'notifications',
    ...settingMetadata('dndEnabled'),
    type: 'boolean', guard: z.boolean(), defaultValue: DEFAULT_DND_SCHEDULE.enabled,
  },
  dndStart: {
    ...personalAccount, key: 'dndStart', group: 'notifications', page: 'notifications',
    ...settingMetadata('dndStart'),
    type: 'string', guard: z.string().regex(DND_TIME_PATTERN), defaultValue: DEFAULT_DND_SCHEDULE.start,
  },
  dndEnd: {
    ...personalAccount, key: 'dndEnd', group: 'notifications', page: 'notifications',
    ...settingMetadata('dndEnd'),
    type: 'string', guard: z.string().regex(DND_TIME_PATTERN), defaultValue: DEFAULT_DND_SCHEDULE.end,
  },
  dndDays: {
    ...personalAccount, key: 'dndDays', group: 'notifications', page: 'notifications',
    ...settingMetadata('dndDays'),
    type: 'string-array', guard: dndDaysGuard, defaultValue: [...DEFAULT_DND_SCHEDULE.days], options: [...DND_DAYS],
  },
  notifyMobileDecide: {
    ...personalAccount, key: 'notifyMobileDecide', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyMobileDecide'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyMobileReview: {
    ...personalAccount, key: 'notifyMobileReview', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyMobileReview'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyMobileFinished: {
    ...personalAccount, key: 'notifyMobileFinished', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyMobileFinished'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyMobileBriefing: {
    ...personalAccount, key: 'notifyMobileBriefing', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyMobileBriefing'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyDesktopDecide: {
    ...personalAccount, key: 'notifyDesktopDecide', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyDesktopDecide'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyDesktopReview: {
    ...personalAccount, key: 'notifyDesktopReview', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyDesktopReview'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyDesktopFinished: {
    ...personalAccount, key: 'notifyDesktopFinished', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyDesktopFinished'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyDesktopBriefing: {
    ...personalAccount, key: 'notifyDesktopBriefing', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyDesktopBriefing'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notifyEmailInvitations: {
    ...personalAccount, key: 'notifyEmailInvitations', group: 'notifications', page: 'notifications',
    ...settingMetadata('notifyEmailInvitations'),
    type: 'boolean', guard: z.boolean(), defaultValue: true,
  },
  notificationSound: {
    ...personalAccount, key: 'notificationSound', group: 'notifications', page: 'notifications',
    ...settingMetadata('notificationSound'),
    type: 'string', guard: z.enum(NOTIFICATION_SOUNDS), defaultValue: 'default', options: [...NOTIFICATION_SOUNDS],
  },
} satisfies Record<string, SettingDefinition>

export type SettingKey = keyof typeof SETTINGS_REGISTRY
export type SettingValueFor<K extends SettingKey> = z.output<(typeof SETTINGS_REGISTRY)[K]['guard']>

export function personalSettingWorkspace(field: Pick<SettingDefinition, 'personalContext'>, workspaceId: string): string | null {
  return field.personalContext === 'workspace' ? workspaceId : null
}

const STORED_COLUMN = { integer: '"integerValue"', boolean: '"booleanValue"', string: '"textValue"', 'string[]': '"textArrayValue"' } as const

/** One resolution rule for a query: the member's own value, then the workspace's, then the
 * registry default. `owner` and `workspace` are the caller's own placeholders. */
export function resolvedSettingSql(key: SettingKey, owner: string, workspace: string): string {
  const field = SETTINGS_REGISTRY[key]
  const column = STORED_COLUMN[field.type as keyof typeof STORED_COLUMN]
  const scope = personalSettingWorkspace(field, workspace) ?? 'NULL'
  const fallback = typeof field.defaultValue === 'string' ? `'${field.defaultValue.replaceAll("'", "''")}'` : String(field.defaultValue)
  return `coalesce((SELECT ${column} FROM personal_setting_values
      WHERE "userId"=${owner} AND "workspaceId" IS NOT DISTINCT FROM ${scope}::uuid AND key='${key}'),
    (SELECT ${column} FROM workspace_setting_values WHERE "workspaceId"=${workspace} AND key='${key}'),
    ${fallback})`
}

export function settingDefinition(key: string): SettingDefinition {
  if (!Object.hasOwn(SETTINGS_REGISTRY, key)) throw new z.ZodError([{ code: 'custom', path: [key], message: 'Unknown setting' }])
  return SETTINGS_REGISTRY[key as SettingKey]
}

export const settingsPatchInput = z.strictObject({ values: z.record(z.string().min(1).max(120), z.unknown()) })
export const settingsResetInput = z.strictObject({ group: z.string().min(1).max(100) })

/** Re-parse with each field's own guard even when a typed client already validated its input. */
export function parseSettingsPatch(scope: SettingScope, raw: unknown): Record<string, SettingValue | null> {
  const { values } = settingsPatchInput.parse(raw)
  if (!Object.keys(values).length || Object.keys(values).length > 100) throw new z.ZodError([{ code: 'custom', path: ['values'], message: 'Empty or oversized settings patch' }])
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const field = settingDefinition(key)
    if (!field.writeAccess[scope] || !field.scope.includes(scope) || (scope === 'personal' && !field.personalOverride)) {
      throw new z.ZodError([{ code: 'custom', path: ['values', key], message: 'Setting cannot be written in this scope' }])
    }
    return [key, value === null ? null : field.guard.parse(value)]
  }))
}

/** Null alone means inherit; false, zero and empty strings remain explicit overrides. */
export function resolveSettingValue(key: string, personal: SettingValue | null | undefined, workspace: SettingValue | null | undefined): ResolvedSetting {
  const field = settingDefinition(key)
  if (field.personalOverride && field.scope.includes('personal') && personal != null) return { value: field.guard.parse(personal), source: 'personal' }
  if (field.scope.includes('workspace') && workspace != null) return { value: field.guard.parse(workspace), source: 'workspace' }
  return { value: field.guard.parse(field.defaultValue), source: 'default' }
}

export function settingsSchema(): SettingSchemaEntry[] {
  return Object.values(SETTINGS_REGISTRY).map(({ guard: _guard, personalContext: _context, ...entry }: SettingDefinition) => entry)
}
