import { Files } from '@cloudflare/sandbox'
import { portableReceipt } from './grant.mjs'

const root = { user: '0:0' }
const worker = { user: '1000:1000' }
const directory = '/run/mikka-task-archives'
const staging = '/workspace/portable-workspaces'
const source = '/opt/mikka/task-sandbox/task-workspace-archive.mjs'
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

async function result(container, args, options) {
  const command = await container.exec(args, options)
  const output = await command.output()
  if (output.exitCode !== 0) throw Error('Portable task workspace operation failed')
  return output
}

function archivePath(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw Error('Invalid portable task archive identifier')
  return directory + '/' + id + '.tar.zst'
}

export async function capturePortableWorkspace(container, runId, id) {
  const destination = archivePath(id)
  // The private RPC verifies this grant and fences the native writer first.
  const temporary = '/tmp/mikka-task-workspace-' + id + '.tar.zst'
  try {
    const output = await result(container, ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C',
      '/usr/local/bin/node', '--input-type=module', '-e',
      `process.stdout.write(JSON.stringify(await (await import('${source}')).writeTaskArchive(process.argv[1], process.argv[2])))`,
      '/workspace/worktrees/' + runId, temporary], worker)
    const receipt = portableReceipt(JSON.parse(new TextDecoder().decode(output.stdout)))
    await result(container, ['/bin/sh', '-ec',
      'install -d -m 700 -o root -g root "$1" && test ! -L "$2" && install -m 400 -o root -g root "$2" "$3"', 'mikka', directory, temporary, destination], root)
    return receipt
  } finally {
    await result(container, ['/usr/bin/rm', '-f', '--', temporary], root).catch(() => undefined)
  }
}

export async function readPortableWorkspace(container, id) {
  return new Files(container).readFile(archivePath(id), root)
}

export async function deletePortableWorkspace(container, id) {
  await result(container, ['/usr/bin/rm', '-f', '--', archivePath(id)], root)
}

export async function stagePortableWorkspace(container, runId, receipt, bytes) {
  const scratch = staging + '/' + crypto.randomUUID()
  const target = staging + '/' + runId + '.tar.zst'
  try {
    await result(container, ['/usr/bin/install', '-d', '-m', '700', scratch], worker)
    await new Files(container).writeFile(scratch + '/archive', bytes, worker)
    await result(container, ['/bin/sh', '-ec',
      'test "$(stat -c %s -- "$1")" = "$3" && printf "%s  %s\n" "$4" "$1" | sha256sum -c --status && chmod 600 "$1" && mv -- "$1" "$2"',
      'mikka', scratch + '/archive', target, String(receipt.size), receipt.sha256], worker)
  } finally {
    await result(container, ['/usr/bin/rm', '-rf', '--', scratch], worker).catch(() => undefined)
  }
}
