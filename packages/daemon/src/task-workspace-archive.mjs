import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const execute = promisify(execFile)
const block = 512
const chunkSize = 64 * 1024
const secretOverlap = 128 * 1024
const safeMode = 0o777
const hex = /^[a-f0-9]{64}$/
const commitHex = /^[a-f0-9]{40}$/
const baseMarker = 'mikka-portable-base'
const decoder = new TextDecoder('utf-8', { fatal: true })

function credentialPath(path) {
  return path.split('/').some(part => /^(?:\.git|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.codex|\.claude|\.mikka|credentials\.json|auth\.json|hosts\.yml|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i.test(part)
    || (/^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)))
}

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\x00-\x1f\x7f\\]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..') && !credentialPath(path)
}

function safeLink(path, target) {
  if (!target || target.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(target)) return false
  return safePath(posix.normalize(posix.join(posix.dirname(path), target)))
}

function containsCredential(data) {
  return /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{25,}|e2b_[A-Za-z0-9]{30,}|orv_[A-Za-z0-9_-]{36,})\b/.test(data.toString('latin1'))
}

function field(target, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error('Workspace archive path is too long')
  bytes.copy(target, offset)
}

function octal(target, offset, length, number) {
  field(target, offset, length, number.toString(8).padStart(length - 1, '0') + '\0')
}

function header(path, { mode, size, link }) {
  let name = path
  let prefix = ''
  if (Buffer.byteLength(path) > 100) {
    let split = path.lastIndexOf('/')
    while (split > 0 && Buffer.byteLength(path.slice(0, split)) > 155) split = path.lastIndexOf('/', split - 1)
    if (split < 1) throw new Error('Workspace archive path is too long')
    name = path.slice(split + 1)
    prefix = path.slice(0, split)
  }
  const buffer = Buffer.alloc(block)
  field(buffer, 0, 100, name)
  octal(buffer, 100, 8, mode)
  octal(buffer, 108, 8, 0)
  octal(buffer, 116, 8, 0)
  octal(buffer, 124, 12, size)
  octal(buffer, 136, 12, 0)
  buffer.fill(32, 148, 156)
  field(buffer, 156, 1, link ? '2' : '0')
  if (link) field(buffer, 157, 100, link)
  field(buffer, 257, 6, 'ustar\0')
  field(buffer, 263, 2, '00')
  field(buffer, 345, 155, prefix)
  octal(buffer, 148, 7, buffer.reduce((sum, byte) => sum + byte, 0))
  return buffer
}

function textField(buffer, start, length) {
  const bytes = buffer.subarray(start, start + length)
  const end = bytes.indexOf(0)
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function readOctal(buffer, start, length) {
  const value = textField(buffer, start, length).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid workspace archive')
  return Number.parseInt(value, 8)
}

async function inspectPath(root, relative) {
  const parts = relative.split('/')
  let directory = root
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part)
    const entry = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!entry?.isDirectory()) return null
  }
  return lstat(join(root, relative)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
}

async function* worktreeFile(path, entry) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size || !opened.isFile()) {
      throw new Error('Task worktree changed during archive')
    }
    const buffer = Buffer.allocUnsafe(chunkSize)
    let offset = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      yield Buffer.from(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat()
    if (offset !== opened.size || after.ctimeMs !== entry.ctimeMs) throw new Error('Task worktree changed during archive')
  } finally { await file.close() }
}

async function containsSecret(source, mask = text => text) {
  let tail = Buffer.alloc(0)
  let rejected = false
  for await (const chunk of source) {
    const sample = Buffer.concat([tail, chunk])
    const text = sample.toString('utf8')
    rejected ||= containsCredential(sample) || mask(text) !== text
    tail = sample.subarray(Math.max(0, sample.length - secretOverlap))
  }
  return rejected
}

