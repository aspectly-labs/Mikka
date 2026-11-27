import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export function releaseVersion(runNumber) {
  if (!/^[1-9]\d*$/.test(runNumber ?? '') || !Number.isSafeInteger(Number(runNumber) + 1)) throw new Error('Invalid GitHub run number')
  return `0.0.${Number(runNumber) + 1}`
}

/** An automatic main push publishes to the `next` dist-tag only; installed daemons follow `latest`, which
 * moves only when a promoter dispatches publish-daemon.yml for a staged build (scripts/release/daemon-promotion.mjs). */
export const releaseChannel = value => value === 'latest' ? 'latest' : 'next'

export async function releasePlan({ packageName, version, sha, channel = 'next', fetchRegistry = fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release commit')
  if (!['next', 'latest'].includes(channel)) throw new Error('Invalid release channel')
  const registry = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
  const read = async suffix => {
    const response = await fetchRegistry(`${registry}/${suffix}`, { signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
    return response.json()
  }
  const existing = await read(version)
  if (existing) {
    if (existing.gitHead !== sha) throw new Error(`Published ${version} does not match release commit`)
    return { published: true, tag: '' }
  }
  const current = await read(channel)
  // shortcut: automated releases use 0.0.N; choose a new version line before changing that scheme.
  if (current && !/^0\.0\.(0|[1-9]\d*)$/.test(current.version)) throw new Error(`Unexpected npm ${channel} version; review automatic version scheme`)
  const newer = current && Number(current.version.split('.')[2]) > Number(version.split('.')[2])
  // A promotion never moves latest backwards; an older automatic build keeps its own tag.
  if (newer && channel === 'latest') throw new Error('npm latest is newer than this promotion; refusing to downgrade')
  return { published: false, tag: newer ? `build-${version}` : channel }
}

export async function verifyRelease(options, wait = delay) {
  // npm can acknowledge publication minutes before its registry serves the version.
  for (let attempt = 0; attempt < 31; attempt++) {
    const plan = await releasePlan(options)
    if (plan.published) return plan
    if (attempt < 30) await wait(10_000)
  }
  throw new Error(`npm accepted publication but ${options.version} is still unavailable; registry verification is incomplete`)
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = releaseVersion(process.env.GITHUB_RUN_NUMBER)
  const options = { packageName: process.env.MIKKA_DAEMON_PACKAGE_NAME, version, sha: process.env.GITHUB_SHA,
    channel: releaseChannel(process.env.MIKKA_DAEMON_CHANNEL) }
  const plan = await (process.argv.includes('--verify') ? verifyRelease(options) : releasePlan(options))
  const manifestPath = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = version
  manifest.gitHead = process.env.GITHUB_SHA
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\npublished=${plan.published}\ntag=${plan.tag}\n`)
  console.log(`${version}: ${plan.published ? 'already published from this commit' : `publish with tag ${plan.tag}`}`)
}
