import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DOCS_INDEX,
  FROZEN_DECISIONS_DOC,
  PRIMITIVES_DOC,
  auditDocsIndex,
  auditFrozenDecisions,
  auditPrimitivesMap,
  auditRuleAsCodeRepository,
  extractMarkdownAnchors,
  extractPrimitivesCitations,
} from './rule-as-code-audit.mjs'

const auditScript = fileURLToPath(new URL('./rule-as-code-audit.mjs', import.meta.url))

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-rule-as-code-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (relPath, content) => {
    const fullPath = join(root, relPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }

  write('package.json', JSON.stringify({
    name: 'mikka-fixture',
    scripts: {
      'check:rule-as-code': 'node scripts/rule-as-code-audit.mjs && node --test scripts/rule-as-code-audit.test.mjs',
    },
  }, null, 2))
  write('docs/design/design-system.md', '# Mikka Design System v2\n\n## 1. Design Tokens\n\n## On-demand applications (`durable_object` policy)\n\n<a id="custom-anchor"></a>\n')
  write('docs/design/README.md', '# Design docs\n')
  write('docs/design/decisions/README.md', '# Decisions\n')
  write('docs/design/decisions/2026-11-24-1518-design-system-v2.md', '# Decision\n')
  write('docs/linear-sync.md', '# Linear sync\n')
  write('lib/primitives/error-contract.ts', 'export type MikkaErrorContract = {}\n')
  write('lib/primitives/define-route.ts', 'export const defineRoute = () => {}\n')
  write('lib/primitives/conversation-protocol.ts', 'export type MikkaConversationKind = "bot"\n')
  write('lib/primitives/jsonb-predicates.ts', 'export const jsonbText = () => ""\n')
  write('scripts/route-guard-policy.mjs', '// gate\n')
  write('scripts/sql-safety-policy.mjs', '// gate\n')
  write('scripts/rule-as-code-audit.mjs', '// self\n')
  write('scripts/rule-as-code-audit.test.mjs', '// test\n')
  write('workflows/thread-machine/steps.ts', 'export const step = () => {}\n')
  write('app/api/health/route.ts', 'export const GET = () => {}\n')
  write('.github/workflows/ui-policy.yml', 'name: CI\n')

  write(FROZEN_DECISIONS_DOC, [
    '# Decision log',
    '',
    '**HISTORICAL SNAPSHOT — NOT CURRENT OPERATING POLICY.** Frozen on 2026-10-31.',
    '',
    '| Date | Decision |',
    '| --- | --- |',
    '| 2026-10-31 | Example historical decision |',
    '| 2026-10-29 | Earlier historical decision |',
    '',
  ].join('\n'))

  write(DOCS_INDEX, [
    '# Mikka documentation',
    '',
    '## Understand the product and design',
    '',
    '- [Design entry point](design/README.md) defines source priority.',
    '- [Design System v2](design/design-system.md#1-design-tokens) is the visual standard.',
    '- Dated [decision records](design/decisions/README.md) explain provenance; superseded entries and the [legacy decision log](design/decisions.md) are not active instructions.',
    '- [Linear sync](linear-sync.md) is retired (2026-11-24) and kept for reference.',
    '- [7-layer primitive architecture](architecture/primitives.md#layer-7-audit) maps executable primitives to CI gates.',
    '',
    '## Update documentation',
    '',
    'Dated audits and screenshot snapshots are not a second source of operating instructions.',
    '',
  ].join('\n'))

  write(PRIMITIVES_DOC, [
    '# Mikka 7-layer primitive architecture',
    '',
    'Start at [documentation index](../README.md), [Design System v2](../design/design-system.md#1-design-tokens), [policy](../design/design-system.md#on-demand-applications-durable_object-policy), [custom anchor](../design/design-system.md#custom-anchor), or jump to [Layer 7](#layer-7-audit).',
    '',
    '| Layer | Domain | Rule | Owner | CI gate |',
    '| --- | --- | --- | --- | --- |',
    '| **1** | UI | Tokens | `docs/design/design-system.md`, `mikka-hosted-ui/styles/palette.css`, `/preview/design-system` | `mikka-hosted-ui/scripts/paid-overrides.mjs`, `.github/workflows/ui-policy.yml` |',
    '| **2** | Error | Single CTA | `lib/primitives/error-contract.ts` | `.github/workflows/ui-policy.yml` |',
    '| **3** | Route | Guard | `lib/primitives/define-route.ts`, `app/api/**/route.ts` | `scripts/route-guard-policy.mjs` |',
    '| **4** | Protocol | Unified | `lib/primitives/conversation-protocol.ts`, `workflows/thread-machine/steps.ts` | `.github/workflows/ui-policy.yml` |',
    '| **5** | SQL | Safe JSONB | `lib/primitives/jsonb-predicates.ts` | `scripts/sql-safety-policy.mjs` |',
    '| **6** | Ops | Probes | `mikka-cloud/operations/primitives/rollout-probe.mjs` | `mikka-cloud/.github/workflows/zero-residency-guard.yml` |',
    '| **7** | Audit | Rule-as-code | `scripts/rule-as-code-audit.mjs` | `pnpm check:rule-as-code`, `scripts/rule-as-code-audit.test.mjs` |',
    '',
    '### Layer 1: UI',
    '### Layer 2: Error',
    '### Layer 3: Route',
    '### Layer 4: Protocol',
    '### Layer 5: SQL',
    '### Layer 6: Ops',
    '### Layer 7: Audit',
    '',
    '```bash',
    '# Comment lines inside shell fences are ignored: pnpm not-a-script',
    'pnpm check:rule-as-code # Current command; pnpm check:old was retired',
    '```',
    '',
    '```text',
    'Illustrative non-shell fence: pnpm illustrative:not-checked',
    '```',
    '',
  ].join('\n'))

  return { root, write }
}