async function* tarChunks(root) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Task worktree is unavailable')
  const { stdout } = await execute('git', ['-C', root, 'ls-files', '-c', '-o', '--exclude-standard', '-z'], {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20_000,
  })
  const paths = [...new Set(decoder.decode(stdout).split('\0').filter(safePath))].sort()
  for (const path of paths) {
    const entry = await inspectPath(root, path)
    if (!entry || entry.isDirectory()) continue
    const absolute = join(root, path)
    const link = entry.isSymbolicLink() ? await readlink(absolute) : undefined
    if (link && !safeLink(path, link)) continue
    if (!link && (!entry.isFile() || await containsSecret(worktreeFile(absolute, entry)))) continue
    const size = link ? 0 : entry.size
    yield header(path, { mode: entry.mode & safeMode, size, link })
    if (!link) yield* worktreeFile(absolute, entry)
    yield Buffer.alloc((block - size % block) % block)
  }
  yield Buffer.alloc(block * 2)
}

async function git(root, args) {
  return (await execute('git', ['-C', root, ...args], { timeout: 5_000 })).stdout.trim()
}

// This file belongs to the linked Git administrative directory. Only its SHA
// enters the receipt; no part of the source Git directory enters the archive.
export async function recordTaskArchiveBase(root) {
  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!commitHex.test(head)) throw new Error('Task workspace Git commit is unavailable')
  const marker = resolve(root, await git(root, ['rev-parse', '--git-path', baseMarker]))
  await writeFile(marker, head + '\n', { mode: 0o600, flag: 'wx' })
}

async function taskArchiveBase(root, head) {
  const marker = resolve(root, await git(root, ['rev-parse', '--git-path', baseMarker]))
  const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (file) {
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== 41) throw new Error('Task workspace Git base is invalid')
      const markerBytes = Buffer.alloc(42)
      const { bytesRead } = await file.read(markerBytes, 0, markerBytes.length, 0)
      const candidate = markerBytes.subarray(0, 40).toString('latin1')
      if (bytesRead !== 41 || markerBytes[40] !== 10 || !commitHex.test(candidate)) throw new Error('Task workspace Git base is invalid')
      return candidate
    } finally { await file.close() }
  }
  // Worktrees created before the marker keep their initial checkout in their
  // own HEAD reflog. Restore still validates the anchor in the clean clone.
  const reflog = await git(root, ['reflog', 'show', '--format=%H', 'HEAD'])
  const oldest = reflog.split('\n').at(-1) || head
  if (!commitHex.test(oldest)) throw new Error('Task workspace Git base is invalid')
  return oldest
}

export async function writeTaskArchive(root, output) {
  const { createZstdCompress } = await import('node:zlib')
  const head = () => git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const current = await head()
  if (!commitHex.test(current)) throw new Error('Task workspace Git commit is unavailable')
  const headSha = await taskArchiveBase(root, current)
  const digest = createHash('sha256')
  let size = 0
  const measure = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length
    digest.update(chunk)
    callback(null, chunk)
  } })
  await pipeline(Readable.from(tarChunks(root)), createZstdCompress(), measure, createWriteStream(output, { flags: 'wx', mode: 0o600 }))
  if (await head() !== current) throw new Error('Task workspace Git commit changed during archive')
  return { size, sha256: digest.digest('hex'), headSha }
}

class TarReader {
  constructor(source) {
    this.source = source[Symbol.asyncIterator]()
    this.pending = Buffer.alloc(0)
  }

  async take(length) {
    const bytes = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      if (!this.pending.length) {
        const { done, value } = await this.source.next()
        if (done) throw new Error('Workspace archive is incomplete')
        this.pending = value
      }
      const count = Math.min(this.pending.length, length - offset)
      this.pending.copy(bytes, offset, 0, count)
      this.pending = this.pending.subarray(count)
      offset += count
    }
    return bytes
  }

  async *body(length) {
    for (let remaining = length; remaining > 0;) {
      const count = Math.min(remaining, chunkSize)
      yield await this.take(count)
      remaining -= count
    }
  }

  async finish() {
    const second = await this.take(block)
    if (second.some(byte => byte !== 0) || this.pending.some(byte => byte !== 0)) throw new Error('Invalid workspace archive trailer')
    for (;;) {
      const { done, value } = await this.source.next()
      if (done) return
      if (value.some(byte => byte !== 0)) throw new Error('Invalid workspace archive trailer')
    }
  }
}

