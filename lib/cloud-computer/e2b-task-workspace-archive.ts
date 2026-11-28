import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Sandbox } from 'e2b'
import { z } from 'zod'
import { portableTaskWorkspaceReceiptSchema as receiptSchema } from '@mikka/protocol/device'
import { artifactStorage } from '../artifacts/storage'
import { quoteShell } from '../computer/registration-command'
import type { Masker } from '../secrets/mask'
import { verifyTaskArchive } from '../../packages/daemon/src/task-workspace-archive.mjs'

const directory = '/home/user/.mikka/worker'
export const portableTaskArchiveEnabled = () => artifactStorage('task-workspaces') === 'r2'

export function checkedWorkspaceStream(source: ReadableStream<Uint8Array>, receipt: z.infer<typeof receiptSchema>, mask: Masker) {
  const reader = source.getReader()
  const validation = new PassThrough()
  const checked = verifyTaskArchive(validation, mask)
  const rejected = checked.then(() => new Promise<never>(() => {}))
  void rejected.catch(() => undefined)
  const digest = createHash('sha256')
  let size = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await Promise.race([reader.read(), rejected])
        if (done) {
          validation.end()
          await checked
          if (size !== receipt.size || digest.digest('hex') !== receipt.sha256) throw new Error('Portable task workspace checksum mismatch')
          controller.close()
          return
        }
        size += value.length
        if (size > receipt.size) throw new Error('Portable task workspace size mismatch')
        digest.update(value)
        if (!validation.write(value)) await Promise.race([once(validation, 'drain'), rejected])
        controller.enqueue(value)
      } catch (error) {
        validation.destroy()
        await reader.cancel().catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel() {
      validation.destroy()
      await reader.cancel().catch(() => undefined)
    },
  })
}

export async function captureE2BTaskWorkspace(sandbox: Pick<Sandbox, 'commands' | 'files'>,
  runId: string, mask: Masker, signal: AbortSignal) {
  const run = z.uuid().parse(runId)
  const id = randomUUID(), path = '/tmp/mikka-task-workspace-' + id + '.tar.zst'
  const sealedDirectory = '/run/mikka-task-archives'
  const sealed = sealedDirectory + '/' + id + '.tar.zst'
  const source = await readFile(join(process.cwd(), 'packages/daemon/src/task-workspace-archive.mjs'), 'utf8')
  const dispose = () => sandbox.commands.run(`rm -f -- ${path} ${sealed}`,
    { user: 'root', timeoutMs: 4_000, requestTimeoutMs: 5_000, signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
  try {
    const response = await sandbox.commands.run(
      `env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /opt/mikka/runtime/node/bin/node --input-type=module - archive-task-worktree-v1 ${directory}/worktrees/${run} ${path} <<'MIKKA_TASK_WORKSPACE_ARCHIVE'\n${source}\nMIKKA_TASK_WORKSPACE_ARCHIVE`,
      { user: 'user', timeoutMs: 50_000, requestTimeoutMs: 55_000, signal },
    )
    if (response.exitCode !== 0) throw new Error('Portable task workspace capture failed')
    const receipt = receiptSchema.parse(JSON.parse(response.stdout))
    const protectedCopy = await sandbox.commands.run(
      `install -d -m 700 -o root -g root ${sealedDirectory} && test ! -L ${path} && install -m 400 -o root -g root ${path} ${sealed} && rm -f -- ${path}`,
      { user: 'root', timeoutMs: 10_000, requestTimeoutMs: 12_000, signal },
    )
    if (protectedCopy.exitCode !== 0) throw new Error('Portable task workspace sealing failed')
    const info = await sandbox.files.getInfo(sealed, { user: 'root', requestTimeoutMs: 10_000, signal })
    if (info.size !== receipt.size) throw new Error('Portable task workspace size mismatch')
    const readSealed = () => sandbox.files.read(sealed, { user: 'root', format: 'stream', requestTimeoutMs: 20_000, signal })
    const verified = checkedWorkspaceStream(await readSealed(), receipt, mask).getReader()
    try { while (!(await verified.read()).done) { /* verify all bytes before storage */ } }
    finally { await verified.cancel().catch(() => undefined) }
    return { manifest: { id, ...receipt }, stream: await readSealed(), dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

export async function stageE2BTaskWorkspace(sandbox: Pick<Sandbox, 'commands' | 'files'>,
  runId: string, workspace: { manifest: { size: number; sha256: string; headSha: string }; stream: ReadableStream<Uint8Array<ArrayBuffer>> }, signal: AbortSignal) {
  const run = z.uuid().parse(runId)
  const receipt = receiptSchema.parse({ size: workspace.manifest.size, sha256: workspace.manifest.sha256, headSha: workspace.manifest.headSha })
  const staging = directory + '/portable-workspaces'
  const scratch = staging + '/' + randomUUID()
  const destination = staging + '/' + run + '.tar.zst'
  const command = (script: string) => sandbox.commands.run(script, {
    user: 'user', timeoutMs: 5_000, requestTimeoutMs: 8_000, signal,
  })
  if ((await command(`install -d -m 700 ${quoteShell(scratch)}`)).exitCode !== 0) throw new Error('Portable task workspace staging unavailable')
  // Older envd builds buffer a stream into a Blob. Keep each SDK write
  // bounded and assemble the verified archive inside the fresh guest.
  const reader = workspace.stream.getReader()
  const buffer = new Uint8Array(4 * 1024 * 1024)
  let part = 0, used = 0, length = 0
  const flush = async () => {
    await sandbox.files.write(scratch + '/' + String(++part).padStart(12, '0') + '.part', buffer.slice(0, used).buffer,
      { user: 'user', requestTimeoutMs: 20_000, signal })
    used = 0
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > receipt.size) throw new Error('Portable task workspace size mismatch')
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(value.length - offset, buffer.length - used)
        buffer.set(value.subarray(offset, offset + count), used)
        used += count
        offset += count
        if (used === buffer.length) await flush()
      }
    }
    if (length !== receipt.size) throw new Error('Portable task workspace size mismatch')
    if (used) await flush()
    const assembled = await command(`umask 077; cat -- ${quoteShell(scratch)}/*.part > ${quoteShell(scratch + '/archive')} && mv -- ${quoteShell(scratch + '/archive')} ${quoteShell(destination)}`)
    if (assembled.exitCode !== 0) throw new Error('Portable task workspace staging unavailable')
    return receipt
  } finally {
    void reader.cancel().catch(() => undefined)
    await sandbox.commands.run(`rm -rf -- ${quoteShell(scratch)}`,
      { user: 'user', timeoutMs: 4_000, requestTimeoutMs: 5_000, signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
  }
}