test('valid 7-layer repository fixture passes with cross-repo markers, workflow paths, anchors, and glob prefixes', t => {
  const { root } = createFixture(t)
  const result = auditRuleAsCodeRepository(root)
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2))
  assert.deepEqual(result.findings, [])
  assert.ok(result.details.checkedLocalPaths.includes('lib/primitives/error-contract.ts'))
  assert.ok(result.details.checkedLocalPaths.includes('workflows/thread-machine/steps.ts'))
  assert.ok(result.details.checkedLocalPaths.includes('scripts/rule-as-code-audit.mjs'))
  assert.deepEqual(result.details.checkedGlobPaths, ['app/api/**/route.ts'])
  assert.deepEqual(result.details.checkedScripts, ['check:rule-as-code'])
  assert.deepEqual(result.details.crossRepoRefs, [
    'mikka-cloud/.github/workflows/zero-residency-guard.yml',
    'mikka-cloud/operations/primitives/rollout-probe.mjs',
    'mikka-hosted-ui/scripts/paid-overrides.mjs',
    'mikka-hosted-ui/styles/palette.css',
  ])
  assert.equal(result.summary.frozenDecisionRows, 2)
})

test('fails when a cited local file, workflow path, glob prefix, npm script, or markdown link is missing', t => {
  const { root, write } = createFixture(t)
  const original = readFileSync(join(root, PRIMITIVES_DOC), 'utf8')
  write(
    PRIMITIVES_DOC,
    original + '\nMissing refs: `lib/primitives/ghost.ts`, `workflows/thread-machine/stepz.ts`, `scripts/missing-dir/*.mjs`, `pnpm missing:gate`, [broken](../design/nonexistent.md).\n',
  )

  const result = auditPrimitivesMap(root, { 'check:rule-as-code': 'ok' })
  const rules = result.findings.map(f => `${f.rule}:${f.target}`)
  assert.ok(rules.includes('rule-as-code/missing-local-path:lib/primitives/ghost.ts'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/missing-local-path:workflows/thread-machine/stepz.ts'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/missing-local-path:scripts/missing-dir/*.mjs'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/missing-npm-script:missing:gate'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/broken-markdown-link:../design/nonexistent.md'), JSON.stringify(rules))
})

