import 'server-only'
import { Sandbox } from 'e2b'
import type { PoolClient } from 'pg'
import { workspacePool } from '@/lib/workspace-db'
import { withDirectSession } from '@/lib/db/direct-session'
import { e2bApiKey } from '@/lib/secrets/e2b-runtime'
import { bootstrapOfficialInstance, isOfficialE2BTemplate } from '@/lib/computer/official-runtime'
import { quoteShell } from '@/lib/computer/registration-command'
import { threadLifecycleProvider } from '@/lib/cloud-computer/thread-lifecycle-provider'
import { serverFlagEnabled } from '@/lib/posthog-server'
import { githubRepositoryReadCredential } from '@/lib/github/user-access'
import { gatedFeatures } from '@/lib/feature-flags'
import { snapshotConfiguration } from './environment-snapshots'
import { repositorySeed, type SnapshotSeed, type SnapshotState } from './environment-snapshot-contract'

type Build = SnapshotSeed & {
  id: string
  state: SnapshotState
  providerId: string | null
  sandboxId: string | null
  expiresAt: Date
}
const options = async (owner: string) => ({
  apiKey: await e2bApiKey(owner, 'Cloud runtime unavailable'),
  proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
  requestTimeoutMs: 20_000,
})

// Serialize provider effects across workflow retries and repeated UI clicks.
// The direct session owns this lock until disconnect, including process loss.
async function withBuild<T>(id: string, work: (client: PoolClient, row: Build | undefined) => Promise<T>) {
  return withDirectSession(workspacePool, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['environment-snapshot:' + id])
    const row = (await client.query<Build>('SELECT * FROM environment_snapshots WHERE id=$1', [id])).rows[0]
    return work(client, row)
  })
}

async function retireImage(row: Build) {
  // Recover snapshots even if the create response was lost before its ID was recorded.
  const images = row.providerId
    ? [row.providerId]
    : row.sandboxId
      ? (await threadLifecycleProvider.listSnapshots(row.sandboxId, row.userId, 'mikka-env-' + row.id)).map(
          (item) => item.snapshotId,
        )
      : []
  for (const image of images) await threadLifecycleProvider.deleteSnapshot(image, row.userId)
}

async function finishSuperseded(row: Build) {
  const { rows } = await workspacePool.query<Build>(
    `SELECT * FROM environment_snapshots WHERE
    "workspaceId"=$1 AND "environmentId"=$2 AND "userId"=$3 AND "templateKind"=$4
    AND state='outdated' AND "providerId" IS NOT NULL`,
    [row.workspaceId, row.environmentId, row.userId, row.templateKind],
  )
  for (const old of rows) await expireEnvironmentSnapshot(old.id)
}

export async function expireEnvironmentSnapshot(id: string) {
  return withBuild(id, async (client, row) => {
    if (!row || (row.state !== 'outdated' && row.expiresAt > new Date())) return
    await retireImage(row)
    await client.query('DELETE FROM environment_snapshots WHERE id=$1', [id])
  })
}

async function allowed(row: Build) {
  if (
    !(await serverFlagEnabled(gatedFeatures.environmentSnapshots, row.userId)) ||
    row.workerSha !== process.env.MIKKA_CLOUD_WORKER_SHA
  )
    return null
  const { environment, eligible } = await snapshotConfiguration(row.userId, row)
  return eligible && environment.revision === row.revision ? environment : null
}

