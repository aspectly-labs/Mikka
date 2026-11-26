import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  RULE_ALLOWLISTS,
  globToRegExp,
  isAllowedPath,
  normalizeRepoPath,
} from './oxlint-plugin-mikka.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OXLINT_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
const PLUGIN_PATH = path.join(REPO_ROOT, 'scripts', 'oxlint-plugin-mikka.mjs')

function withFixtureRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikka-anti-hardcoding-'))
  try {
    const configPath = path.join(dir, 'oxlintrc.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        jsPlugins: [PLUGIN_PATH],
        categories: { correctness: 'off' },
        rules: {
          'mikka/no-raw-process-env': 'error',
          'mikka/no-plan-name-branching': 'error',
          'mikka/no-hardcoded-model-ids': 'error',
          'mikka/no-hardcoded-hosts': 'error',
        },
      }),
    )

    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(dir, relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, content, 'utf8')
    }

    const runOxlint = (...targets) => {
      const res = spawnSync(
        OXLINT_BIN,
        ['-c', configPath, '--format', 'json', ...targets],
        { cwd: dir, encoding: 'utf8' },
      )
      assert.equal(res.error, undefined, `oxlint spawn failed: ${res.error?.message}`)
      let parsed
      try {
        parsed = JSON.parse(res.stdout)
      } catch (error) {
        assert.fail(`oxlint did not return JSON (status=${res.status}):\nstdout=${res.stdout}\nstderr=${res.stderr}\n${error.message}`)
      }
      return {
        status: res.status,
        diagnostics: parsed.diagnostics ?? [],
        stderr: res.stderr,
      }
    }

    return fn({ dir, runOxlint })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('helper globToRegExp / isAllowedPath / normalizeRepoPath handle nested and root paths', () => {
  assert.equal(globToRegExp('**/test/**').test('test/foo.ts'), true)
  assert.equal(globToRegExp('**/test/**').test('packages/daemon/test/foo.ts'), true)
  assert.equal(globToRegExp('**/*.test.*').test('foo.test.ts'), true)
  assert.equal(globToRegExp('**/*.test.*').test('lib/a/b/foo.db.test.ts'), true)
  assert.equal(isAllowedPath('lib/env/hosts.ts', RULE_ALLOWLISTS['no-raw-process-env']), true)
  assert.equal(isAllowedPath('lib/environment.ts', RULE_ALLOWLISTS['no-raw-process-env']), false)
  assert.equal(isAllowedPath('next.config.mjs', RULE_ALLOWLISTS['no-raw-process-env']), true)
  assert.equal(isAllowedPath('drizzle.config.ts', RULE_ALLOWLISTS['no-raw-process-env']), true)
  assert.equal(normalizeRepoPath('/repo/lib/foo.ts', '/repo'), 'lib/foo.ts')
})

