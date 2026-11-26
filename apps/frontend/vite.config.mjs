import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { applicationPlugin, frontend, repository } from './scripts/application-plugin.mjs'
import { deploymentPlugin, pinnedUrl } from './scripts/deployment-plugin.mjs'
import { uiOverlay } from '../../lib/ui-overlay.mjs'
import { configuredDeploymentId } from '../../lib/deployment-id.mjs'
import { deploymentStage } from '../../lib/deployment-stage.mjs'
import { installationBuild } from '../../scripts/build-installation.mjs'
import { sharedStylePlugins } from './scripts/shared-styles.mjs'
import { publicEnv, withLegacyPublicDefines } from '../../lib/public-env.mjs'
import { envTrimmed, envValue, runtimeEnv } from '../../lib/env/runtime.mjs'

// One process describes one revision. Resolving this per call means an
// intermittent `git` spawn failure lands in the `catch` below and silently turns
// a later build of the same process into a different application: every module
// that reads MIKKA_PUBLIC_BUILD is emitted with a different constant, which
// renames and rewrites every chunk that transitively imports one.
let resolvedApplicationBuild

function applicationBuild() {
  if (resolvedApplicationBuild !== undefined) return resolvedApplicationBuild
  const configured = publicEnv('MIKKA_PUBLIC_BUILD') ?? envValue('MIKKA_BUILD_REVISION')
  if (configured !== undefined) resolvedApplicationBuild = configured
  else {
    try { resolvedApplicationBuild = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { resolvedApplicationBuild = '' }
  }
  return resolvedApplicationBuild
}

/** The UI checkout's data-track-owner plugin (its scripts/track-owner/vite-plugin.mjs), when it has one. The plugin
 * decides whether it writes anything: MIKKA_TRACK_OWNER=1|0, else on for the dev server and off for a production
 * build, so production ships no owners unless analytics asks for them. */
export async function trackOwnerPlugins(overlay) {
  const path = overlay.dir && resolve(overlay.dir, 'scripts/track-owner/vite-plugin.mjs')
  if (!path || !existsSync(path)) return []
  const { trackOwnerPlugin } = await import(pathToFileURL(path).href)
  return [trackOwnerPlugin({ root: overlay.dir })]
}

export async function frontendConfig({ target = 'web', command = 'build', outdir, clean = true } = {}) {
  if (!['web', 'desktop'].includes(target)) throw new Error('FRONTEND_TARGET_INVALID')
  if (!['build', 'serve'].includes(command)) throw new Error('FRONTEND_COMMAND_INVALID')
  const stage = deploymentStage()
  const development = command === 'serve'
  const env = runtimeEnv()
  const directory = envTrimmed('MIKKA_UI_OVERLAY_DIR', env)
  // A development server may run an unpinned checkout; every other build is
  // either a declared official build (checkout and revision) or has no UI.
  if (!(development && directory && !envValue('MIKKA_UI_OVERLAY_SHA', env))) {
    await installationBuild({ ...env, MIKKA_UI_OVERLAY_DIR: directory && resolve(repository, directory) })
  }
  const overlay = uiOverlay(repository)
  const deploymentId = target === 'web' && !development ? configuredDeploymentId() ?? '' : ''
  return {
    configFile: false,
    root: frontend,
    base: '/mikka/',
    publicDir: resolve(repository, 'public'),
    // Never auto-export VITE_* or load a developer/backend credential file.
    envDir: false,
    envPrefix: [],
    logLevel: 'warn',
    // Public settings take their new MIKKA_PUBLIC_* name first and their
    // legacy NEXT_PUBLIC_* name second (lib/public-env.mjs); an empty value
    // counts as unset. Each is also inlined under the legacy name until
    // phase 2 of the rename.
    define: {
      ...withLegacyPublicDefines({
        'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
        'process.env.MIKKA_BASE_PATH': '"/mikka"',
        'process.env.MIKKA_PUBLIC_BUILD': JSON.stringify(target === 'web' && !development ? applicationBuild() : ''),
        'process.env.MIKKA_DEPLOYMENT_ID': JSON.stringify(deploymentId),
        // This is the existing explicitly public anti-bot widget key. Desktop
        // never imports its browser auth forms or third-party script loader.
        'process.env.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY', env, '') : ''),
        'process.env.MIKKA_PUBLIC_TURNSTILE_SITE_KEY': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_TURNSTILE_SITE_KEY', env, '') : ''),
        'process.env.POSTHOG_HOST': JSON.stringify(target === 'web' ? publicEnv('POSTHOG_HOST', env, '') : ''),
        'process.env.MIKKA_PUBLIC_POSTHOG_KEY': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_POSTHOG_KEY', env, '') : ''),
        'process.env.MIKKA_PUBLIC_COMPUTER_ACCEPTANCE': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_COMPUTER_ACCEPTANCE', env, '') : ''),
        'process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT': JSON.stringify(target === 'web' ? stage ?? '' : ''),
        'process.env.MIKKA_PUBLIC_COMPUTER_ENABLED': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_COMPUTER_ENABLED', env, '') : ''),
        'process.env.MIKKA_PUBLIC_COMPUTER_MOCK': JSON.stringify(target === 'web' ? publicEnv('MIKKA_PUBLIC_COMPUTER_MOCK', env, '') : ''),
        'process.env.MIKKA_DAEMON_PACKAGE_NAME': JSON.stringify(target === 'web' ? publicEnv('MIKKA_DAEMON_PACKAGE_NAME', env, '@aspectlylabs/mikka') : ''),
      }),
      'process.env': '{}',
    },
    plugins: [...await trackOwnerPlugins(overlay), await applicationPlugin(target, { deploymentId, overlay }), react(), await deploymentPlugin({ repository, deploymentId })],
    experimental: deploymentId ? { renderBuiltUrl: filename => pinnedUrl(`/mikka/${filename}`, deploymentId) } : {},
    // The official UI checkout (docs/ui-overlay.md) carries its own node_modules; React stays this repository's.
    resolve: { dedupe: ['react', 'react-dom'] },
    css: { postcss: { plugins: sharedStylePlugins(repository, { development, overlay }) } },
    build: {
      outDir: outdir ?? resolve(frontend, `dist/${target}`),
      emptyOutDir: clean,
      target: target === 'desktop' ? 'chrome130' : 'baseline-widely-available',
      sourcemap: false,
      // The preceding pass already uses the existing web minifier/targets.
      cssMinify: false,
      manifest: true,
      reportCompressedSize: false,
      rolldownOptions: {
        onwarn(warning, defaultHandler) {
          // "use client" is a boundary in the server compiler. Every module
          // here is already browser-only, and server imports fail above.
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
          defaultHandler(warning)
        },
      },
    },
  }
}

export default defineConfig(({ command, mode }) => frontendConfig({ command, target: mode === 'desktop' ? 'desktop' : 'web' }))
