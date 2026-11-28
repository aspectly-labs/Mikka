import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recordTaskArchiveBase, restoreTaskArchive, verifyTaskArchive, writeTaskArchive } from '../src/task-workspace-archive.mjs'

test('portable checkout restores tracked edits and deletions, binary untracked files, modes and Git status', { skip: process.platform !== 'linux' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mikka-portable-worktree-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const repo = join(temp, 'repo'), source = join(temp, 'original'), restored = join(temp, 'replacement')
  const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', repo])
  await writeFile(join(repo, 'changed'), 'base\n')
  await writeFile(join(repo, 'deleted'), 'remove me\n')
  await writeFile(join(repo, '.gitignore'), 'ignored/\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base')
  git(repo, 'worktree', 'add', '-q', '--detach', source)
  git(repo, 'worktree', 'add', '-q', '--detach', restored)
  await writeFile(join(source, 'changed'), 'edited\n')
  await chmod(join(source, 'changed'), 0o664)
  await rm(join(source, 'deleted'))
  const binary = Buffer.from([0, 1, 2, 255, 0, 128])
  await writeFile(join(source, 'new.bin'), binary)
  await symlink('new.bin', join(source, 'safe-link'))
  await symlink('../repo/.git/config', join(source, 'escape-link'))
  await writeFile(join(source, '.env'), 'PASSWORD=synthetic-secret\n')
  await writeFile(join(source, '.env.example'), 'PASSWORD=\n')
  await writeFile(join(source, 'private'), '-----BEGIN PRIVATE KEY-----\nfixture\n')
  const packed = join(temp, 'task.tar.zst')
  const manifest = await writeTaskArchive(source, packed)
  assert.deepEqual(await writeTaskArchive(source, join(temp, 'same.tar.zst')), manifest, 'same tree has the same archive bytes')
  await verifyTaskArchive(createReadStream(packed), text => text)
  await assert.rejects(restoreTaskArchive(restored, packed, '0'.repeat(64)), /checksum mismatch/)
  assert.equal(await readFile(join(restored, 'changed'), 'utf8'), 'base\n')
  await restoreTaskArchive(restored, packed, manifest.sha256)
  assert.equal(await readFile(join(restored, 'changed'), 'utf8'), 'edited\n')
  assert.equal((await stat(join(restored, 'changed'))).mode & 0o777, 0o664)
  assert.deepEqual(await readFile(join(restored, 'new.bin')), binary)
  assert.equal(await readlink(join(restored, 'safe-link')), 'new.bin')
  for (const excluded of ['deleted', '.env', 'private', 'escape-link']) {
    await assert.rejects(stat(join(restored, excluded)), { code: 'ENOENT' })
  }
  assert.match(git(restored, 'status', '--short'), / M changed\n D deleted\n/)
  assert.match(git(restored, 'diff', '--binary'), /\+edited/)
  assert.equal(git(restored, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'))
})

test('separate clean clone restores local commits and dirty files without importing source Git objects or configuration', { skip: process.platform !== 'linux' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mikka-portable-local-commit-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const origin = join(temp, 'origin'), sourceRepo = join(temp, 'source'), destinationRepo = join(temp, 'destination')
  const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (path, message) => {
    git(path, 'add', '-A')
    git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message)
  }
  execFileSync('git', ['init', '-q', origin])
  await writeFile(join(origin, 'removed'), 'upstream file\n')
  await writeFile(join(origin, 'edited'), 'upstream content\n')
  commit(origin, 'authorized baseline')
  const base = git(origin, 'rev-parse', 'HEAD')
  execFileSync('git', ['clone', '-q', '--no-local', origin, sourceRepo])
  execFileSync('git', ['clone', '-q', '--no-local', origin, destinationRepo])
  for (const legacy of [false, true]) {
    const source = join(temp, 'source-worktree-' + legacy), destination = join(temp, 'destination-worktree-' + legacy)
    git(sourceRepo, 'worktree', 'add', '-q', '--detach', source, base)
    git(destinationRepo, 'worktree', 'add', '-q', '--detach', destination, base)
    if (!legacy) await recordTaskArchiveBase(source)
    await rm(join(source, 'removed'))
    await writeFile(join(source, 'committed'), 'content from local commit\n')
    await writeFile(join(source, '.env'), 'CONFIG_TOKEN=credential-in-local-commit\n')
    commit(source, 'local task commit')
    const localCommit = git(source, 'rev-parse', 'HEAD')
    git(sourceRepo, 'config', 'remote.origin.url', 'https://fixture:credential@example.invalid/task.git')
    await writeFile(join(source, 'edited'), 'dirty tracked file\n')
    await writeFile(join(source, 'untracked'), 'dirty untracked file\n')

    const packed = join(temp, 'task-' + legacy + '.tar.zst')
    const receipt = await writeTaskArchive(source, packed)
    assert.equal(receipt.headSha, base)
    await verifyTaskArchive(createReadStream(packed), text => text.replaceAll('credential', '[masked]'))
    const cleanConfig = await readFile(join(destinationRepo, '.git', 'config'))
    const cleanPointer = await readFile(join(destination, '.git'))
    await restoreTaskArchive(destination, packed, receipt.sha256)

    assert.equal(git(destination, 'rev-parse', 'HEAD'), base)
    assert.throws(() => git(destination, 'cat-file', '-e', localCommit), { status: 1 })
    assert.deepEqual(await readFile(join(destinationRepo, '.git', 'config')), cleanConfig)
    assert.deepEqual(await readFile(join(destination, '.git')), cleanPointer)
    assert.equal(await readFile(join(destination, 'committed'), 'utf8'), 'content from local commit\n')
    assert.equal(await readFile(join(destination, 'edited'), 'utf8'), 'dirty tracked file\n')
    assert.equal(await readFile(join(destination, 'untracked'), 'utf8'), 'dirty untracked file\n')
    await assert.rejects(stat(join(destination, 'removed')), { code: 'ENOENT' })
    await assert.rejects(stat(join(destination, '.env')), { code: 'ENOENT' })
  }
})
