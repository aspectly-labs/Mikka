import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import type { DaemonClient } from '@mikka/daemon/client'
import { daemonPaths } from '@mikka/daemon/paths'

export function watchDaemonRunActivity(
  dataDir: string,
  connect: () => Promise<DaemonClient>,
  setActive: (active: boolean) => void,
): () => void {
  let stopped = false
  let connecting = false
  let retry = false
  let client: DaemonClient | undefined

  async function reconnect(): Promise<void> {
    if (stopped || client) return
    if (connecting) {
      retry = true
      return
    }
    connecting = true
    try {
      const next = await connect()
      if (stopped) {
        next.close()
        return
      }
      client = next
      next.onClose(() => {
        if (client !== next) return
        client = undefined
        setActive(false)
        void reconnect()
      })
      try {
        await next.watchRunActivity(active => {
          if (client === next) setActive(active)
        })
      } catch {
        // Older daemons do not publish authoritative local activity.
        if (client === next) {
          client = undefined
          next.close()
          setActive(false)
        }
      }
    } catch {
      // There may not be a daemon yet. Socket creation will wake this watcher.
    } finally {
      connecting = false
      if (retry) {
        retry = false
        void reconnect()
      }
    }
  }

  const paths = daemonPaths(dataDir)
  const relevant = [basename(paths.socket), basename(paths.secret)]
  let watcher: FSWatcher | undefined
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    watcher = watch(dataDir, { persistent: false }, (_event, name) => {
      if (!name || relevant.includes(name)) void reconnect()
    })
    watcher.on('error', () => watcher?.close())
  } catch {
    // Launch can still attach to an already-available daemon.
  }
  void reconnect()

  return () => {
    if (stopped) return
    stopped = true
    const previous = client
    client = undefined
    watcher?.close()
    previous?.close()
    setActive(false)
  }
}
