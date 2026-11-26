import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SCAN_ROOTS,
  REPO_ROOT,
  RULES,
  globToRegExp,
  isAllowedPath,
  parseAllowDirectives,
  parseArgs,
  runSemanticLint,
} from './index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.join(HERE, 'index.mjs')
const FIXTURES_DIR = path.join(HERE, 'fixtures')

function runCli(args, cwd = REPO_ROOT) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(res.error, undefined, `semantic-lint CLI failed to spawn: ${res.error?.message}`)
  return res
}

function withTempWorkspace(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikka-semantic-lint-'))
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(dir, relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, content, 'utf8')
    }
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('all four semantic rules export clean { name, description, allowlist, check } contracts', () => {
  assert.deepEqual(
    RULES.map(rule => rule.name),
    [
      'no-hardcoded-business-policy',
      'no-mode-flags',
      'no-provider-or-plan-special-casing',
      'no-constant-stub-tests',
    ],
  )
  for (const rule of RULES) {
    assert.equal(typeof rule.name, 'string')
    assert.ok(rule.description.length > 20, `${rule.name} should have a clear description`)
    assert.ok(Array.isArray(rule.allowlist), `${rule.name}.allowlist must be an array`)
    assert.equal(typeof rule.check, 'function', `${rule.name}.check must be a function`)
  }
  assert.deepEqual(DEFAULT_SCAN_ROOTS, [
    'app',
    'apps/api',
    'apps/frontend/src',
    'cloudflare',
    'lib',
    'services',
    'tests',
    'workflows',
  ])
})

test('globToRegExp and isAllowedPath handle root, nested, and wildcard globs accurately', () => {
  assert.equal(globToRegExp('lib/billing/**').test('lib/billing/catalog.ts'), true)
  assert.equal(globToRegExp('lib/billing/**').test('lib/billing/nested/stripe.ts'), true)
  assert.equal(globToRegExp('lib/billing/**').test('lib/billing-extra/foo.ts'), false)
  assert.equal(globToRegExp('**/*.test.*').test('foo.test.ts'), true)
  assert.equal(globToRegExp('**/*.test.*').test('lib/a/b/foo.db.test.ts'), true)
  assert.equal(isAllowedPath('lib/model-api-key-chat.ts', ['lib/model-api-key*.ts']), true)
  assert.equal(isAllowedPath('lib/workflow/checkout.ts', ['lib/billing/**']), false)
})

test('fixture suite: no-hardcoded-business-policy flags positive.ts and passes negative.ts', () => {
  const report = runSemanticLint({
    root: path.join(FIXTURES_DIR, 'no-hardcoded-business-policy'),
    rules: ['no-hardcoded-business-policy'],
    mode: 'error',
  })
  assert.equal(report.filesScanned, 2)
  assert.equal(report.totalFindings, 14)
  assert.equal(report.byRule['no-hardcoded-business-policy'], 14)
  assert.ok(report.findings.every(f => f.file === 'positive.ts'))
  assert.equal(report.findings.some(f => f.file === 'negative.ts'), false)
})

test('fixture suite: no-mode-flags flags positive.ts and passes negative.ts', () => {
  const report = runSemanticLint({
    root: path.join(FIXTURES_DIR, 'no-mode-flags'),
    rules: ['no-mode-flags'],
    mode: 'error',
  })
  assert.equal(report.filesScanned, 2)
  assert.equal(report.totalFindings, 10)
  assert.equal(report.byRule['no-mode-flags'], 10)
  assert.ok(report.findings.every(f => f.file === 'positive.ts'))
  assert.equal(report.findings.some(f => f.file === 'negative.ts'), false)
})

