import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SHA40 = /^[0-9a-f]{40}$/
export const REQUIRED_UI_POLICY_CHECKS = new Set(['Cloudflare UI Policy', 'UI policy'])
export const ALLOWED_PROBE_ENV_KEYS = Object.freeze([
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
])

/**
 * Strictly validates docs/operations/releases/deploy-build-inputs.json.
 * Returns { version: 1, overlaySource } or throws on malformed input.
 */
export function parseDeployBuildInputs(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('deploy-build-inputs must be a JSON object')
  }
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 2 || keys[0] !== 'overlaySource' || keys[1] !== 'version') {
    throw new Error('deploy-build-inputs must contain only version and overlaySource')
  }
  if (parsed.version !== 1) {
    throw new Error('deploy-build-inputs version must be 1')
  }
  if (typeof parsed.overlaySource !== 'string' || !SHA40.test(parsed.overlaySource)) {
    throw new Error('deploy-build-inputs overlaySource must be a 40-char lowercase hex SHA')
  }
  return { version: 1, overlaySource: parsed.overlaySource }
}

/**
 * Extracts normalized overlay-scoped TypeScript diagnostic keys from tsrs/tsc output.
 * Keys are internal comparison identifiers only and are never emitted to public logs.
 */
export function parseOverlayTypeErrors(rawOutput) {
  const entries = new Map()
  for (const line of String(rawOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^(.*?)\((\d+),(\d+)\):\s+error\s+(TS\d+):/)
    if (!match) continue
    const [, rawPath, lineNo, colNo, code] = match
    const normalized = rawPath.replaceAll('\\', '/')
    const markerIdx = normalized.lastIndexOf('/.hosted-ui/')
    let relPath = null
    if (markerIdx >= 0) relPath = normalized.slice(markerIdx + 1)
    else if (normalized.startsWith('.hosted-ui/')) relPath = normalized
    if (!relPath) continue
    entries.set(`${relPath}:${lineNo}:${colNo}:${code}`, { code })
  }
  return entries
}

/**
 * Compares overlay diagnostics on the integration branch against main using the
 * exact same overlay SHA. Returns only public-safe counts and TS error codes.
 */
export function diffOverlayTypeErrors(mainOutput, integrationOutput) {
  const baseline = parseOverlayTypeErrors(mainOutput)
  const candidate = parseOverlayTypeErrors(integrationOutput)
  const codes = new Set()
  let newErrorCount = 0
  for (const [key, entry] of candidate) {
    if (!baseline.has(key)) {
      newErrorCount++
      codes.add(entry.code)
    }
  }
  return {
    newErrorCount,
    newErrorCodes: [...codes].sort(),
  }
}

/**
 * Evaluates whether the integration branch needs an automated back-merge PR
 * from main (open, forward-merge when either main OR integration base moved,
 * close redundant, record verified CI evidence, or merge into the non-main
 * integration branch).
 */
