import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { execa } from 'execa'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => cleanupTempDirs())

it('executes approved environment setup with only the controlled task variables', async () => {
  const repo = await makeRepo()
  const manager = new WorktreeManager(tempDir())
  const worktree = await manager.create('environment-test', repo, 'main')
  const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('environment-proof.json',JSON.stringify({mode:process.env.FEATURE_MODE,reserved:process.env.MIKKA_INJECTED??null}))"`
  await manager.bootstrap(worktree, repo, { copyFiles: [], command, approved: true }, { FEATURE_MODE: 'project-config', MIKKA_INJECTED: 'blocked' })
  expect(JSON.parse(readFileSync(join(worktree, 'environment-proof.json'), 'utf8'))).toEqual({ mode: 'project-config', reserved: null })
})

it('does not execute an unapproved setup recipe', async () => {
  const repo = await makeRepo()
  const manager = new WorktreeManager(tempDir())
  const worktree = await manager.create('unapproved-environment', repo, 'main')
  await manager.bootstrap(worktree, repo, { copyFiles: [], command: 'touch unexpected', approved: false }, { FEATURE_MODE: 'project-config' })
  expect(existsSync(join(worktree, 'unexpected'))).toBe(false)
})

it('moves prebuilt dependencies into the task worktree and checks out the requested commit', async () => {
  const repo = await makeRepo()
  const manager = new WorktreeManager(tempDir())
  const prepared = repo + '.environment-setup'
  expect(await manager.createFromEnvironmentSnapshot('snapshot-run', repo, 'main')).toBeNull()
  try {
    await execa('git', ['worktree', 'add', '--detach', '--', prepared, 'HEAD'], { cwd: repo })
    writeFileSync(join(prepared, 'setup-ran'), 'built once')
    writeFileSync(join(repo, 'README.md'), 'new task base')
    await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'change base'], { cwd: repo })
    expect(await manager.createFromEnvironmentSnapshot('snapshot-run', repo, 'main')).toBeNull()
    const path = await manager.createFromEnvironmentSnapshot('snapshot-run', repo, 'main', true)
    expect(path).toBe(manager.pathFor('snapshot-run'))
    expect(readFileSync(join(path!, 'setup-ran'), 'utf8')).toBe('built once')
    expect(readFileSync(join(path!, 'README.md'), 'utf8')).toBe('new task base')
    expect(existsSync(prepared)).toBe(false)
  } finally {
    rmSync(prepared, { recursive: true, force: true })
  }
})


it('falls back to normal setup when a prepared worktree has a submodule', async () => {
  const repo = await makeRepo(), moduleRepo = await makeRepo()
  const prepared = repo + '.environment-setup'
  const manager = new WorktreeManager(tempDir())
  try {
    await execa('git', ['-c','protocol.file.allow=always','submodule','add',moduleRepo,'dependency'], {cwd:repo})
    await execa('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-am','submodule'], {cwd:repo})
    await execa('git', ['worktree','add','--detach','--',prepared,'HEAD'], {cwd:repo})
    await execa('git', ['-c','protocol.file.allow=always','submodule','update','--init'], {cwd:prepared})
    expect(await manager.createFromEnvironmentSnapshot('module-run',repo,'main')).toBeNull()
    expect(await manager.create('module-run',repo,'main')).toBe(manager.pathFor('module-run'))
  } finally { rmSync(prepared,{recursive:true,force:true}) }
})

it.skipIf(process.platform !== 'linux')('restores the authorized archived Git base after a fresh VM and rejects incomplete data', async () => {
  const { mkdirSync, copyFileSync, appendFileSync } = await import('node:fs')
  const { writeTaskArchive } = await import('../src/task-workspace-archive.mjs')
  const repo = await makeRepo()
  const first = new WorktreeManager(join(tempDir(), 'worktrees'), true, true)
  const source = await first.create('portable-old', repo, 'main')
  writeFileSync(join(source, 'committed.txt'), 'local commit content\n')
  await execa('git', ['add', 'committed.txt'], { cwd: source })
  await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'local-only'], { cwd: source })
  const { stdout: localHead } = await execa('git', ['rev-parse', 'HEAD'], { cwd: source })
  writeFileSync(join(source, 'README.md'), 'task edits\n')
  writeFileSync(join(source, 'binary'), Buffer.from([0, 13, 255, 127]))
  const archive = join(tempDir(), 'private.tar.zst')
  const receipt = await writeTaskArchive(source, archive)
  expect(receipt.headSha).not.toBe(localHead)
  writeFileSync(join(repo, 'README.md'), 'branch advanced\n')
  await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'advance'], { cwd: repo })

  const fresh = tempDir()
  const cache = join(fresh, 'repo')
  await execa('git', ['clone', '--no-local', '--single-branch', '--branch', 'main', repo, cache])
  const second = new WorktreeManager(join(fresh, 'worktrees'), false, true)
  const base = await second.portableWorktreeBase(cache, 'main', receipt.headSha)
  const replacement = await second.create('portable-new', cache, base)
  const stage = join(fresh, 'portable-workspaces')
  mkdirSync(stage)
  const uploaded = join(stage, 'portable-new.tar.zst')
  copyFileSync(archive, uploaded)
  appendFileSync(uploaded, 'interrupted')
  await expect(second.restorePortableWorkspace('portable-new', receipt, base)).rejects.toThrow('size mismatch')
  expect(existsSync(join(replacement, 'binary'))).toBe(false)
  copyFileSync(archive, uploaded)
  await second.restorePortableWorkspace('portable-new', receipt, base)
  expect(readFileSync(join(replacement, 'README.md'), 'utf8')).toBe('task edits\n')
  expect(readFileSync(join(replacement, 'binary'))).toEqual(Buffer.from([0, 13, 255, 127]))
  expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: replacement })).stdout).toBe(receipt.headSha)
  expect(readFileSync(join(replacement, 'committed.txt'), 'utf8')).toBe('local commit content\n')
  expect((await execa('git', ['status', '--short'], { cwd: replacement })).stdout).toBe(' M README.md\n?? binary\n?? committed.txt')
  expect((await execa('git', ['cat-file', '-e', localHead], { cwd: replacement, reject: false })).exitCode).not.toBe(0)
  await expect(second.portableWorktreeBase(cache, 'main', 'invalid')).rejects.toThrow('Git commit is invalid')

  await second.clearPortableWorkspace('portable-new')
  expect(existsSync(uploaded)).toBe(false)
})

