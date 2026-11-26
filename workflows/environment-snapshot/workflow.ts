import { sleep } from 'workflow'
import { abandon, build, expire } from './steps'

export async function environmentSnapshotWorkflow(id: string) {
  'use workflow'
  let result: string | null
  try {
    result = await build(id)
  } catch {
    result = await abandon(id)
  }
  if (result) {
    await sleep(new Date(result))
    await expire(id)
  }
}
