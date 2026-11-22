import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { ActionFailureError } from './action-error'
import type { RequestWorkspaceUser } from './request-workspace'

// #2938 (1): a connected subscription's model list — what the account
// answered last, each model's LiteLLM presence and its enabled flag.

type ConnectionRow = {
  id: string; workspaceId: string; provider: string; epoch: string
  modelCatalog: { models?: string[] } | null
  modelSettings: { models?: Record<string, { enabled?: boolean }> } | null
}

async function ownedConnection(user: RequestWorkspaceUser, connectionId: string): Promise<ConnectionRow> {
  if (!z.uuid().safeParse(connectionId).success) throw new ActionFailureError('executionAccountUnavailable')
  const { rows: [connection] } = await pool.query<ConnectionRow>(
    `SELECT id,"workspaceId",provider,epoch,"modelCatalog","modelSettings" FROM byos_connections
     WHERE id=$1 AND "ownerId"=$2 AND state='connected' AND "removedAt" IS NULL`,
    [connectionId, user.id])
  if (!connection) throw new ActionFailureError('executionAccountUnavailable')
  return connection
}

export interface ConnectionModelEntry { id: string; known: boolean; enabled: boolean }

/** The connection's offered models plus ids the owner typed in (`按-id-添加`), marked known/enabled. */
export async function connectionModels(user: RequestWorkspaceUser, connectionId: string): Promise<ConnectionModelEntry[]> {
  const connection = await ownedConnection(user, connectionId)
  const discovered = Array.isArray(connection.modelCatalog?.models) ? connection.modelCatalog.models : []
  const settings = connection.modelSettings?.models ?? {}
  const ids = [...new Set([...discovered, ...Object.keys(settings)])]
  const { modelCatalog } = await import('./model-catalog-server')
  const catalogue = new Set((await modelCatalog()).map(model => model.id))
  return ids.map(id => ({ id, known: catalogue.has(id), enabled: settings[id]?.enabled !== false }))
}

/** Flip `modelSettings.models.<id>.enabled` per id; unknown ids join the owner's manual candidates. */
export async function setConnectionModels(user: RequestWorkspaceUser, connectionId: string, updates: Record<string, boolean>): Promise<ConnectionModelEntry[]> {
  const connection = await ownedConnection(user, connectionId)
  for (const [id, enabled] of Object.entries(updates)) {
    if (!z.string().trim().min(1).max(128).safeParse(id).success || typeof enabled !== 'boolean')
      throw new ActionFailureError('executionModelUnknown')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [current] } = await client.query<ConnectionRow>(
      `SELECT "modelSettings" FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND epoch=$3 FOR UPDATE`,
      [connectionId, user.id, connection.epoch])
    if (!current) throw new ActionFailureError('executionAccountUnavailable')
    const models = { ...(current.modelSettings?.models ?? {}) }
    for (const [id, enabled] of Object.entries(updates)) models[id] = { ...(models[id] ?? {}), enabled }
    await client.query(`UPDATE byos_connections SET "modelSettings"=$2::jsonb WHERE id=$1`,
      [connectionId, JSON.stringify({ ...(current.modelSettings ?? {}), models })])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return connectionModels(user, connectionId)
}

/** Manual re-probe: asks the account for its models through LiteLLM, like connect/key-change does. */
export async function refreshConnectionModels(user: RequestWorkspaceUser, connectionId: string): Promise<unknown> {
  const connection = await ownedConnection(user, connectionId)
  const { ExecutionSettings } = await import('./execution-settings')
  const settings = new ExecutionSettings(pool)
  await settings.refreshBotModels({ ownerId: user.id, workspaceId: connection.workspaceId }, connectionId)
  return connectionModels(user, connectionId)
}