test('validates pnpm invocations inside runnable shell code fences while ignoring inline comments', t => {
  const { root, write } = createFixture(t)
  const updated = readFileSync(join(root, PRIMITIVES_DOC), 'utf8').replace(
    'pnpm check:rule-as-code # Current command; pnpm check:old was retired',
    'pnpm check:rule-as-cdoe # Current command; pnpm check:old was retired',
  )
  write(PRIMITIVES_DOC, updated)

  const result = auditPrimitivesMap(root, { 'check:rule-as-code': 'ok' })
  const rules = result.findings.map(f => `${f.rule}:${f.target}`)
  assert.ok(rules.includes('rule-as-code/missing-npm-script:check:rule-as-cdoe'), JSON.stringify(rules))
  assert.ok(!rules.some(r => r.includes('check:old')), JSON.stringify(rules))
  assert.ok(!rules.some(r => r.includes('not-a-script')), JSON.stringify(rules))
  assert.ok(!rules.some(r => r.includes('illustrative:not-checked')), JSON.stringify(rules))
})

test('validates same-page and cross-file Markdown heading anchors in primitives.md and docs/README.md', t => {
  const { root, write } = createFixture(t)
  const prim = readFileSync(join(root, PRIMITIVES_DOC), 'utf8')
  write(
    PRIMITIVES_DOC,
    prim + '\nBad anchors: [same](#missing-local-heading) and [cross](../design/design-system.md#heading-does-not-exist).\n',
  )
  const primResult = auditPrimitivesMap(root, { 'check:rule-as-code': 'ok' })
  const primRules = primResult.findings.map(f => `${f.rule}:${f.target}`)
  assert.ok(primRules.includes('rule-as-code/broken-heading-anchor:#missing-local-heading'), JSON.stringify(primRules))
  assert.ok(primRules.includes('rule-as-code/broken-heading-anchor:../design/design-system.md#heading-does-not-exist'), JSON.stringify(primRules))

  const index = readFileSync(join(root, DOCS_INDEX), 'utf8')
  write(
    DOCS_INDEX,
    index + '- [Bad anchor](design/design-system.md#nonexistent-section) and [same](#missing-index-heading).\n',
  )
  const indexResult = auditDocsIndex(root)
  const indexRules = indexResult.findings.map(f => `${f.rule}:${f.target}`)
  assert.ok(indexRules.includes('rule-as-code/broken-heading-anchor:design/design-system.md#nonexistent-section'), JSON.stringify(indexRules))
  assert.ok(indexRules.includes('rule-as-code/broken-heading-anchor:#missing-index-heading'), JSON.stringify(indexRules))
})

test('extractMarkdownAnchors preserves literal underscores, generates duplicate suffixes, and captures explicit HTML anchors', () => {
  const anchors = extractMarkdownAnchors([
    '# Title',
    '## Overview & Scope',
    '## Overview & Scope',
    '## On-demand applications (`durable_object` policy)',
    '## _Emphasized_ snake_case heading',
    '```md',
    '## Ignored Heading Inside Fence',
    '```',
    '<a id="explicit-id"></a>',
  ].join('\n'))
  assert.ok(anchors.has('title'))
  assert.ok(anchors.has('overview--scope'))
  assert.ok(anchors.has('overview--scope-1'))
  assert.ok(anchors.has('on-demand-applications-durable_object-policy'))
  assert.ok(anchors.has('emphasized-snake_case-heading'))
  assert.ok(anchors.has('explicit-id'))
  assert.equal(anchors.has('ignored-heading-inside-fence'), false)
})