async function consumeTaskArchive(packed, visit) {
  const { createZstdDecompress } = await import('node:zlib')
  const inflater = createZstdDecompress()
  const piping = pipeline(Readable.from(packed), inflater)
  void piping.catch(() => undefined)
  const tar = new TarReader(inflater)
  const paths = new Set(), parents = new Set()
  try {
    for (;;) {
      const row = await tar.take(block)
      if (row.every(byte => byte === 0)) { await tar.finish(); break }
      const sum = row.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
      if (textField(row, 257, 6) !== 'ustar' || sum !== readOctal(row, 148, 8)) throw new Error('Invalid workspace archive header')
      const name = textField(row, 0, 100), prefix = textField(row, 345, 155)
      const path = prefix ? prefix + '/' + name : name
      const type = textField(row, 156, 1), size = readOctal(row, 124, 12), mode = readOctal(row, 100, 8)
      const link = type === '2' ? textField(row, 157, 100) : undefined
      if (!safePath(path) || paths.has(path) || parents.has(path) || mode > safeMode
        || (type !== '0' && (type !== '2' || size !== 0 || !safeLink(path, link)))) throw new Error('Invalid workspace archive member')
      for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
        if (paths.has(parent)) throw new Error('Workspace archive contains overlapping paths')
        parents.add(parent)
      }
      paths.add(path)
      await visit({ path, mode, link, body: tar.body(size) })
      await tar.take((block - size % block) % block)
    }
    await piping
  } finally { inflater.destroy() }
}

export async function verifyTaskArchive(packed, mask) {
  await consumeTaskArchive(packed, async ({ path, link, body }) => {
    if (mask(path) !== path || (link && mask(link) !== link) || await containsSecret(body, mask)) {
      throw new Error('Portable task workspace contains a secret')
    }
  })
}

/** The daemon has already made a linked Git worktree at root. Preserve its
 * new .git pointer, while the portable archive replaces the working files. */
export async function restoreTaskArchive(root, packedPath, sha256) {
  if (!hex.test(sha256)) throw new Error('Task workspace archive checksum mismatch')
  const digest = createHash('sha256')
  async function* checkedSource() {
    for await (const chunk of createReadStream(packedPath)) {
      digest.update(chunk)
      yield chunk
    }
    if (digest.digest('hex') !== sha256) throw new Error('Task workspace archive checksum mismatch')
  }
  const temporary = await mkdtemp(join(dirname(root), '.restore-task-'))
  const replacement = join(temporary, 'worktree')
  try {
    await mkdir(replacement)
    await consumeTaskArchive(checkedSource(), async ({ path, mode, link, body }) => {
      const target = join(replacement, path)
      await mkdir(dirname(target), { recursive: true })
      if (link) await symlink(link, target)
      else {
        await pipeline(Readable.from(body), createWriteStream(target, { mode, flags: 'wx' }))
        await chmod(target, mode)
      }
    })
    const pointer = await lstat(join(root, '.git'))
    if (!pointer.isFile()) throw new Error('Task worktree Git pointer unavailable')
    await writeFile(join(replacement, '.git'), await readFile(join(root, '.git')), { mode: 0o600, flag: 'wx' })
    // Both hosted guests are Linux. An atomic directory exchange preserves the
    // registered Git worktree path even if the worker exits during restore.
    await execute('/usr/bin/python3', ['-I', '-c', `
import ctypes, os, sys
rename = ctypes.CDLL(None, use_errno=True).renameat2
if rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2):
    raise OSError(ctypes.get_errno(), 'Workspace directory exchange failed')
`, root, replacement], { timeout: 5_000 })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

// The E2B host sends this dependency-free program to the verified worker VM
// as stdin. Only the worktree path and a temporary file name go to the guest.
if (process.argv[1] === '-' && process.argv[2] === 'archive-task-worktree-v1') {
  const [, , , root, output] = process.argv
  if (!root || !output) throw new Error('Task workspace archive arguments unavailable')
  process.stdout.write(JSON.stringify(await writeTaskArchive(root, output)))
}