export async function buildEnvironmentSnapshot(id: string) {
  const result = await withBuild(id, async (client, row) => {
    if (!row) return null
    if (row.state !== 'building') {
      if (row.sandboxId) await Sandbox.kill(row.sandboxId, await options(row.userId))
      return row
    }
    // Different revisions or worker releases can build concurrently. Serialize
    // publication per owner and harness so an older workflow cannot retain two
    // ready images, or retire a later build that finished first.
    const publicationKey = JSON.stringify([row.workspaceId, row.environmentId, row.userId, row.templateKind])
    const name = 'mikka-env-' + id
    // Bounded progress diagnostics contain phase names and exit codes only.
    // Provider stderr can echo credentials or arbitrary setup environment values.
    const progress = ['configuration']
    const stage = (name: string) => {
      progress.push(name)
    }
    let providerId: string | undefined
    let sandboxId = row.sandboxId
    try {
      const environment = await allowed(row)
      if (!environment || row.expiresAt <= new Date()) {
        await client.query("UPDATE environment_snapshots SET state='outdated' WHERE id=$1", [id])
        return row
      }
      stage('create')
      const connection = await options(row.userId)
      // A lost snapshot response is recovered by its unique build name; never
      // snapshot a second, unrelated VM for the same receipt.
      const recovered = sandboxId ? await threadLifecycleProvider.listSnapshots(sandboxId, row.userId, name) : []
      if (recovered.length > 1) throw new Error('Ambiguous snapshot receipt')
      providerId = recovered[0]?.snapshotId
      if (!providerId) {
        const machine = await Sandbox.create(row.templateId, {
          ...connection,
          idempotencyKey: id,
          timeoutMs: 15 * 60_000,
          metadata: { application: 'mikka-environment-build', buildId: id },
        })
        sandboxId = machine.sandboxId
        await client.query('UPDATE environment_snapshots SET "sandboxId"=$2 WHERE id=$1', [id, sandboxId])
        if (isOfficialE2BTemplate(row.templateId)) await bootstrapOfficialInstance(machine, row.templateId)
        const sha = await machine.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
        if (sha.trim() !== row.workerSha) throw new Error('Worker release unavailable')
        stage('clone')
        const startRows = environment.repositories.filter((repo) => repo.clone === 'start')
        const directories: string[] = []
        const repositoryIds: Record<string, string> = {}
        for (const repo of startRows) {
          const { remote, directory } = repositorySeed(repo.key)
          const { token, repository } = await githubRepositoryReadCredential(row.userId, repo.key)
          repositoryIds[repo.key] = repository.id
          const headers = {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
          }
          const branch = repo.baseBranch ? '--branch ' + quoteShell(repo.baseBranch) : ''
          await machine.commands.run(
            `mkdir -p /home/user/.mikka/worker/repos/v2 && git -c credential.helper= -c http.followRedirects=false -c protocol.file.allow=never -c submodule.recurse=false clone --no-checkout --depth=50 --no-single-branch --no-recurse-submodules ${branch} -- ${quoteShell(remote)} ${quoteShell(directory)}`,
            { user: 'user', envs: { ...headers, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 90_000 },
          )
          const prepared = directory + '.environment-setup'
          await machine.commands.run(
            `git -C ${quoteShell(directory)} worktree add --detach -- ${quoteShell(prepared)} HEAD`,
            { user: 'user', timeoutMs: 90_000 },
          )
          directories.push(prepared)
        }
        await client.query('UPDATE environment_snapshots SET "repositoryIds"=$2::jsonb WHERE id=$1', [
          id,
          JSON.stringify(repositoryIds),
        ])
        stage('setup')
        const setup = environment.configuration.setup
        if (setup?.approved && setup.command) {
          // Run once in each repository just as a new task would; environment
          // variables are scoped to this command, never stored in E2B metadata.
          for (const cwd of directories.length ? directories : ['/home/user']) {
            await machine.commands.run(setup.command, {
              user: 'user',
              cwd,
              envs: environment.configuration.variables,
              timeoutMs: 180_000,
            })
          }
        }
        stage('snapshot')
        if (!(await allowed(row))) throw new Error('Environment revision changed')
        // Only the filesystem is reusable. Unlike per-thread recovery, do not
        // fall back to a full memory image with live setup processes.
        providerId = (await Sandbox.createSnapshot(sandboxId, { ...connection, name, mode: 'filesystem' })).snapshotId
      }
      await client.query('BEGIN')
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [publicationKey])
        await client.query(
          `UPDATE environment_snapshots SET state='ready',"logTail"='complete',"providerId"=$2 WHERE id=$1`,
          [id, providerId],
        )
        await client.query(
          `WITH candidates AS (
          SELECT id,row_number() OVER (ORDER BY revision DESC,"createdAt" DESC,id DESC) AS position
          FROM environment_snapshots WHERE "workspaceId"=$1 AND "environmentId"=$2 AND "userId"=$3 AND "templateKind"=$4 AND state='ready'
        ) UPDATE environment_snapshots SET state='outdated' WHERE id IN (SELECT id FROM candidates WHERE position>1)`,
          [row.workspaceId, row.environmentId, row.userId, row.templateKind],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'exitCode' in error ? error.exitCode : undefined
      if (typeof code === 'number' && Number.isSafeInteger(code)) progress.push('exit ' + code)
      // Raw command stderr and provider errors may contain setup variables. Only
      // persist the failed stage. A prior successful build remains selectable.
      await client.query(`UPDATE environment_snapshots SET state='failed',"logTail"=$2,"providerId"=$3 WHERE id=$1`, [
        id,
        progress.join('\n'),
        providerId ?? null,
      ])
    } finally {
      if (sandboxId) await Sandbox.kill(sandboxId, await options(row.userId))
    }
    return row
  })
  if (!result) return null
  await finishSuperseded(result)
  return result.expiresAt.toISOString()
}