test('fixture suite: no-provider-or-plan-special-casing flags positive.ts and passes negative.ts', () => {
  const report = runSemanticLint({
    root: path.join(FIXTURES_DIR, 'no-provider-or-plan-special-casing'),
    rules: ['no-provider-or-plan-special-casing'],
    mode: 'error',
  })
  assert.equal(report.filesScanned, 2)
  assert.equal(report.totalFindings, 14)
  assert.equal(report.byRule['no-provider-or-plan-special-casing'], 14)
  assert.ok(report.findings.every(f => f.file === 'positive.ts'))
  assert.equal(report.findings.some(f => f.file === 'negative.ts'), false)
})

test('fixture suite: no-constant-stub-tests flags positive.test.ts and passes negative.test.ts', () => {
  const report = runSemanticLint({
    root: path.join(FIXTURES_DIR, 'no-constant-stub-tests'),
    rules: ['no-constant-stub-tests'],
    mode: 'error',
  })
  assert.equal(report.filesScanned, 2)
  assert.equal(report.totalFindings, 5)
  assert.equal(report.byRule['no-constant-stub-tests'], 5)
  assert.ok(report.findings.every(f => f.file === 'positive.test.ts'))
  assert.equal(report.findings.some(f => f.file === 'negative.test.ts'), false)
})

test('CLI flags: --mode=warn exits 0, --mode=error exits 1, --json outputs exact schema, and --rule filters rules', () => {
  const fixtureDir = path.join(FIXTURES_DIR, 'no-mode-flags')

  const warnRes = runCli(['--mode=warn', '--json', '--root', fixtureDir, '--rule', 'no-mode-flags'])
  assert.equal(warnRes.status, 0, `warn mode must exit 0; stderr=${warnRes.stderr}`)
  const warnJson = JSON.parse(warnRes.stdout)
  assert.equal(warnJson.mode, 'warn')
  assert.equal(warnJson.filesScanned, 2)
  assert.equal(warnJson.totalFindings, 10)
  assert.deepEqual(warnJson.byRule, { 'no-mode-flags': 10 })
  assert.equal(warnJson.findings.length, 10)
  for (const finding of warnJson.findings) {
    assert.equal(typeof finding.rule, 'string')
    assert.equal(typeof finding.file, 'string')
    assert.equal(typeof finding.line, 'number')
    assert.equal(typeof finding.column, 'number')
    assert.equal(typeof finding.message, 'string')
  }

  const errorRes = runCli(['--mode=error', '--json', '--root', fixtureDir, '--rule=no-mode-flags'])
  assert.equal(errorRes.status, 1, 'error mode must exit 1 when findings exist')
  const errorJson = JSON.parse(errorRes.stdout)
  assert.equal(errorJson.mode, 'error')
  assert.equal(errorJson.totalFindings, 10)

  const multiRule = parseArgs(['--mode', 'warn', '--rule', 'no-mode-flags,no-constant-stub-tests', '--json'])
  assert.equal(multiRule.mode, 'warn')
  assert.equal(multiRule.json, true)
  assert.deepEqual(multiRule.rules, ['no-mode-flags', 'no-constant-stub-tests'])

  const badRule = runCli(['--rule', 'nonexistent-rule'])
  assert.equal(badRule.status, 2)
  assert.match(badRule.stderr, /Unknown rule/)

  const badMode = runCli(['--mode=strict'])
  assert.equal(badMode.status, 2)
  assert.match(badMode.stderr, /Invalid --mode/)
})