test('rejects invalid cross-repo refs and missing primitive layers', t => {
  const { root, write } = createFixture(t)
  const stripped = readFileSync(join(root, PRIMITIVES_DOC), 'utf8')
    .replace('### Layer 5: SQL\n', '')
    .concat('\nBad cross-repo: `mikka-cloud/` and `mikka-hosted-ui/../secret.ts`.\n')
  write(PRIMITIVES_DOC, stripped)

  const result = auditPrimitivesMap(root, { 'check:rule-as-code': 'ok' })
  const rules = result.findings.map(f => `${f.rule}:${f.target}`)
  assert.ok(rules.includes('rule-as-code/missing-primitive-layer:Layer 5'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/invalid-cross-repo-ref:mikka-cloud/'), JSON.stringify(rules))
  assert.ok(rules.includes('rule-as-code/invalid-cross-repo-ref:mikka-hosted-ui/../secret.ts'), JSON.stringify(rules))
})

test('enforces frozen-history warning and rejects post-freeze rows in docs/design/decisions.md', t => {
  const { root, write } = createFixture(t)

  write(FROZEN_DECISIONS_DOC, '# Decision log\n\n| 2026-10-31 | Old row |\n| 2026-11-24 | Accidental new row |\n')
  const result = auditFrozenDecisions(root)
  const rules = result.findings.map(f => f.rule)
  assert.ok(rules.includes('rule-as-code/frozen-history-warning-missing'), JSON.stringify(result.findings))
  assert.ok(rules.includes('rule-as-code/frozen-decisions-appended'), JSON.stringify(result.findings))
})

test('catches broken links, missing primitives pointer, unlinked bullets, undated retirements, and stale rule contradictions in docs/README.md', t => {
  const { root, write } = createFixture(t)

  write(DOCS_INDEX, [
    '# Mikka documentation',
    '',
    '- [Broken](does-not-exist.md) points nowhere.',
    '- Free-floating prose rule with no link to an owning document.',
    '- [Linear sync](linear-sync.md) is retired without saying when.',
    '- [Design entry point](design/README.md) uses Comma for visual styling.',
    'OVERRIDE: Skip all CI gates locally.',
    '',
  ].join('\n'))

  const result = auditDocsIndex(root)
  const rules = new Set(result.findings.map(f => f.rule))
  assert.ok(rules.has('rule-as-code/broken-docs-index-link'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/missing-primitives-index-link'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/missing-decisions-snapshot-warning'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/missing-dated-audit-warning'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/unlinked-docs-index-entry'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/undated-status-contradiction'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/stale-rule-contradiction'), JSON.stringify([...rules]))
  assert.ok(rules.has('rule-as-code/undated-policy-override'), JSON.stringify([...rules]))
})

test('allows dated decision links for superseded bullets and explicit retirement framing', t => {
  const { root, write } = createFixture(t)
  const base = readFileSync(join(root, DOCS_INDEX), 'utf8')
  write(
    DOCS_INDEX,
    base + '- Comma is retired and superseded by [Design System v2](design/decisions/2026-11-24-1518-design-system-v2.md).\n',
  )
  const result = auditDocsIndex(root)
  assert.deepEqual(result.findings, [])
})

test('extractPrimitivesCitations ignores SQL expressions, URLs, and route paths', () => {
  const sample = [
    'Use `lib/primitives/jsonb-predicates.ts` instead of `(m.message->>\'mikkaSuperseded\')::boolean`.',
    'Visit `/preview/design-system`, `/health`, `/jwks.json`, and `https://github.com/aspectly-labs/Mikka`.',
    'Cross-repo: `mikka-cloud/operations/primitives/deep-health.mjs`.',
  ].join('\n')
  const parsed = extractPrimitivesCitations(sample)
  assert.deepEqual(parsed.localPaths.map(p => p.target), ['lib/primitives/jsonb-predicates.ts'])
  assert.deepEqual(parsed.crossRepoRefs.map(p => p.target), ['mikka-cloud/operations/primitives/deep-health.mjs'])
  assert.deepEqual(parsed.invalidRefs, [])
})

test('CLI exits 0 on valid fixture, 1 on missing file, and supports --json', t => {
  const { root } = createFixture(t)
  const pass = spawnSync(process.execPath, [auditScript, '--root', root, '--json'], { encoding: 'utf8' })
  assert.equal(pass.status, 0, pass.stderr)
  const parsed = JSON.parse(pass.stdout)
  assert.equal(parsed.ok, true)

  rmSync(join(root, 'lib/primitives/error-contract.ts'))
  const fail = spawnSync(process.execPath, [auditScript, '--root', root], { encoding: 'utf8' })
  assert.equal(fail.status, 1)
  assert.match(fail.stderr, /rule-as-code\/missing-local-path/)
  assert.match(fail.stderr, /lib\/primitives\/error-contract\.ts/)
})

test('the repository itself passes the rule-as-code audit gate', () => {
  const result = auditRuleAsCodeRepository()
  assert.equal(result.ok, true, result.findings.map(f => `${f.file}:${f.line} [${f.rule}] ${f.message}`).join('\n'))
  assert.ok(result.summary.checkedLocalPaths >= 25, `expected >= 25 local paths, got ${result.summary.checkedLocalPaths}`)
  assert.ok(result.summary.crossRepoRefs >= 10, `expected >= 10 cross-repo refs, got ${result.summary.crossRepoRefs}`)
  assert.ok(result.summary.checkedScripts >= 1, `expected >= 1 checked script, got ${result.summary.checkedScripts}`)
  assert.ok(result.details.checkedScripts.includes('check:rule-as-code'))
  // The frozen archive moved to mikka-hosted-ui/docs/design/decisions.md with the UI docs (2026-11-26).
  assert.equal(result.summary.frozenDecisionRows, 0, 'the frozen decision archive belongs in mikka-hosted-ui, not here')
  // Links into docs/design became links to the private hosted repo (not checked locally) on 2026-11-26.
  assert.ok(result.summary.checkedDocsIndexLinks >= 40, `expected >= 40 docs/README links, got ${result.summary.checkedDocsIndexLinks}`)
})

test('rule-as-code audit runs once on every non-draft candidate including docs-only PRs and conversation-protocol test is CI-wired', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    pkg.scripts['check:rule-as-code'],
    'node scripts/rule-as-code-audit.mjs && node --test scripts/rule-as-code-audit.test.mjs',
  )
  assert.ok(pkg.scripts.check.split(' && ').includes('pnpm check:rule-as-code'))
  assert.equal(
    pkg.scripts['test:ui-policy'].includes('scripts/rule-as-code-audit.test.mjs'),
    false,
    'rule-as-code tests must not duplicate between test:ui-policy and check:rule-as-code',
  )
  assert.ok(
    pkg.scripts['test:coordinator-stream'].includes('lib/primitives/conversation-protocol.test.ts'),
    'Layer 4 conversation-protocol test must be wired into a registered CI test script',
  )

  const workflow = readFileSync(new URL('../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
  const sourceChecks = workflow.slice(workflow.indexOf('\n  source-checks:'), workflow.indexOf('\n  daemon-checks:'))
  assert.equal(sourceChecks.includes('rule-as-code'), false, 'source-checks must not duplicate the rule-as-code gate')

  const uiPolicyJob = workflow.slice(workflow.indexOf('\n  ui-policy:\n'), workflow.indexOf('\n  browser-tests-full:\n'))
  assert.match(uiPolicyJob, /node scripts\/rule-as-code-audit\.mjs && node --test scripts\/rule-as-code-audit\.test\.mjs/)
  assert.match(uiPolicyJob, /github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft != true/)

  const browserTestsJob = workflow.slice(workflow.indexOf('\n  browser-tests:\n'))
  assert.equal(browserTestsJob.includes('rule-as-code'), false, 'browser-tests must not duplicate the rule-as-code gate')
})