export function evaluateAutoSyncPlan({
  branch,
  aheadBy,
  behindBy,
  featureChildCount,
  syncPr,
  syncPrIncludesMain,
  syncPrIncludesBase = true,
  syncPrCiOk,
  syncPrCiRunUrl,
  syncPrAcceptanceState,
  syncPrMergeable,
}) {
  if (!branch || branch === 'main') {
    return { action: 'noop', reason: 'refusing auto-sync when target branch is main or empty.' }
  }
  if (aheadBy <= 0) {
    return { action: 'noop', reason: `\`${branch}\` has no commits ahead of \`main\`.` }
  }
  if (behindBy <= 0 && !syncPr) {
    return { action: 'noop', reason: `\`${branch}\` is already up to date with \`main\`.` }
  }
  if (featureChildCount > 0) {
    return { action: 'noop', reason: `waiting for ${featureChildCount} open Ready feature PR(s) targeting \`${branch}\` before auto-syncing \`main\`.` }
  }
  if (syncPr) {
    if (syncPr.baseRef !== branch || syncPr.baseRef === 'main') {
      return { action: 'noop', reason: `sync PR #${syncPr.number} base (\`${syncPr.baseRef}\`) does not safely match \`${branch}\`.` }
    }
    if (syncPr.draft) {
      return { action: 'noop', reason: `sync PR #${syncPr.number} is Draft; skipping automated sync.` }
    }
    if (behindBy <= 0) {
      return { action: 'close_redundant_sync_pr', reason: `close redundant sync PR #${syncPr.number} because \`${branch}\` is already 0 commits behind \`main\`.` }
    }
    if (!syncPrIncludesMain || !syncPrIncludesBase) {
      const staleParts = []
      if (!syncPrIncludesMain) staleParts.push('`main`')
      if (!syncPrIncludesBase) staleParts.push(`\`${branch}\``)
      return {
        action: 'update_sync_pr',
        reason: `forward-merge latest ${staleParts.join(' and ')} onto open sync PR #${syncPr.number} so CI validates the exact combined revision.`,
      }
    }
    if (!syncPr.bodyHasHeadSha) {
      return { action: 'reset_sync_acceptance', reason: `reset sync PR #${syncPr.number} acceptance to pending for updated head \`${syncPr.headSha}\`.` }
    }
    if (!syncPrCiOk || !syncPrCiRunUrl) {
      return { action: 'noop', reason: `waiting for CI aggregator checks to pass on sync PR #${syncPr.number}.` }
    }
    if (!syncPr.bodyHasCiRunUrl) {
      return { action: 'record_sync_evidence', reason: `record verified CI evidence on sync PR #${syncPr.number}.` }
    }
    if (syncPrAcceptanceState !== 'success') {
      return { action: 'noop', reason: `waiting for PR acceptance status to pass on sync PR #${syncPr.number} (currently \`${syncPrAcceptanceState}\`).` }
    }
    if (syncPrMergeable !== 'MERGEABLE') {
      return { action: 'noop', reason: `sync PR #${syncPr.number} is not mergeable (\`${syncPrMergeable}\`).` }
    }
    return { action: 'merge_sync_pr', reason: `merge verified sync PR #${syncPr.number} into \`${branch}\` via normal merge commit.` }
  }
  return { action: 'open_sync_pr', reason: `open clean back-merge PR syncing ${behindBy} commit(s) from \`main\` into \`${branch}\`.` }
}

/**
 * Selects ordered overlay candidates to probe against the integration branch:
 *   1. pinned_overlay: current approved overlaySource from mikka-cloud/main
 *      (unless explicitly blocked by frozenOverlaySha).
 *   2. coordinated_ui_pr: an open Ready PR on the private UI repository from
 *      the same integration branch into main whose own UI policy checks passed
 *      and which has zero open Ready child PRs targeting its integration branches.
 */
export function selectPairingCandidates({
  pinnedOverlaySha,
  frozenOverlaySha = '',
  hostedUiPr = null,
  hostedUiChildCount = 0,
  hostedUiPolicyOk = false,
}) {
  const candidates = []
  if (SHA40.test(pinnedOverlaySha ?? '') && pinnedOverlaySha !== frozenOverlaySha) {
    candidates.push({ mode: 'pinned_overlay', sha: pinnedOverlaySha })
  }
  if (
    hostedUiPr
    && hostedUiPr.draft === false
    && hostedUiPr.baseRef === 'main'
    && hostedUiChildCount === 0
    && hostedUiPolicyOk === true
    && SHA40.test(hostedUiPr.headSha ?? '')
    && hostedUiPr.headSha !== frozenOverlaySha
    && hostedUiPr.headSha !== pinnedOverlaySha
  ) {
    candidates.push({
      mode: 'coordinated_ui_pr',
      sha: hostedUiPr.headSha,
      prNumber: hostedUiPr.number,
    })
  }
  return candidates
}

/**
 * Determines whether a set of GitHub check runs on the private UI PR satisfies
 * the UI policy requirement (completed + success on a recognized UI policy check).
 */
export function hasPassingUiPolicyCheck(checkRuns) {
  if (!Array.isArray(checkRuns)) return false
  return checkRuns.some(
    run => REQUIRED_UI_POLICY_CHECKS.has(run?.name) && run?.status === 'completed' && run?.conclusion === 'success',
  )
}

/**
 * Computes the final effective promotion action after applying emergency freeze,
 * shippable pinned-overlay compatibility, explicit break-glass flags, and dry-run.
 *
 * By default ONLY `overlayMode === 'pinned_overlay'` authorizes creating or
 * enqueueing a promotion PR into main, because cloudflare-api-image.yml builds
 * main strictly against the approved overlaySource pin in mikka-cloud/main.
 * A passing `coordinated_ui_pr` is treated as readiness diagnostics only unless
 * `allowCoordinatedUnpinned` is explicitly enabled as an operator break-glass.
 */
