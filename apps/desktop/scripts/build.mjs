// Ship the existing application's React renderer beside main and preload.
// __MIKKA_APP_URL__ identifies the backend; normal launch never downloads UI.

import { build } from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRenderer } from './build-renderer.mjs'
import { desktopOverlayEvidence } from '../../../scripts/release/hosted-ui.mjs'
import { publicEnv } from '../../../lib/public-env.mjs'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'dist')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const flavor = process.env.MIKKA_DESKTOP_FLAVOR === 'dev' ? 'dev' : 'prod'
const appUrl = process.env.MIKKA_DESKTOP_APP_URL
  ?? (flavor === 'dev' ? 'http://localhost:3000/mikka' : 'https://app.aspectlylabs.com/mikka')

const parsed = new URL(appUrl)
if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
  throw new Error('MIKKA_DESKTOP_APP_URL must be an HTTP(S) URL without credentials')
}
if (flavor === 'prod' && parsed.protocol !== 'https:') {
  throw new Error('A production desktop build must load the app over HTTPS')
}

// Telemetry goes to the web's PostHog project (MIKKA_PUBLIC_POSTHOG_KEY, a
// public ingestion key). A build without one sends nothing (src/main/telemetry.ts).
// The host is POSTHOG_HOST (or the legacy NEXT_PUBLIC_POSTHOG_HOST, both read by
// publicEnv), else the web's own default, DEFAULT_POSTHOG_API_HOST in
// lib/env/public.ts. The release sets no host: Mikka Cloud's project is in the
// US region (us.posthog.com), so the default is the right ingestion origin.
const posthogKey = publicEnv('MIKKA_PUBLIC_POSTHOG_KEY', process.env, '')
const posthogHost = publicEnv('POSTHOG_HOST', process.env, '') || 'https://us.i.posthog.com'
if (posthogKey && !/^ph[a-z]_[A-Za-z0-9]{20,80}$/.test(posthogKey)) throw new Error('MIKKA_PUBLIC_POSTHOG_KEY is not a PostHog project key')
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(posthogHost)) throw new Error('POSTHOG_HOST must be an HTTPS origin')
const revision = value => (/^[0-9a-f]{40}$/.test(value ?? '') ? value : '')
let publicSha = revision(process.env.MIKKA_DESKTOP_SOURCE) || revision(process.env.GITHUB_SHA)
if (!publicSha) try { publicSha = revision(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { /* Not a checkout. */ }

const define = {
  __MIKKA_APP_URL__: JSON.stringify(appUrl),
  __MIKKA_APP_VERSION__: JSON.stringify(pkg.version),
  __MIKKA_FLAVOR__: JSON.stringify(flavor),
  __MIKKA_POSTHOG_KEY__: JSON.stringify(posthogKey),
  __MIKKA_POSTHOG_HOST__: JSON.stringify(posthogHost),
  __MIKKA_PUBLIC_SHA__: JSON.stringify(publicSha),
  __MIKKA_OVERLAY_SHA__: JSON.stringify(revision(process.env.MIKKA_UI_OVERLAY_SHA)),
}

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
// The renderer is the official UI (lib/ui-overlay.mjs) and needs its checkout.
// Without one, a dev-flavour test build shows the page that says so
// (apps/frontend/src/headless.ts) so the native shell can still be accepted; a
// production build refuses. `--without-renderer` compiles only this
// repository's main and preload (SSH acceptance, public type and lint checks).
if (process.argv.slice(2).some(flag => flag !== '--without-renderer')) throw new Error('DESKTOP_BUILD_ARGUMENTS_INVALID')
const withRenderer = !process.argv.includes('--without-renderer')
if (withRenderer && flavor === 'prod' && !process.env.MIKKA_UI_OVERLAY_DIR?.trim()) throw new Error('DESKTOP_PRODUCTION_BUILD_REQUIRES_OFFICIAL_UI')
if (withRenderer) await buildRenderer({ outdir: resolve(outdir, 'renderer') })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define,
  logLevel: 'info',
}

await build({ ...common, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(outdir, 'main.cjs'), sourcemap: flavor === 'dev' })
await build({ ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(outdir, 'preload.cjs'), sourcemap: flavor === 'dev' })
await cp(resolve(root, 'src/offline.html'), resolve(outdir, 'offline.html'))
await cp(resolve(root, 'src/update.html'), resolve(outdir, 'update.html'))

if (process.env.MIKKA_UI_OVERLAY_DIR) await desktopOverlayEvidence(outdir, process.env.MIKKA_UI_OVERLAY_SHA)

console.log(`built @mikka/desktop ${pkg.version} (${flavor}) -> ${appUrl}`)
