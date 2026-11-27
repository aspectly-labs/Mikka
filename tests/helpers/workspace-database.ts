import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { observePoolCommits } from '../../lib/db/commit-effects'

/** A single-process PG suite owns and validates its target before calling this.
 * Point the real canonical Workspace executor at that same isolated database /
 * schema. No query, connection method or authorization result is replaced. */
export async function bindFixtureWorkspaceDatabase(source: Pool) {
  const connectionString = source.options.connectionString
  assert.ok(connectionString, 'the fixture must explicitly own its database target')
  const target = new URL(connectionString)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'fixture workspace target must be loopback')
  observePoolCommits(source)
  const { workspacePool } = await import('../../lib/workspace-db')
  assert.equal(workspacePool.totalCount, 0, 'configure the Workspace pool before its first connection')
  assert.equal(workspacePool.waitingCount, 0, 'no other suite may be using this process pool')
  const previous = { connectionString: workspacePool.options.connectionString, options: workspacePool.options.options }
  workspacePool.options.connectionString = connectionString
  workspacePool.options.options = source.options.options
  let closed = false
  return async () => {
    if (closed) return
    closed = true
    try { await workspacePool.end() }
    finally {
      workspacePool.options.connectionString = previous.connectionString
      workspacePool.options.options = previous.options
    }
  }
}

/** Minimal real tables for standalone (non-Organization) claim fixtures. Full
 * migration suites use their own schema instead. Membership rows are queried
 * and locked by production withTaskWorkspace, including suspension checks.
 * The empty Org link table lets the same fixture run against the P2 gate; it
 * supplies no Organization, SSO assurance or bypass for an attached workspace. */
export async function createFixtureWorkspaceTables(pool: Pick<Pool, 'query'>) {
  await pool.query(`
    CREATE TABLE mikka_workspaces (
      id uuid PRIMARY KEY, "userId" text NOT NULL, name varchar(120) NOT NULL,
      slug varchar(64) UNIQUE, icon text, kind text NOT NULL DEFAULT 'team',
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "requireTwoFactor" boolean, "twoFactorRequiredAt" timestamptz
    );
    CREATE TABLE mikka_workspace_members (
      "workspaceId" uuid NOT NULL, "userId" text NOT NULL, name text NOT NULL,
      email text NOT NULL, role text NOT NULL, status text NOT NULL DEFAULT 'active',
      "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("workspaceId","userId")
    );
    CREATE TABLE mikka_organization_workspaces (
      "workspaceId" uuid PRIMARY KEY REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
      "organizationId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
    );
  `)
}

/** The same, for the app database executor (`@/lib/db`): a fixture that keeps
 * every table in one isolated schema reads app tables (e.g. `bots`) there too. */
export async function bindFixtureAppDatabase(source: Pool) {
  const connectionString = source.options.connectionString
  assert.ok(connectionString, 'the fixture must explicitly own its database target')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname), 'fixture app target must be loopback')
  const { currentDatabasePool } = await import('../../lib/db/request-scope')
  const appPool = currentDatabasePool()
  assert.equal(appPool.totalCount, 0, 'configure the app pool before its first connection')
  const previous = { connectionString: appPool.options.connectionString, options: appPool.options.options }
  appPool.options.connectionString = connectionString
  appPool.options.options = source.options.options
  let closed = false
  return async () => {
    if (closed) return
    closed = true
    try { await appPool.end() }
    finally {
      appPool.options.connectionString = previous.connectionString
      appPool.options.options = previous.options
    }
  }
}