test('inline justification directives allow reasoned suppressions and reject bare disable comments', () => {
  withTempWorkspace(
    {
      'lib/with-reason.ts': [
        '// semantic-lint-allow: no-hardcoded-business-policy — legacy backfill default pending migration #3342',
        'export const TRIAL_DAYS = 14',
        'export const isHostedMode = false // semantic-lint-allow: no-mode-flags — temporary adapter shim until #3399',
        'export const docString = "// semantic-lint-allow: no-mode-flags"',
      ].join('\n'),
      'lib/bare-disable.ts': [
        '// semantic-lint-allow: no-mode-flags',
        'export const isHostedMode = true',
      ].join('\n'),
      'lib/empty-reason.ts': [
        '// semantic-lint-allow: no-hardcoded-business-policy —   ',
        'export const DISCOUNT_PERCENT = 25',
      ].join('\n'),
      'lib/wrong-rule-reason.ts': [
        '// semantic-lint-allow: no-mode-flags — valid reason for a different rule',
        'export const DISCOUNT_PERCENT = 25',
      ].join('\n'),
    },
    dir => {
      const reasoned = runSemanticLint({
        root: path.join(dir, 'lib', 'with-reason.ts'),
      })
      assert.equal(reasoned.totalFindings, 0)

      // Test parsing comments directly ignores string literals
      const parsed = parseAllowDirectives('export const s = "// semantic-lint-allow: no-mode-flags"')
      assert.equal(parsed.invalidDirectives.length, 0)
      assert.equal(parsed.allowedByLine.size, 0)

      const full = runSemanticLint({ root: dir })
      const byFile = new Map()
      for (const f of full.findings) {
        byFile.set(f.file, (byFile.get(f.file) ?? []).concat(f))
      }

      assert.equal(byFile.get('lib/with-reason.ts'), undefined)

      // Bare disable comment: fails both for bare directive AND unsuppressed violation
      const bareFindings = byFile.get('lib/bare-disable.ts') ?? []
      assert.equal(bareFindings.length, 2)
      assert.ok(bareFindings.some(f => f.message.includes('Bare semantic-lint-allow directive')))
      assert.ok(bareFindings.some(f => f.message.includes('Mode flag "isHostedMode"')))

      // Empty reason after dash: rejected as bare disable AND violation remains active
      const emptyFindings = byFile.get('lib/empty-reason.ts') ?? []
      assert.equal(emptyFindings.length, 2)
      assert.ok(emptyFindings.some(f => f.message.includes('Bare semantic-lint-allow directive')))
      assert.ok(emptyFindings.some(f => f.message.includes('DISCOUNT_PERCENT')))

      // Reason targeting wrong rule does not suppress DISCOUNT_PERCENT
      const wrongRuleFindings = byFile.get('lib/wrong-rule-reason.ts') ?? []
      assert.equal(wrongRuleFindings.length, 1)
      assert.equal(wrongRuleFindings[0].rule, 'no-hardcoded-business-policy')
    },
  )

  // Template-literal spoofing must NEVER suppress a violation or trigger false invalid directives,
  // and valid directives after interpolated templates must still work (AST-backed parser).
  withTempWorkspace(
    {
      'lib/template-spoof.ts': [
        'const msg = `hello ${1}',
        '// semantic-lint-allow: no-mode-flags — spoofed inside template string',
        '`; export const isHostedMode = true',
      ].join('\n'),
      'lib/after-template.ts': [
        'export const label = (name: string) => `hello ${name}`',
        '// semantic-lint-allow: no-mode-flags — valid suppression after interpolated template',
        'export const isHostedMode = false',
      ].join('\n'),
      'lib/unknown-rule.ts': [
        '// semantic-lint-allow: nonexistent-rule — typo in rule name',
        'export const ok = 1',
      ].join('\n'),
      'lib/trivial-reason.ts': [
        '// semantic-lint-allow: no-mode-flags — ...',
        'export const isHostedMode = true',
      ].join('\n'),
    },
    dir => {
      const spoof = runSemanticLint({ root: path.join(dir, 'lib', 'template-spoof.ts') })
      assert.equal(spoof.totalFindings, 1)
      assert.equal(spoof.findings[0].rule, 'no-mode-flags')
      assert.ok(spoof.findings[0].message.includes('Mode flag "isHostedMode"'))

      const afterTemplate = runSemanticLint({ root: path.join(dir, 'lib', 'after-template.ts') })
      assert.equal(afterTemplate.totalFindings, 0)

      const unknownRule = runSemanticLint({ root: path.join(dir, 'lib', 'unknown-rule.ts') })
      assert.equal(unknownRule.totalFindings, 1)
      assert.ok(unknownRule.findings[0].message.includes('Unknown rule "nonexistent-rule"'))

      const trivial = runSemanticLint({ root: path.join(dir, 'lib', 'trivial-reason.ts') })
      assert.equal(trivial.totalFindings, 2)
      assert.ok(trivial.findings.some(f => f.message.includes('Bare or trivial semantic-lint-allow directive')))
      assert.ok(trivial.findings.some(f => f.message.includes('Mode flag "isHostedMode"')))
    },
  )
})