test('G1 no-raw-process-env: flags process.env, globalThis/global.process.env, destructuring, and process env imports; allows lib/env/** and safe forms', () => {
  withFixtureRepo(
    {
      'lib/bad-env.ts': [
        "import { env } from 'node:process'",
        "import { env as procEnv } from 'process'",
        "import { cwd } from 'node:process'",
        "import type { env as EnvType } from 'node:process'",
        'export const a = process.env.SECRET',
        'export const b = process.env',
        "export const c = process['env'].TOKEN",
        'export const d = globalThis.process.env.API_KEY',
        'export const e = globalThis?.process?.env?.STAGE',
        'export const f = global.process.env.GLOBAL_SECRET',
        'export const g = global?.process?.env?.GLOBAL_STAGE',
        'const { env: destructured1 } = process',
        'const { env: destructured2 } = globalThis.process',
        "const { ['env']: destructured3 } = global.process",
        'const { env: { NESTED_KEY } } = process',
        'const { cwd: processCwd } = process',
        'const { env: localEnv } = { env: { ok: true } }',
        'export const ok1 = process.cwd() + global.process.cwd() + cwd()',
        "export const ok2 = 'process.env.NOT_CODE'",
        '// process.env.COMMENT_ONLY',
        'export type T = typeof EnvType',
        'export const used = [env, procEnv, destructured1, destructured2, destructured3, NESTED_KEY, processCwd, localEnv]',
      ].join('\n'),
      'lib/env/server.ts': [
        "import { env } from 'node:process'",
        'export const secret = process.env.SECRET',
        'export const globalSecret = globalThis.process.env.TOKEN',
        'export const legacyGlobalSecret = global.process.env.TOKEN',
        'const { env: destructured } = process',
        'export const out = [env, destructured]',
      ].join('\n'),
      'lib/bad-env.test.ts': 'export const testEnv = process.env.TEST_KEY\n',
      'next.config.mjs': 'export const cfg = { env: process.env.NODE_ENV }\n',
      'playwright.config.ts': 'export const baseURL = process.env.PLAYWRIGHT_BASE_URL\n',
    },
    ({ runOxlint }) => {
      const bad = runOxlint('lib/bad-env.ts')
      assert.equal(bad.status, 1)
      const g1 = bad.diagnostics.filter(d => d.code === 'mikka(no-raw-process-env)')
      // 2 ESM imports + 7 member accesses (process/globalThis/global) + 4 destructurings = 13
      assert.equal(g1.length, 13)

      const allowed = runOxlint('lib/env/server.ts', 'lib/bad-env.test.ts', 'next.config.mjs', 'playwright.config.ts')
      assert.equal(allowed.status, 0)
      assert.equal(allowed.diagnostics.length, 0)
    },
  )
})

