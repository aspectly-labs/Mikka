const command = ['/bin/cat', '/proc/sys/kernel/random/boot_id', '/sys/fs/cgroup/cpu.stat']

/** Fixed privileged executable, kernel-owned accounting files, no user-controlled
 * paths or environment. Task processes run as UID 1000 without capabilities. */
export async function readComputeMeter(container) {
  const proc = await container.exec(command, { user: '0:0', cwd: '/', env: {}, stdout: 'pipe', stderr: 'pipe' })
  const result = await proc.output()
  const output = typeof result.stdout === 'string' ? result.stdout : new TextDecoder().decode(result.stdout)
  if (result.exitCode !== 0 || output.length > 4096) throw Error('Cloudflare compute measurement unavailable')
  const bootId = output.split('\n', 1)[0]
  const cpu = /^usage_usec (\d+)$/m.exec(output)
  const cpuUsec = cpu ? Number(cpu[1]) : NaN
  if (!/^[0-9a-f-]{36}$/.test(bootId) || !Number.isSafeInteger(cpuUsec) || cpuUsec < 0) throw Error('Cloudflare compute measurement unavailable')
  return { bootId, cpuUsec, observedAt: Date.now() }
}

export function measuredComputeInterval(start, end) {
  if (!start || !end || start.bootId !== end.bootId || end.cpuUsec < start.cpuUsec || end.observedAt < start.observedAt)
    return null
  return { provisionedMs: end.observedAt - start.observedAt, activeVcpuMs: Math.ceil((end.cpuUsec - start.cpuUsec) / 1000) }
}
