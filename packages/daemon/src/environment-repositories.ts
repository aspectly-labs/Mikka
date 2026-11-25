import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { normalizeRepository } from '@mikka/protocol/repository'
import { assertBranchName } from './agents/publish'
import { preparedTokenEnvironment } from './agents/github-runtime'
import { FETCH_GIT, FETCH_TIMEOUT_MS } from './worktrees'
import type { RunAssignment } from './server-link'

type StartupRepository = NonNullable<NonNullable<RunAssignment['projectEnvironment']>['startupRepositories']>[number]

/** Only this invocation owns the new directory. Never reuse credential or Git configuration from a previous checkout. */
export async function checkoutEnvironmentRepositories(root: string, repositories: StartupRepository[],
  readToken: (key: string) => Promise<string>, signal: AbortSignal) {
  await mkdir(root, { mode: 0o700 })
  try {
    for (const { key, baseBranch } of repositories) {
      signal.throwIfAborted()
      const prefix = 'v2/github.com/'
      const repo = normalizeRepository(key.slice(prefix.length))
      if (!key.startsWith(prefix) || repo.key !== key) throw new Error('Invalid environment repository')
      if (baseBranch) await assertBranchName(baseBranch, signal)
      const [owner, name] = key.slice(prefix.length).split('/')
      const ownerDirectory = join(root, owner!)
      await mkdir(ownerDirectory, { recursive: true, mode: 0o700 })
      const token = await readToken(key)
      try {
        await execa('git', [...FETCH_GIT, '-c', 'protocol.file.allow=never', 'clone', '--depth=1', '--no-tags',
          '--no-recurse-submodules', ...(baseBranch ? ['--branch', baseBranch] : []), '--', repo.remoteUrl, join(ownerDirectory, name!)],
        { env: preparedTokenEnvironment(token), stdin: 'ignore', cancelSignal: signal, killDescendants: true, timeout: FETCH_TIMEOUT_MS })
      } catch {
        // error-cause: a Git transport error can carry credential diagnostics.
        throw new Error('Environment repository checkout failed')
      }
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return () => rm(root, { recursive: true, force: true })
}
