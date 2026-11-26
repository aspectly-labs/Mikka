import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { writeTaskArchive } from '../../packages/daemon/src/task-workspace-archive.mjs'

// Each loopback provider uses its own disk directory. Git, the daemon, and
// the archive writer use real files. Guest absolute paths remain private to
// the provider fixture rather than sharing the two machines' worktrees.
export function portableComputeGuest(root, dataDirectory) {
  const children = new Set()
  const local = remote => {
    assert.equal(typeof remote, 'string')
    assert.ok(remote.startsWith('/') && !remote.includes('\0'))
    const file = resolve(root, '.' + remote)
    assert.ok(file.startsWith(root + '/'), 'guest escaped its disk')
    return file
  }
  const write = async (path, bytes) => {
    const file = local(path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  const remove = async path => rm(local(path), { recursive: true, force: true })
  async function capture(runId, temporary) {
    const output = local(temporary)
    await mkdir(dirname(output), { recursive: true })
    return writeTaskArchive(local(`${dataDirectory}/worktrees/${runId}`), output)
  }
  function daemon(processArguments, env = {}) {
    const child = spawn(process.execPath, ['--import', 'tsx', ...processArguments], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    const done = once(child, 'exit').then(([exitCode]) => ({ exitCode: exitCode ?? 128 }))
    void done.finally(() => children.delete(child)).catch(() => {})
    return { pid: child.pid, stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
      stdin: Writable.toWeb(child.stdin), wait: () => done, kill: async () => { child.kill(); await done } }
  }
  return { local, write, remove, capture, daemon, dataDirectory,
    read: path => readFile(local(path)), stream: path => Readable.toWeb(createReadStream(local(path))),
    async close() { await Promise.all([...children].map(async c => { const done = once(c, 'exit'); c.kill(); await done })) } }
}