export function evaluatePromotionGate({
  frozen,
  dryRun,
  skipOverlayProbe = false,
  allowCoordinatedUnpinned = false,
  plannedAction,
  plannedReason,
  overlayProbeRan,
  overlayCompatible,
  overlayMode,
  overlaySummary,
}) {
  if (frozen) {
    return {
      effectiveAction: 'noop',
      effectiveReason: `promotion paused by \`vars.MIKKA_INTEGRATION_PROMOTE_FREEZE=true\` (planned: \`${plannedAction}\`: ${plannedReason}).`,
    }
  }
  if (plannedAction === 'noop') {
    return { effectiveAction: 'noop', effectiveReason: plannedReason }
  }
  const requiresCompatibility = plannedAction === 'create_pr' || plannedAction === 'enqueue_pr'
  const pinnedCompatible = overlayProbeRan && overlayCompatible && overlayMode === 'pinned_overlay'
  const coordinatedCompatible = overlayProbeRan && overlayCompatible && overlayMode === 'coordinated_ui_pr'
  const compatibilityAuthorized = skipOverlayProbe
    || pinnedCompatible
    || (allowCoordinatedUnpinned && coordinatedCompatible)

  if (requiresCompatibility && !compatibilityAuthorized) {
    if (!overlayProbeRan) {
      return {
        effectiveAction: 'noop',
        effectiveReason: `fail-closed: cross-repo overlay compatibility probe did not complete (${overlaySummary || 'no probe result'}).`,
      }
    }
    if (coordinatedCompatible) {
      return {
        effectiveAction: 'noop',
        effectiveReason: `readiness evidence only: coordinated UI PR paired cleanly, but approved \`overlaySource\` pin is not yet compatible (${overlaySummary}); pin the compatible UI commit in mikka-cloud before enqueueing \`main\` (or set \`MIKKA_INTEGRATION_ALLOW_COORDINATED_UNPINNED_PROMOTE=true\` for an intentional paired-order break-glass).`,
      }
    }
    return {
      effectiveAction: 'noop',
      effectiveReason: `waiting for approved \`overlaySource\` pin compatibility (${overlaySummary || 'overlay build/typecheck incompatible'}).`,
    }
  }
  if (dryRun) {
    const compatNote = !requiresCompatibility
      ? 'probe not required for this step'
      : skipOverlayProbe
        ? 'explicit MIKKA_INTEGRATION_SKIP_OVERLAY_PROBE break-glass active'
        : pinnedCompatible
          ? 'approved pinned_overlay compatible'
          : 'coordinated_ui_pr break-glass authorized'
    return {
      effectiveAction: 'noop',
      effectiveReason: `dry run requested (live run would execute \`${plannedAction}\` [${compatNote}]: ${plannedReason}).`,
    }
  }
  return { effectiveAction: plannedAction, effectiveReason: plannedReason }
}

/**
 * Builds a strict allowlist-only environment for candidate compilation so no
 * GitHub Actions command files (GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, GITHUB_ENV),
 * runner paths, OIDC tokens, or App credentials are exposed to integration code.
 */
export function buildMinimalProbeEnv(baseEnv = process.env, extra = {}) {
  const env = {}
  for (const key of ALLOWED_PROBE_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key].length > 0) {
      env[key] = baseEnv[key]
    }
  }
  return {
    HOME: '/tmp',
    TMPDIR: '/tmp',
    ...env,
    ...extra,
  }
}

/**
 * Builds docker run arguments enforcing --network none, dropped capabilities,
 * read-only .git metadata (so candidate code can never tamper with host Git),
 * and an allowlist-only container environment.
 */