test('G3 no-plan-name-branching: flags plan & plan-derived edition comparisons, normalized chains, broader plan identifiers, and plan-keyed object lookups; allows capabilities, community/personal edition checks, and policy files', () => {
  withFixtureRepo(
    {
      'lib/bad-plan.ts': [
        'export function check(summary: {',
        '  plan: string',
        '  billingPlan: string',
        '  entitlementPlan: string',
        '  workspacePlan: string',
        '  currentPlan: string',
        '  orgPlan: string',
        '  planId: string',
        '  planName: string',
        '  org_plan: string',
        '  edition: string',
        '  capabilities: { canUseEnterpriseGovernance: boolean }',
        '}) {',
        "  const a = summary.plan === 'enterprise'",
        "  const b = 'free' !== summary.entitlementPlan",
        "  const c = summary.billingPlan == 'starter'",
        "  const d = ['pro', 'enterprise'].includes(summary.plan)",
        "  const e = new Set(['pro', 'enterprise']).has(summary.plan)",
        "  const PAID = ['pro', 'max'] as const",
        '  const f = PAID.includes(summary.billingPlan)',
        '  let g = false',
        '  switch (summary.plan) {',
        "    case 'enterprise':",
        '      g = true',
        '      break',
        '  }',
        "  const h = summary.edition === 'team_free'",
        "  const i = summary.edition !== 'team_pro'",
        "  const j = 'enterprise' === summary.edition",
        "  const k = ['team_pro', 'enterprise'].includes(summary.edition)",
        "  const l = new Set(['team_free', 'team_pro']).has(summary.edition)",
        '  let m = false',
        '  switch (summary.edition) {',
        "    case 'team_pro':",
        '      m = true',
        '      break',
        "    case 'community':",
        "    case 'personal':",
        '      break',
        '  }',
        "  const n = summary.workspacePlan === 'pro'",
        "  const o = summary.currentPlan !== 'free'",
        "  const p = summary.orgPlan === 'enterprise'",
        "  const q = summary.planId === 'starter'",
        "  const r = summary.planName === 'max'",
        "  const s = summary.org_plan === 'pro'",
        "  const t = summary.plan.toLowerCase() === 'enterprise'",
        "  const u = summary.plan.trim() !== 'free'",
        "  const v = summary.workspacePlan?.trim()?.toLowerCase() === 'pro'",
        "  const w = summary.edition.trim().toLowerCase() === 'team_pro'",
        '  const x = ({ free: 8, pro: 32, enterprise: 128 } as Record<string, number>)[summary.plan]',
        '  const y = ({ free: 1, pro: 5 } as Record<string, number>)[summary.workspacePlan.toLowerCase()]',
        '  const LIMITS: Record<string, number> = { free: 1, pro: 5, enterprise: 50 }',
        '  const z = LIMITS[summary.plan]',
        '  const edLimit = ({ team_free: 1, team_pro: 5, enterprise: 50 } as Record<string, number>)[summary.edition]',
        '  return { a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, edLimit }',
        '}',
      ].join('\n'),
      'lib/good-capabilities.ts': [
        'export function canManage(summary: { edition: string; plan: string; executionPlan: string; otherKey: string; capabilities: { canUseEnterpriseGovernance: boolean } }) {',
        '  if (summary.capabilities.canUseEnterpriseGovernance) return true',
        "  if (summary.edition === 'community' || summary.edition === 'personal' || summary.edition === 'cloud') return false",
        "  const DEPLOY_LABELS: Record<string, string> = { community: 'Self-hosted', cloud: 'Cloud' }",
        '  const deployLabel = DEPLOY_LABELS[summary.edition]',
        "  const singleKeyLookup = ({ free: 8, custom: 16 } as Record<string, number>)[summary.plan]",
        '  const unrelatedLookup = ({ free: 8, pro: 32, enterprise: 128 } as Record<string, number>)[summary.otherKey]',
        "  const externalClaudePlans = new Set(['Pro', 'Max', 'Team', 'Enterprise'])",
        '  const isClaude = externalClaudePlans.has(summary.plan)',
        "  const nonBillingPlan = summary.executionPlan === 'pro'",
        '  return Boolean(deployLabel && singleKeyLookup && unrelatedLookup && isClaude && nonBillingPlan)',
        '}',
      ].join('\n'),
      'lib/governance/policy.ts': "export const isEnt = (plan: string) => plan === 'enterprise'\n",
      'lib/governance/capabilities.ts': "export const isPaid = (plan: string) => ['pro', 'enterprise'].includes(plan)\n",
      'lib/billing/catalog.ts': "const NAMES = { pro: 'Pro', enterprise: 'Enterprise' }\nexport const name = (plan: 'pro' | 'enterprise') => NAMES[plan]\n",
      'lib/billing/resource-plan.ts': "export const isPro = (billingPlan: string) => billingPlan === 'pro'\n",
      'lib/bad-plan.test.ts': "export const check = (plan: string) => plan === 'enterprise'\n",
    },
    ({ runOxlint }) => {
      const bad = runOxlint('lib/bad-plan.ts')
      assert.equal(bad.status, 1)
      const g3 = bad.diagnostics.filter(d => d.code === 'mikka(no-plan-name-branching)')
      // 7 original + 6 edition (h..m) + 6 broader plan identifiers (n..s) + 4 normalized chains (t..w) + 4 object lookups (x, y, z, edLimit) = 27
      assert.equal(g3.length, 27)

      const good = runOxlint(
        'lib/good-capabilities.ts',
        'lib/governance/policy.ts',
        'lib/governance/capabilities.ts',
        'lib/billing/catalog.ts',
        'lib/billing/resource-plan.ts',
        'lib/bad-plan.test.ts',
      )
      assert.equal(good.status, 0)
      assert.equal(good.diagnostics.length, 0)
    },
  )
})