test('standalone counter-examples prove 100% prefilter recall and describe-scope coverage for every rule', () => {
  const cases = [
    {
      label: 'unquoted provider lookup object',
      rule: 'no-provider-or-plan-special-casing',
      file: 'lib/unquoted-provider.ts',
      code: [
        'const PROVIDER_TIMEOUT_MS: Record<string, number> = { openai: 30_000, anthropic: 45_000 }',
        'export const getTimeout = (provider: string) => PROVIDER_TIMEOUT_MS[provider] ?? 10_000',
      ].join('\n'),
    },
    {
      label: 'unquoted plan-tier lookup object',
      rule: 'no-provider-or-plan-special-casing',
      file: 'lib/unquoted-tier.ts',
      code: [
        'const TIER_CONCURRENCY: Record<string, number> = { free: 4, pro: 32, enterprise: 128 }',
        'export const getConcurrency = (workspaceTier: string) => TIER_CONCURRENCY[workspaceTier] ?? 1',
      ].join('\n'),
    },
    {
      label: 'defaultTrialDays and PascalCase trial durations',
      rule: 'no-hardcoded-business-policy',
      file: 'lib/default-trial.ts',
      code: 'export const defaultTrialDays = 14\nexport const defaultGracePeriodDays = 7\n',
    },
    {
      label: 'no-mode-flags with inline comment in else-if and COMMUNITY_MODE',
      rule: 'no-mode-flags',
      file: 'lib/commented-mode.ts',
      code: [
        'export const COMMUNITY_MODE = true',
        'export function route(mode: string) {',
        "  if (mode === 'cloud') return 1",
        "  else /* comment */ if (mode === 'community') return 2",
        '  return 0',
        '}',
      ].join('\n'),
    },
    {
      label: 'leading-keyword stub variable (const expectedValue = 2000)',
      rule: 'no-constant-stub-tests',
      file: 'lib/leading-var.test.ts',
      code: [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "test('tautology', () => { const expectedValue = 2000; assert.equal(expectedValue, 2000) })",
      ].join('\n'),
    },
    {
      label: 'leading-keyword stub function (function mockData)',
      rule: 'no-constant-stub-tests',
      file: 'lib/leading-fn.test.ts',
      code: [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        'function mockData() { return 42 }',
        "test('tautology', () => { assert.equal(mockData(), 42) })",
      ].join('\n'),
    },
    {
      label: 'describe-scoped constant-stub test',
      rule: 'no-constant-stub-tests',
      file: 'lib/describe-stub.test.ts',
      code: [
        "describe('billing', () => {",
        '  const MOCK_PRO_PRICE = 2000',
        "  it('checks price', () => { expect(MOCK_PRO_PRICE).toBe(2000) })",
        '})',
      ].join('\n'),
    },
    {
      label: 'bare tainted model literal in assertion',
      rule: 'no-constant-stub-tests',
      file: 'lib/bare-literal.test.ts',
      code: [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "const x = 'claude-sonnet-4.5'",
        "test('tautology', () => { assert.equal(x, 'claude-sonnet-4.5') })",
      ].join('\n'),
    },
  ]

  for (const tc of cases) {
    const ruleObj = RULES.find(r => r.name === tc.rule)
    assert.ok(ruleObj, `missing rule ${tc.rule}`)
    assert.equal(
      ruleObj.mightMatch(tc.code),
      true,
      `prefilter mightMatch() must return true for standalone case: ${tc.label}`,
    )
    withTempWorkspace({ [tc.file]: tc.code }, dir => {
      const report = runSemanticLint({ root: dir, rules: [tc.rule] })
      assert.ok(
        report.totalFindings >= 1,
        `expected >= 1 finding for standalone case "${tc.label}", got 0`,
      )
    })
  }
})

