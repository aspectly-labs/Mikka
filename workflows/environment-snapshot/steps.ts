export async function build(id: string) {
  'use step'
  const { buildEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshot-build')
  return buildEnvironmentSnapshot(id)
}
export async function expire(id: string) {
  'use step'
  const { expireEnvironmentSnapshot } = await import('@/lib/project-resources/environment-snapshot-build')
  await expireEnvironmentSnapshot(id)
}
expire.maxRetries = 12