test('G4 no-hardcoded-model-ids: flags claude/gpt/gemini string, template, and regex literals with broadened boundaries; skips comments, imports, generic parsers, and catalog files', () => {
  withFixtureRepo(
    {
      'lib/bad-models.ts': [
        "import { ok } from '@mikka/protocol/claude-startup'",
        '// Comment mentioning claude-sonnet-4.5 and openai/gpt-6-luna must not trigger',
        "export const m1 = 'claude-sonnet-4.5'",
        "export const m2 = 'openai/gpt-6-luna'",
        "export const m3 = 'gemini-3.5-pro'",
        "export const m4 = 'bedrock/anthropic.claude-sonnet-4-5'",
        'export const m5 = `${ok}/claude-opus-5.5`',
        "export const m6 = 'fallback claude-sonnet-4.5'",
        "export const m7 = 'default (gemini-3.5-pro)'",
        "export const m8 = 'provider:gpt-6-luna'",
        'export const m9 = `use ${ok} claude-sonnet-4.5`',
        'export const r1 = /claude-sonnet-4\\.5/',
        'export const r2 = /^openai\\/gpt-6-luna$/i',
        'export const r3 = /\\bgemini-3\\.5-pro\\b/',
        'export const r4 = /(?:claude-opus-5|gpt-5-codex)/',
        "export const alias = 'mikka-default'",
        "export const hyphenated = 'my-claude-wrapper'",
        'export const genericClaudeRe = /^claude-(opus|sonnet|haiku|fable)-(\\d+)(?:[.-](\\d+))?$/',
        'export const genericGptRe = /^gpt-(\\d+)(?:\\.(\\d+))?(?:-([a-z][a-z0-9-]*))?$/',
        'export const prefixOnlyRe = /^claude-/',
      ].join('\n'),
      'lib/model-catalog.ts': "export const MODELS = ['anthropic/claude-sonnet-4.5', 'openai/gpt-6-luna', 'google/gemini-3.5-pro']\n",
      'lib/model-catalog-metadata.ts': "export const META = { 'claude-sonnet-4.5': true }\n",
      'lib/model-catalog-server.ts': "export const DEF = 'openai/gpt-6-luna'\n",
      'lib/model-display-name.ts': "export const NAME = 'gemini-3.5-pro'\n",
      'tests/fixtures/models.ts': "export const FIXTURE = 'claude-sonnet-4.5'\n",
    },
    ({ runOxlint }) => {
      const bad = runOxlint('lib/bad-models.ts')
      assert.equal(bad.status, 1)
      const g4 = bad.diagnostics.filter(d => d.code === 'mikka(no-hardcoded-model-ids)')
      // 9 string/template literals (m1..m9) + 4 regex literals (r1..r4) = 13
      assert.equal(g4.length, 13)

      const allowed = runOxlint(
        'lib/model-catalog.ts',
        'lib/model-catalog-metadata.ts',
        'lib/model-catalog-server.ts',
        'lib/model-display-name.ts',
        'tests/fixtures/models.ts',
      )
      assert.equal(allowed.status, 0)
      assert.equal(allowed.diagnostics.length, 0)
    },
  )
})

test('G5 no-hardcoded-hosts: flags 127.0.0.1, ::1, [::1], localhost, and product.internal in strings, templates, and regexes without false positives on CSS/C++ colons; allows lib/env/** and scripts', () => {
  withFixtureRepo(
    {
      'lib/bad-hosts.ts': [
        '// Prose comment mentioning http://127.0.0.1:3000 ::1 [::1] localhost product.internal is ignored',
        "export const h1 = 'http://127.0.0.1:3000'",
        "export const h2 = 'https://product.internal/v1'",
        "export const h3 = 'localhost'",
        'export const h4 = (port: number) => `http://localhost:${port}`',
        "export const h5 = '::1'",
        "export const h6 = '[::1]'",
        "export const h7 = 'http://[::1]:3000'",
        "export const h8 = '::1/128'",
        'export const h9 = (port: number) => `http://[::1]:${port}`',
        'export const h10 = (port: number) => `bind ::1 on ${port}`',
        'export const r1 = /^https?:\\/\\/127\\.0\\.0\\.1(?::\\d+)?$/',
        'export const r2 = /\\.product\\.internal$/i',
        'export const r3 = /localhost/i',
        'export const r4 = /^::1$/',
        'export const r5 = /^https?:\\/\\/\\[::1\\](?::\\d+)?$/',
        'export const r6 = /^(?:example\\.com|::1)$/',
        "export const ok1 = 'https://api.example.com'",
        "export const ok2 = 'foo::1'",
        "export const ok3 = 'ns::1'",
        "export const ok4 = '2001:db8::1'",
        "export const ok5 = 'fe80::1'",
        "export const ok6 = '::10'",
        "export const ok7 = '::1:80'",
        "export const ok8 = 'div::before'",
        "export const ok9 = '::'",
        'export const okRe1 = /foo::1/',
        'export const okRe2 = /2001:db8::1/',
        'export const okRe3 = /::10/',
        'export const okRe4 = /[::1]/',
      ].join('\n'),
      'lib/env/hosts.ts': [
        "export const LOCAL = 'http://127.0.0.1:3000'",
        "export const LOOPBACK6 = '::1'",
        "export const LOOPBACK6_BRACKETED = '[::1]'",
        "export const INTERNAL = 'https://product.internal'",
        'export const RE = /localhost/i',
      ].join('\n'),
      'apps/api/scripts/dev.mjs': "export const url = 'http://localhost:3000'\n",
      'apps/desktop/scripts/dev.mjs': "export const url = 'http://127.0.0.1:5173'\n",
      'playwright.config.ts': "export const url = 'http://localhost:3000'\n",
    },
    ({ runOxlint }) => {
      const bad = runOxlint('lib/bad-hosts.ts')
      assert.equal(bad.status, 1)
      const g5 = bad.diagnostics.filter(d => d.code === 'mikka(no-hardcoded-hosts)')
      // 10 strings/templates (h1..h10) + 6 regexes (r1..r6) = 16
      assert.equal(g5.length, 16)

      const allowed = runOxlint(
        'lib/env/hosts.ts',
        'apps/api/scripts/dev.mjs',
        'apps/desktop/scripts/dev.mjs',
        'playwright.config.ts',
      )
      assert.equal(allowed.status, 0)
      assert.equal(allowed.diagnostics.length, 0)
    },
  )
})