export function buildIsolatedDockerArgs({
  dockerImage,
  workDir,
  mounts,
  envVars,
  cmd,
}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const args = [
    'run', '--rm',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
  ]
  for (const mount of mounts) {
    args.push('-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`)
  }
  args.push('-w', workDir)
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`)
  }
  args.push(dockerImage, ...cmd)
  return args
}

function runQuiet(bin, args, { cwd, env, timeoutMs = 300_000 }) {
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  }
}

/**
 * Verifies one exact (integrationDir, mainDir, overlaySha) pairing using two
 * pre-installed independent checkouts (`integrationDir` with `.hosted-ui/` and
 * clean `mainDir` with its own pre-installed `node_modules`). Never runs host
 * `git checkout` or `pnpm install` after candidate code executes.
 *
 * When `dockerImage` is supplied (a digest-pinned Node 24 + Git image), every
 * build/audit/typecheck command executes inside `--network none` with all `.git`
 * directories mounted read-only (and `mainDir` mounted fully read-only).
 * Returns strictly public-safe booleans, counts, and TS error codes.
 */
export function verifyPairingInWorkspace({
  integrationDir,
  mainDir,
  overlaySha,
  mode,
  dockerImage = '',
  env = process.env,
}) {
  if (!SHA40.test(overlaySha)) {
    throw new Error('verifyPairingInWorkspace requires a 40-char hex overlaySha')
  }
  const absIntegration = resolve(integrationDir)
  const absMain = resolve(mainDir)
  const overlayDir = resolve(absIntegration, '.hosted-ui')
  if (!existsSync(resolve(overlayDir, 'tsconfig.json')) || !existsSync(absMain)) {
    return {
      compatible: false,
      mode,
      overlayShaShort: overlaySha.slice(0, 8),
      webBuildOk: false,
      actionContractOk: false,
      auditOk: false,
      newTypeErrorCount: -1,
      newErrorCodes: [],
    }
  }

  const integrationProbeVars = {
    HOME: '/tmp',
    TMPDIR: '/tmp',
    MIKKA_UI_OVERLAY_DIR: overlayDir,
    MIKKA_UI_OVERLAY_SHA: overlaySha,
    MIKKA_DEPLOYMENT_STAGE: 'preview',
    MIKKA_PUBLIC_POSTHOG_KEY: 'phc_synthetic_ssr_regression',
  }
  const hostMinimalEnv = buildMinimalProbeEnv(env, integrationProbeVars)
  const nodeBin = dockerImage ? 'node' : process.execPath

  const integrationMounts = [{ source: absIntegration, target: absIntegration, readOnly: false }]
  if (existsSync(resolve(absIntegration, '.git'))) {
    integrationMounts.push({ source: resolve(absIntegration, '.git'), target: resolve(absIntegration, '.git'), readOnly: true })
  }
  if (existsSync(resolve(overlayDir, '.git'))) {
    integrationMounts.push({ source: resolve(overlayDir, '.git'), target: resolve(overlayDir, '.git'), readOnly: true })
  }

  const runOnIntegration = (bin, args, timeoutMs = 300_000) => {
    if (dockerImage) {
      const dockerArgs = buildIsolatedDockerArgs({
        dockerImage,
        workDir: absIntegration,
        mounts: integrationMounts,
        envVars: integrationProbeVars,
        cmd: [bin, ...args],
      })
      return runQuiet('docker', dockerArgs, { cwd: absIntegration, env: hostMinimalEnv, timeoutMs })
    }
    return runQuiet(bin, args, { cwd: absIntegration, env: hostMinimalEnv, timeoutMs })
  }

  // 1. Official Web build (exact FRONTEND release stage).
  const webBuild = runOnIntegration(nodeBin, ['apps/frontend/scripts/build.mjs', 'web'], 300_000)

  let actionContractOk = false
  let auditOk = false
  if (webBuild.ok) {
    const contractScript = `
      import assert from 'node:assert/strict'
      import { readFile } from 'node:fs/promises'
      import { rendererActionContract } from './lib/renderer-actions.mjs'
      import { publishedReadActions } from './scripts/acceptance/read-action-transport.mjs'
      const manifest = JSON.parse(await readFile('apps/frontend/dist/web/renderer-manifest.json', 'utf8'))
      assert.notEqual(manifest.headless, true)
      const contract = rendererActionContract(manifest)
      assert.ok(contract.usedActions.length > 0)
      publishedReadActions(manifest)
    `
    const contractCheck = runOnIntegration(nodeBin, ['--import', 'tsx', '--input-type=module', '-e', contractScript], 60_000)
    actionContractOk = contractCheck.ok

    const auditCheck = runOnIntegration(nodeBin, ['scripts/release/hosted-ui.mjs', 'audit', 'apps/frontend/dist/web'], 60_000)
    auditOk = auditCheck.ok
  }

  // 2. Zero-regression overlay TypeScript contract check against separate read-only main checkout.
  const intTsrs = resolve(absIntegration, 'node_modules/.bin/tsrs')
  const intTsc = existsSync(intTsrs) ? intTsrs : resolve(absIntegration, 'node_modules/.bin/tsc')
  const integrationTypecheck = runOnIntegration(
    intTsc,
    ['--noEmit', '--incremental', 'false', '-p', resolve(overlayDir, 'tsconfig.json')],
    180_000,
  )

  let newTypeErrorCount = 0
  let newErrorCodes = []
  const integrationErrors = parseOverlayTypeErrors(integrationTypecheck.output)
  if (!integrationTypecheck.ok && integrationErrors.size === 0) {
    newTypeErrorCount = -1
  } else if (integrationErrors.size > 0) {
    const mainOverlayMountTarget = resolve(absMain, '.hosted-ui')
    const mainTsrs = resolve(absMain, 'node_modules/.bin/tsrs')
    const mainTsc = existsSync(mainTsrs) ? mainTsrs : resolve(absMain, 'node_modules/.bin/tsc')

    let mainTypecheck
    if (dockerImage) {
      // Ensure mountpoint exists inside absMain before mounting absMain read-only.
      mkdirSync(mainOverlayMountTarget, { recursive: true })
      const mainProbeVars = {
        HOME: '/tmp',
        TMPDIR: '/tmp',
        MIKKA_UI_OVERLAY_DIR: mainOverlayMountTarget,
        MIKKA_UI_OVERLAY_SHA: overlaySha,
      }
      const dockerArgs = buildIsolatedDockerArgs({
        dockerImage,
        workDir: absMain,
        mounts: [
          { source: absMain, target: absMain, readOnly: true },
          { source: overlayDir, target: mainOverlayMountTarget, readOnly: true },
        ],
        envVars: mainProbeVars,
        cmd: [mainTsc, '--noEmit', '--incremental', 'false', '-p', resolve(mainOverlayMountTarget, 'tsconfig.json')],
      })
      mainTypecheck = runQuiet('docker', dockerArgs, { cwd: absMain, env: hostMinimalEnv, timeoutMs: 180_000 })
    } else {
      const mainOverlayPath = existsSync(resolve(mainOverlayMountTarget, 'tsconfig.json'))
        ? mainOverlayMountTarget
        : overlayDir
      mainTypecheck = runQuiet(
        mainTsc,
        ['--noEmit', '--incremental', 'false', '-p', resolve(mainOverlayPath, 'tsconfig.json')],
        { cwd: absMain, env: buildMinimalProbeEnv(env, { HOME: '/tmp', TMPDIR: '/tmp' }), timeoutMs: 180_000 },
      )
    }

    const mainErrors = parseOverlayTypeErrors(mainTypecheck.output)
    if (!mainTypecheck.ok && mainErrors.size === 0) {
      newTypeErrorCount = -1
    } else {
      const delta = diffOverlayTypeErrors(mainTypecheck.output, integrationTypecheck.output)
      newTypeErrorCount = delta.newErrorCount
      newErrorCodes = delta.newErrorCodes
    }
  }

  const compatible = webBuild.ok && actionContractOk && auditOk && newTypeErrorCount === 0
  return {
    compatible,
    mode,
    overlayShaShort: overlaySha.slice(0, 8),
    webBuildOk: webBuild.ok,
    actionContractOk,
    auditOk,
    newTypeErrorCount,
    newErrorCodes,
  }
}

function parseCliArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    args[token.slice(2)] = argv[++i] ?? ''
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const args = parseCliArgs(rest)
  if (command === 'parse-deploy-inputs') {
    const parsed = parseDeployBuildInputs(readFileSync(args.file, 'utf8'))
    process.stdout.write(`${JSON.stringify(parsed)}\n`)
    return
  }
  if (command === 'plan-auto-sync') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(evaluateAutoSyncPlan(input))}\n`)
    return
  }
  if (command === 'select-candidates') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(selectPairingCandidates(input))}\n`)
    return
  }
  if (command === 'evaluate-gate') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(evaluatePromotionGate(input))}\n`)
    return
  }
  if (command === 'verify-pairing') {
    const result = verifyPairingInWorkspace({
      integrationDir: args['integration-dir'],
      mainDir: args['main-dir'],
      overlaySha: args['overlay-sha'],
      mode: args.mode || 'pinned_overlay',
      dockerImage: args['docker-image'] || '',
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  throw new Error(`Unknown command: ${command ?? '(none)'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