test('per-rule allowlists, excluded directories, TSX files, and mixed unit/stub tests behave accurately', () => {
  withTempWorkspace(
    {
      // Allowlisted domain boundaries should produce 0 findings
      'lib/billing/catalog.ts': [
        'export const PLAN_PRICE_MONTHLY_CENTS = 2000',
        "export const check = (tier: string) => tier === 'pro'",
      ].join('\n'),
      'lib/edition.ts': [
        'export const isCloudMode = false',
        "export const pick = (mode: string) => { switch (mode) { case 'cloud': return 1; case 'community': return 2; default: return 0 } }",
      ].join('\n'),
      'lib/model-gateway/upstream.ts': "export const isOpenAi = (provider: string) => provider === 'openai'\n",

      // Excluded build/fixture directories must never be scanned
      'node_modules/pkg/index.js': 'export const TRIAL_DAYS = 14\n',
      'dist/bundle.js': 'export const isHostedMode = true\n',
      '.output/server.mjs': "export const x = (provider) => provider === 'openai'\n",
      'apps/api/generated/routes.ts': 'export const FREE_PLAN_LIMIT = 5\n',
      '.hosted-ui/panel.tsx': 'export const isCloudMode = true\n',
      'scripts/semantic-lint/fixtures/sample.ts': 'export const DISCOUNT_PERCENT = 50\n',

      // TSX component outside allowlist SHOULD be caught when scanning an alternate root
      'lib/ui/widget.tsx': [
        'export function Banner(props: { isHostedMode: boolean }) {',
        '  return props.isHostedMode ? <div>Cloud</div> : <div>Self</div>',
        '}',
      ].join('\n'),

      // Mixed test file: one real test calling imported module + one tautological stub test
      'lib/mixed.test.ts': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { computeRealLimit } from './real-module'",
        '',
        'const MOCK_PRO_LIMIT = 32',
        '',
        "test('real test exercises imported module', () => {",
        "  assert.equal(computeRealLimit('pro'), MOCK_PRO_LIMIT)",
        '})',
        '',
        "test('bogus stub test asserts local constant without calling real module', () => {",
        '  assert.equal(MOCK_PRO_LIMIT, 32)',
        '})',
      ].join('\n'),
    },
    dir => {
      const report = runSemanticLint({ root: dir })
      assert.equal(report.totalFindings, 2)
      assert.deepEqual(
        report.findings.map(f => ({ rule: f.rule, file: f.file })),
        [
          { rule: 'no-constant-stub-tests', file: 'lib/mixed.test.ts' },
          { rule: 'no-mode-flags', file: 'lib/ui/widget.tsx' },
        ],
      )
      assert.equal(report.findings[0].line, 12)
    },
  )
})

test('real Mikka repository passes semantic-lint with zero findings', () => {
  const report = runSemanticLint({ root: REPO_ROOT, mode: 'error' })
  assert.ok(report.filesScanned > 2000, `expected > 2000 files scanned, got ${report.filesScanned}`)
  assert.equal(
    report.totalFindings,
    0,
    `Expected 0 findings on real repository, found ${report.totalFindings}:\n${JSON.stringify(report.findings, null, 2)}`,
  )
  assert.deepEqual(report.byRule, {
    'no-hardcoded-business-policy': 0,
    'no-mode-flags': 0,
    'no-provider-or-plan-special-casing': 0,
    'no-constant-stub-tests': 0,
  })
})
