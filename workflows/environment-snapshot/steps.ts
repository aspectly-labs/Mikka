import { RetryableError } from 'workflow'

export async function build(id: string) {
  'use step'
  const { buildEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshot-build')
  const result = await buildEnvironmentSnapshot(id)
  if (result && typeof result === 'object')
    throw new RetryableError('environment_snapshot_build_slot_unavailable', { retryAfter: '1m' })
  return result
}
build.maxRetries = 30

export async function abandon(id: string) {
  'use step'
  const { abandonEnvironmentSnapshotBuild } = await import('@/lib/project-resources/environment-snapshot-build')
  return abandonEnvironmentSnapshotBuild(id)
}
abandon.maxRetries = 12

export async function expire(id: string) {
  'use step'
  const { expireEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshot-build')
  await expireEnvironmentSnapshot(id)
}
expire.maxRetries = 12