test('Ratchet baseline: allows exact recorded count, fails immediately on +1 or new file, and enforces zero tolerance when absent', () => {
  withFixtureRepo(
    {
      'scripts/baselines/no-raw-process-env.json': JSON.stringify({
        'lib/legacy.ts': 2,
      }),
      'lib/legacy.ts': [
        'export const a = process.env.A',
        'export const b = process.env.B',
      ].join('\n'),
      'lib/new-file.ts': 'export const c = process.env.C\n',
    },
    ({ dir, runOxlint }) => {
      // Exact recorded count (2 <= 2) passes
      const exact = runOxlint('lib/legacy.ts')
      assert.equal(exact.status, 0)
      assert.equal(exact.diagnostics.length, 0)

      // Brand-new unlisted file fails immediately
      const newFile = runOxlint('lib/new-file.ts')
      assert.equal(newFile.status, 1)
      assert.equal(newFile.diagnostics.length, 1)
      assert.equal(newFile.diagnostics[0].code, 'mikka(no-raw-process-env)')

      // Increasing count by +1 (3 > 2) fails immediately with clear baseline message
      fs.writeFileSync(
        path.join(dir, 'lib/legacy.ts'),
        [
          'export const a = process.env.A',
          'export const b = process.env.B',
          'export const c = process.env.C',
        ].join('\n'),
      )
      const increased = runOxlint('lib/legacy.ts')
      assert.equal(increased.status, 1)
      assert.equal(increased.diagnostics.length, 3)
      assert.ok(increased.diagnostics[0].message.includes('exceeding baseline max 2'))

      // Removing baseline restores strict zero tolerance even for a single occurrence
      fs.rmSync(path.join(dir, 'scripts/baselines/no-raw-process-env.json'))
      fs.writeFileSync(path.join(dir, 'lib/legacy.ts'), 'export const a = process.env.A\n')
      const zeroTolerance = runOxlint('lib/legacy.ts')
      assert.equal(zeroTolerance.status, 1)
      assert.equal(zeroTolerance.diagnostics.length, 1)

      // Malformed baseline JSON fails closed
      fs.writeFileSync(path.join(dir, 'scripts/baselines/no-raw-process-env.json'), '{not-json')
      const malformed = runOxlint('lib/legacy.ts')
      assert.equal(malformed.status, 1)
      assert.ok(malformed.diagnostics.some(d => d.message.includes('Invalid baseline JSON')))
    },
  )
})
