import { sleep } from 'workflow'
import { build, expire } from './steps'

export async function environmentSnapshotWorkflow(id: string) {
  'use workflow'
  let result = await build(id)
  while (result && typeof result === 'object') {
    await sleep(new Date(result.retryAt))
    result = await build(id)
  }
  if (result) {
    await sleep(new Date(result))
    await expire(id)
  }
}
