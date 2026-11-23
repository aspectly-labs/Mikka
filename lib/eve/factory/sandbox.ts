import type { SandboxPrepareContext, SandboxSessionContext, SandboxSessionEndOptions } from 'eve/sandbox/provider'
import { scopeFromAuth } from '../scope'
import { eveFactorySessionAuth } from './session'

type Artifact = { version: 2; kind: 'eve-factory' }
type State = { version: 1; runId: string; operationId: string; ownerId: string; workspaceId: string }

/**
 * #3082: sandbox provider for Factory role sessions. Each role turn opens the
 * run's sponsored Cloudflare task machine through the grant machinery — the
 * session's tools run inside that workspace — and `onSessionEnd` parks it, so
 * a completed or waiting turn holds no container. The implementer's git
 * credentials are delivered host-side into the worktree only for that role;
 * analyst/reviewer sessions never receive them.
 */
const live = new Map<string, { connection: { close?: () => Promise<unknown>; stop?: () => Promise<unknown> }; state: State }>()

export function createEveFactorySandboxProvider() {
  return {
    async prepare(_ctx: SandboxPrepareContext): Promise<Artifact> {
      // Role sessions bind the admitted task workspace, not the scratch
      // template — there is nothing to populate ahead of time.
      return { version: 2, kind: 'eve-factory' }
    },
    async start(ctx: SandboxSessionContext, _options: undefined, artifact: Readonly<Artifact>) {
      if (artifact.version !== 2 || artifact.kind !== 'eve-factory') throw new Error('operationBindingConflict')
      const scope = scopeFromAuth(ctx.session.auth.current ?? ctx.session.auth.initiator)
      const factory = eveFactorySessionAuth(ctx.session.auth.current ?? ctx.session.auth.initiator)
      if (!factory) throw new Error('eveFactorySessionUnavailable')
      const { pool } = await import('../../db')
      const { openEveFactoryMachine } = await import('./machine')
      const opened = await openEveFactoryMachine(pool, { userId: scope.ownerId, workspaceId: scope.workspaceId }, factory.runId)
      if (factory.role === 'implementer') {
        // Host-side credential delivery: the machine's own .git-credentials,
        // never an agent-visible env or tool input. The file is excluded from
        // workspace checkpoints by the task DO.
        const { rows: [repo] } = await pool.query<{ repoPath: string }>(
          `SELECT repo."repoPath" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId" WHERE r.id=$1 AND r."userId"=$2`,
          [factory.runId, scope.ownerId])
        const { githubMachineCredential } = await import('../../github/machine-credential')
        const credential = await githubMachineCredential(scope.ownerId, { remoteKey: repo?.repoPath })
        await opened.connection.writeFiles({
          files: [{ path: '/workspace/.git-credentials', content: new TextEncoder().encode(`https://x-access-token:${credential.token}@github.com\n`) }],
        })
        const identity = await opened.connection.spawn({ command: 'git config --global credential.helper store && git config --global user.name mikka-factory && git config --global user.email factory@mikka.local', workingDirectory: '/workspace', env: {} })
        await identity.wait()
      }
      const state: State = { version: 1, runId: factory.runId, operationId: opened.operationId, ownerId: scope.ownerId, workspaceId: scope.workspaceId }
      live.set(ctx.session.id, { connection: opened.connection as never, state })
      return { connection: opened.connection, state }
    },
    async resume(ctx: SandboxSessionContext, _artifact: Readonly<Artifact>, state: Readonly<State>) {
      const scope = scopeFromAuth(ctx.session.auth.current ?? ctx.session.auth.initiator)
      const factory = eveFactorySessionAuth(ctx.session.auth.current ?? ctx.session.auth.initiator)
      if (!factory || factory.runId !== state.runId || state.ownerId !== scope.ownerId || state.workspaceId !== scope.workspaceId) {
        throw new Error('workspaceAccessDenied')
      }
      const { pool } = await import('../../db')
      const { openEveFactoryMachine } = await import('./machine')
      const opened = await openEveFactoryMachine(pool, { userId: scope.ownerId, workspaceId: scope.workspaceId }, factory.runId)
      live.set(ctx.session.id, { connection: opened.connection as never, state: { ...state, operationId: opened.operationId } })
      return opened.connection
    },
    async onSessionEnd(ctx: SandboxSessionContext, state: Readonly<State> | null, _options: SandboxSessionEndOptions) {
      const held = live.get(ctx.session.id)
      const settled = state ?? held?.state ?? null
      live.delete(ctx.session.id)
      if (!settled) {
        if (held?.connection.close) await held.connection.close().catch(() => {})
        return
      }
      const { pool } = await import('../../db')
      const { captureEveFactoryHostEvidence, releaseEveFactoryMachine } = await import('./machine')
      try {
        if (held?.connection) {
          // Host-owned run evidence while the machine is still open and its
          // git credential is warm: the pushed-branch ref, the worktree head,
          // the untouched working tree and the frozen verify command's real
          // exit. The settlement later reads only these persisted facts.
          const { rows: [evidenceInput] } = await pool.query<{
            branch: string | null; verifyCommand: string | null; attemptId: string
          }>(
            `SELECT p.branch, a.output#>>'{check,command}' AS "verifyCommand", a.id AS "attemptId"
             FROM factory_attempts a LEFT JOIN run_publications p ON p."runId"=a."runId"
             WHERE a."runId"=$1 LIMIT 1`,
            [settled.runId],
          )
          if (evidenceInput) {
            const host = await captureEveFactoryHostEvidence(held.connection as never, {
              branch: evidenceInput.branch, verifyCommand: evidenceInput.verifyCommand,
            }).catch(() => null)
            if (host) await pool.query(
              `UPDATE factory_attempts SET output = output || $3::jsonb WHERE id=$1 AND "runId"=$2`,
              [evidenceInput.attemptId, settled.runId, JSON.stringify({ eveFactoryHost: host })],
            )
          }
        }
      } catch { /* capture is best-effort; settlement degrades honestly */ }
      if (held?.connection.close) await held.connection.close().catch(() => {})
      await releaseEveFactoryMachine(pool, { userId: settled.ownerId, workspaceId: settled.workspaceId }, settled.runId, settled.operationId).catch(() => {})
    },
  }
}
