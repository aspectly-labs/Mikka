import 'server-only'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import type { ResolvedSetting, SettingScope } from '@mikka/protocol/settings'
import type { db } from '@/lib/db'
import { personalSettingWorkspace, resolveSettingValue, SETTINGS_REGISTRY, type SettingKey, type SettingValueFor } from './registry'
import type { personalSettingValues } from './schema'

type Reader = Pick<typeof db, 'execute'> | Pick<PoolClient, 'query'>
export type StoredSettingValue = Pick<typeof personalSettingValues.$inferSelect, 'booleanValue' | 'integerValue' | 'textValue' | 'textArrayValue'>
type Row = StoredSettingValue & { scope: SettingScope; key: string; workspaceId: string | null }
type ResolvedSettings<K extends SettingKey> = { [Key in K]: ResolvedSetting<SettingValueFor<Key>> }

function unpack(row?: Row) {
  return row?.booleanValue ?? row?.integerValue ?? row?.textValue ?? row?.textArrayValue ?? null
}

export async function readRuntimeSettings<K extends SettingKey>(reader: Reader, keys: readonly K[],
  context: { userId?: string; workspaceId: string }): Promise<ResolvedSettings<K>> {
  const selectKeys = sql.join(keys.map(key => sql`${key}`), sql`, `)
  const columns = sql`key,"workspaceId","booleanValue","integerValue","textValue","textArrayValue"`
  const statement = sql`SELECT 'workspace' AS scope,${columns} FROM workspace_setting_values
    WHERE "workspaceId"=${context.workspaceId} AND key IN (${selectKeys})`
  if (context.userId) statement.append(sql`
    UNION ALL SELECT 'personal' AS scope,${columns} FROM personal_setting_values
    WHERE "userId"=${context.userId} AND ("workspaceId"=${context.workspaceId} OR "workspaceId" IS NULL)
      AND key IN (${selectKeys})`)
  const { rows } = keys.length === 0 ? { rows: [] as Row[] } : 'execute' in reader
    ? await reader.execute<Row>(statement)
    : await (() => {
      const { sql: text, params } = new PgDialect().sqlToQuery(statement)
      return reader.query<Row>(text, params)
    })()
  return Object.fromEntries(keys.map(key => {
    const ownWorkspace = personalSettingWorkspace(SETTINGS_REGISTRY[key], context.workspaceId)
    const personal = rows.find(row => row.key === key && row.scope === 'personal' && row.workspaceId === ownWorkspace)
    const workspace = rows.find(row => row.key === key && row.scope === 'workspace')
    return [key, resolveSettingValue(key, unpack(personal), unpack(workspace))]
  })) as ResolvedSettings<K>
}


type Query = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

/** Runtime callers must already hold their workspace admission; use their current database/transaction. */
export async function readRuntimeSetting<K extends SettingKey>(database: Query, key: K, context: { userId: string; workspaceId: string }): Promise<ResolvedSetting<SettingValueFor<K>>> {
  const field = SETTINGS_REGISTRY[key]
  const { rows } = await database.query(`SELECT 'personal' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM personal_setting_values WHERE "userId"=$1 AND "workspaceId" IS NOT DISTINCT FROM $3::uuid AND key=$4
    UNION ALL SELECT 'workspace' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM workspace_setting_values WHERE "workspaceId"=$2 AND key=$4`,
  [context.userId, context.workspaceId, personalSettingWorkspace(field, context.workspaceId), key])
  const value = (scope: SettingScope) => unpack(rows.find(row => row.scope === scope) as Row | undefined)
  return resolveSettingValue(key, value('personal'), value('workspace')) as ResolvedSetting<SettingValueFor<K>>
}

/** Held through commit, including when the workspace still uses its default. */
export async function lockSkillPublishingPolicy(database: Query, context: { userId: string; workspaceId: string }) {
  await database.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', ['skill-publishing:' + context.workspaceId])
  return readRuntimeSetting(database, 'skillPublishingPolicy', context)
}