it.skipIf(process.platform !== 'linux').each(['shallow history', 'force-pushed branch', 'deleted branch'])(
  'restores the complete portable file tree after %s makes the source base unavailable',
  async history => {
    const { mkdirSync, copyFileSync, readdirSync } = await import('node:fs')
    const { writeTaskArchive } = await import('../src/task-workspace-archive.mjs')
    const origin = await makeRepo()
    const git = (...args: string[]) => execa('git', args, {
      cwd: origin,
      env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    })
    const sourceBranch = history === 'deleted branch' ? 'retired' : 'main'
    if (sourceBranch === 'retired') {
      await git('switch', '-c', sourceBranch, 'main')
      await git('commit', '--allow-empty', '-m', 'isolated branch head')
      await git('switch', 'main')
    }
    const sourceManager = new WorktreeManager(join(tempDir(), 'worktrees'), false, true)
    const source = await sourceManager.create('source', origin, sourceBranch)
    writeFileSync(join(source, 'README.md'), 'portable source content\n')
    writeFileSync(join(source, 'private-work.bin'), Buffer.from([10, 20, 255]))
    const archive = join(tempDir(), 'source.tar.zst')
    const receipt = await writeTaskArchive(source, archive)

    const { stdout: originalMain } = await git('rev-parse', 'main')
    if (sourceBranch === 'retired') await git('branch', '-D', sourceBranch)
    writeFileSync(join(origin, 'remote-only'), 'new remote file\n')
    await git('add', 'remote-only')
    const { stdout: tree } = await git('write-tree')
    let target = originalMain
    if (history === 'shallow history') {
      for (let n = 0; n < 51; n++) {
        target = (await git('commit-tree', tree, '-p', target, '-m', 'remote advance ' + n)).stdout
      }
    } else {
      // A force push replaces the entire ancestry of the authorized branch.
      target = (await git('commit-tree', tree, '-m', 'rewritten main')).stdout
    }
    await git('update-ref', 'refs/heads/main', target, originalMain)
    await git('symbolic-ref', 'HEAD', 'refs/heads/main')

    const fresh = tempDir()
    const cache = join(fresh, 'repo')
    await execa('git', ['clone', '--depth=50', '--single-branch', '--branch', 'main', 'file://' + origin, cache])
    await execa('git', ['remote', 'set-head', 'origin', '-a'], { cwd: cache })
    expect((await execa('git', ['cat-file', '-e', receipt.headSha], { cwd: cache, reject: false })).exitCode).not.toBe(0)
    const manager = new WorktreeManager(join(fresh, 'worktrees'), false, true)
    const chosen = await manager.portableWorktreeBase(cache, 'refs/remotes/origin/' + sourceBranch, receipt.headSha)
    expect(chosen).toBe(target)
    const checkout = await manager.create('replacement', cache, chosen)
    const config = readFileSync(join(cache, '.git', 'config'))
    expect(existsSync(join(checkout, 'remote-only'))).toBe(true)
    const stage = join(fresh, 'portable-workspaces')
    mkdirSync(stage)
    copyFileSync(archive, join(stage, 'replacement.tar.zst'))
    await expect(manager.restorePortableWorkspace('replacement', receipt, receipt.headSha)).rejects.toThrow('differs from the linked worktree')
    await manager.restorePortableWorkspace('replacement', receipt, chosen)
    expect(readdirSync(checkout).sort()).toEqual(readdirSync(source).sort())
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('portable source content\n')
    expect(readFileSync(join(checkout, 'private-work.bin'))).toEqual(Buffer.from([10, 20, 255]))
    expect(readFileSync(join(cache, '.git', 'config'))).toEqual(config)
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout).toBe(target)
  },
)
