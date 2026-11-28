import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  environmentInstructionsScope,
  type EnvironmentConfiguration,
  type EnvironmentRepository,
  projectRepositoryKey,
} from './contracts'

export const snapshotInput = environmentInstructionsScope
  .extend({
    templateKind: z.enum(['claude', 'codex']),
    provider: z.enum(['e2b', 'cloudflare']).optional(),
  })
  .strict()
export type SnapshotInput = z.infer<typeof snapshotInput>
export type SnapshotSeed = SnapshotInput & { userId: string; revision: number; templateId: string; workerSha: string }
export type SnapshotState = 'building' | 'failed' | 'ready' | 'outdated'
export type SnapshotView = {
  id: string
  revision: number
  templateKind: SnapshotInput['templateKind']
  state: SnapshotState
  logTail: string
  expiresAt: string
}

export function repositorySeed(key: string) {
  const normalized = projectRepositoryKey.parse(key)
  if (!normalized.startsWith('v2/github.com/')) throw new Error('Repository host unavailable for snapshot build')
  return {
    remote: 'https://' + normalized.slice(3) + '.git',
    directory: '/home/user/.mikka/worker/repos/v2/' + createHash('sha256').update(normalized).digest('hex'),
  }
}

/** An arbitrary shell command can copy even a command-scoped secret into a file.
 * Credential-bearing setup only runs on the individual task VM. */
export function eligibleConfiguration(
  configuration: EnvironmentConfiguration,
  rows: EnvironmentRepository[],
  policy: { mode: string; repositoryKeys: string[] },
) {
  return (
    configuration.runtime !== 'local' &&
    !configuration.secretIds.length &&
    !['none', 'restricted'].includes(configuration.networkAccess ?? '') &&
    rows
      .filter((row) => row.clone === 'start')
      .every(
        (row) =>
          row.key.startsWith('v2/github.com/') &&
          (policy.mode !== 'restricted' || policy.repositoryKeys.includes(row.key)),
      )
  )
}
