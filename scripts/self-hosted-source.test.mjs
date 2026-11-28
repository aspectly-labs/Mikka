import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { dependencyTestCommand, isSelfHostedAcceptanceTest } from './ci/self-hosted-requirements.mjs'

const root = new URL('../', import.meta.url)

test('published runtime, deployment and build sources cannot restore the retired workspace switch', () => {
  // Two upgrade regression tests must still pass an obsolete setting to prove it is ignored.
  const allowed = ['apps/api/runtime/server-page.test.ts', 'lib/server-info.test.ts']
  const flag = ['MIKKA', 'COMMUNITY', 'UI'].join('_')
  const scan = spawnSync('git', ['grep', '--fixed-strings', '--files-with-matches', '-I', '-e', flag,
    '--', '.', ':(exclude,glob)**/*.md', ':(exclude,glob)*.md', ...allowed.map(file => ':(exclude)' + file)],
  { cwd: root, encoding: 'utf8' })
  if (scan.error) throw scan.error
  assert.equal(scan.status, 1, scan.stderr || 'Remove the retired workspace flag from: ' + scan.stdout.trim())
})

test('every declaration in config/self-hosted-requirements.json points to an existing source file, valid acceptance test, and runnable suite', () => {
  const declarations = JSON.parse(readFileSync(new URL('config/self-hosted-requirements.json', root), 'utf8'))
  const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts
  const errors = []
  for (const [file, spec] of Object.entries(declarations)) {
    if (!existsSync(new URL(file, root))) errors.push(`${file}: declared source file no longer exists`)
    if (!['built-in', 'operator-configured', 'optional-cloud'].includes(spec?.mode)
      || !Array.isArray(spec?.environment) || !spec.environment.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]+$/.test(key))
      || typeof spec?.behavior !== 'string' || spec.behavior.trim().length < 1) {
      errors.push(`${file}: invalid mode, environment, or behavior declaration`)
    }
    if (typeof spec?.test !== 'string' || !isSelfHostedAcceptanceTest(spec.test)) {
      errors.push(`${file}: missing declared acceptance test ${String(spec?.test)}`)
      continue
    }
    try {
      dependencyTestCommand(spec, scripts)
    } catch (error) {
      errors.push(`${file}: ${error.message}`)
    }
  }
  assert.deepEqual(errors, [])
})

test('Node 24 toolchain lock files and package engines stay consistent across the workspace', () => {
  const nodeVersion = readFileSync(new URL('.node-version', root), 'utf8').trim()
  const nvmrc = readFileSync(new URL('.nvmrc', root), 'utf8').trim()
  assert.equal(nodeVersion, '24')
  assert.equal(nvmrc, nodeVersion)
  const pnpmInstall = readFileSync(new URL('.github/actions/pnpm-install/action.yml', root), 'utf8')
  assert.match(pnpmInstall, /^\s*default:\s*['"]?24['"]?(?:\s+(?:#.*)?)?\s*$/m)
  const files = execFileSync('git', ['ls-files', '-z', '--', '**/package.json', 'package.json'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  for (const file of files) {
    const pkg = JSON.parse(readFileSync(new URL(file, root), 'utf8'))
    if (pkg.engines?.node) assert.equal(pkg.engines.node, '>=22', file)
  }
})
