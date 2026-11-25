import { sleep } from 'workflow'
import { build, expire } from './steps'

export async function environmentSnapshotWorkflow(id: string) {
  'use workflow'
  const expiresAt = await build(id)
  if (expiresAt) {
    await sleep(new Date(expiresAt))
    await expire(id)
  }
}
