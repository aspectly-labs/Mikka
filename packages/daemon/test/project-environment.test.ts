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
