import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeManager } from '../../packages/daemon/src/worktrees'

const execute = promisify(execFile)
const [root, source, runId, mode] = process.argv.slice(2)
if (!root || !source || !runId || !['write', 'verify'].includes(mode)) throw new Error('Invalid daemon workspace fixture')
const worktrees = new WorktreeManager(join(root, 'worktrees'), false, true)
const repository = join(root, 'fixture-clone')
await mkdir(root, { recursive: true })
await execute('git', ['clone', '--no-local', '--single-branch', '--branch', 'main', source, repository])
const git = (...args: string[]) => execute('git', args, { cwd: repository })
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk)
const receipt = JSON.parse(Buffer.concat(chunks).toString())
const base = receipt ? await worktrees.portableWorktreeBase(repository, 'refs/remotes/origin/main', receipt.headSha) : 'refs/remotes/origin/main'
const checkout = await worktrees.create(runId, repository, base)
if (receipt) await worktrees.restorePortableWorkspace(runId, receipt, base)
if (mode === 'write') {
  await writeFile(join(checkout, 'tracked.txt'), 'source tracked edit\n')
  await writeFile(join(checkout, 'untracked.bin'), Buffer.from([0, 13, 10, 255, 128]))
  await writeFile(join(checkout, '.env.local'), 'LOCAL_ONLY=fixture-private\n')
}
assert.equal(await readFile(join(checkout, 'tracked.txt'), 'utf8'), 'source tracked edit\n')
assert.deepEqual(await readFile(join(checkout, 'untracked.bin')), Buffer.from([0, 13, 10, 255, 128]))
if (mode === 'verify') {
  await assert.rejects(readFile(join(checkout, '.env.local')), { code: 'ENOENT' })
  assert.equal((await git('remote', 'get-url', 'origin')).stdout.trim(), source)
}
