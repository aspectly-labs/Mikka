# Semantic Anti-Hardcoding Lint Calibration

Calibration record, explicit allowlist table, and `warn` -> `error` promotion criteria for Mikka's semantic anti-hardcoding lint engine (`scripts/semantic-lint/index.mjs`, Issue #3342).

## Overview and scope

The semantic lint engine complements Mikka's mechanical Oxlint gates (G1–G6) with fast, deterministic, zero-network TypeScript compiler AST checks (`typescript` `createSourceFile`) for higher-level architectural anti-hardcoding patterns that evade token-level rules:

| Rule | Target anti-pattern | Primary remediation target |
| --- | --- | --- |
| `no-hardcoded-business-policy` | Hardcoded trial/promo durations, discount rates, plan prices, promotional cutoff dates, and plan quota ceilings in application logic | Tier-3 policy/catalog (`lib/governance/capabilities.ts`, `lib/billing/catalog.ts`) or Tier-4 runtime config (`lib/runtime-config/`) |
| `no-mode-flags` | Host/deployment/surface mode boolean flags (`isHostedMode`, `isCloudMode`, `surfaceMode`, etc.) and multi-branch `if/else if` or `switch` checks on `'cloud' \| 'hosted' \| 'selfhost' \| 'community'` | Declarative workspace capabilities (`lib/governance/capabilities.ts`) or platform adapters (`lib/platform/`) |
| `no-provider-or-plan-special-casing` | Scattered AI provider checks/switches (`openai`, `anthropic`, `google`, `vertex`, `bedrock`, etc.) and plan-tier branching (`tier`, `subscriptionTier`, `planSlug`, etc.) evading G3 | Model gateway/catalog/provider adapters (`lib/model-gateway/`, `lib/model-catalog*.ts`, `lib/model-api-key*.ts`) or declarative capabilities (`lib/governance/capabilities.ts`) |
| `no-constant-stub-tests` | Tautological constant-stub test assertions that compare local hardcoded business/pricing/plan/model constants or trivial stub helpers against static literals without calling any production code | Import and exercise the real production module under test |

### CLI contract

```bash
# Advisory mode (prints findings, exits 0)
node scripts/semantic-lint/index.mjs --mode=warn --json

# Enforcing mode (default; exits 1 on any finding)
node scripts/semantic-lint/index.mjs --mode=error

# Target an alternate directory or filter specific rule(s)
node scripts/semantic-lint/index.mjs --root scripts/semantic-lint/fixtures/no-mode-flags --rule no-mode-flags
```

Supported flags:
- `--mode=warn|error` (default: `error`)
- `--json` (outputs `{ mode, filesScanned, totalFindings, byRule, findings, durationMs }`)
- `--root <dir>` (scans an alternate directory or single file)
- `--rule <rule-name>` (repeatable or comma-separated filter)

### Scan roots and exclusions

Default repository scan roots (`.ts`, `.tsx`, `.mts`, `.js`, `.mjs`):
- `app/`
- `apps/api/`
- `apps/frontend/src/`
- `cloudflare/`
- `lib/`
- `services/`
- `workflows/`

Excluded directories and paths:
- `node_modules/`, `dist/`, `.output/`, `.hosted-ui/`, `.git/`, `.nitro/`, `.cache/`, `coverage/`
- `apps/api/generated/`
- `scripts/semantic-lint/fixtures/` (excluded on repository scans; directly scannable via `--root`)

## Calibration methodology

1. **Zero-network AST execution with sound prefiltering:** Each file is read once after per-rule path allowlist checks. Each rule exposes a mathematically sound `mightMatch(source)` prefilter (100% recall for every AST pattern that `check(ctx)` can emit) so `ts.createSourceFile(..., setParentNodes=false)` runs lazily only when at least one active rule can plausibly match.
2. **Fixture verification:** Positive (must flag) and negative (must pass with 0 findings) fixtures live under `scripts/semantic-lint/fixtures/<rule-name>/` and are verified automatically by `node --test scripts/semantic-lint/semantic-lint.test.mjs`.
3. **Live repository sweep:** Ran `node scripts/semantic-lint/index.mjs --mode=warn --json` against the full `Mikka` repository and audited every finding individually to separate false positives, legitimate architectural adapter boundaries, and genuine anti-hardcoding debt.
4. **Supplemental `tests/` sweep:** Also ran `--root tests --rule no-constant-stub-tests --mode=warn --json` across the top-level `tests/` tree to confirm zero constant-stub regressions there as well.

## Live repository calibration counts

Measured on branch `feat/3342-wave3-semantic-gate-and-docs`:

- **Default repository scan:** 3,585 candidate files discovered; **3,573 files scanned** (12 non-test files are allowlisted by all three production rules and not test files).
- **End-to-end runtime:** **~2.9–3.5 seconds** across the full repository (within the `< 5s` CI budget, zero network calls).
- **Supplemental `tests/` scan (`no-constant-stub-tests`):** 284 test files scanned in ~1.1s, **0 findings**.

| Rule | Eligible files | Allowlisted files | AST-parsed files | Initial live findings | Post-calibration findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| `no-hardcoded-business-policy` | 2,420 | 1,165 | 8 | 1 | 0 |
| `no-mode-flags` | 2,437 | 1,148 | 47 | 0 | 0 |
| `no-provider-or-plan-special-casing` | 2,285 | 1,300 | 28 | 2 | 0 |
| `no-constant-stub-tests` | 1,117 | 0 | 154 | 0 | 0 |
| **Total** | **3,573 scanned** | — | **237 rule-parses** | **3** | **0** |

## Audit of initial live findings

Every single finding returned on the initial uncalibrated scan was audited directly in source:

### 1. `apps/api/scripts/dev.mjs:237` — `no-hardcoded-business-policy` (False positive -> heuristic refined)

- **Code:** `new Agent({ keepAlive: true, maxSockets: 256, maxTotalSockets: 256, maxFreeSockets: 64 })`
- **Classification:** False positive.
- **Root cause:** `maxFreeSockets` is a standard Node.js `http.Agent` keep-alive connection pool setting ("free" = idle socket), not a Free-plan quota ceiling.
- **Resolution:** Refined `scripts/semantic-lint/rules/no-hardcoded-business-policy.mjs` with `NON_BUSINESS_FREE_POOL_RE` to ignore low-level system pool identifiers (`maxFreeSockets`, `maxFreeMemory`, `maxFreeBytes`, `maxFreeConnections`, `maxFreeHandles`, `maxFreeBuffers`, `maxFreePages`, `maxFreeBlocks`, `maxFreeSpace`, `maxFreeSlots`, `maxFreeHeap`, `maxFreePool`) while continuing to flag business quota constants such as `MAX_FREE_WORKSPACES`, `MAX_FREE_SEATS`, `FREE_PLAN_LIMIT`, and `PRO_PLAN_LIMIT`.

### 2. `lib/run-credential-source.ts:44` — `no-provider-or-plan-special-casing` (Legitimate adapter boundary -> allowlisted)

- **Code:** `const VENDOR_PRESET: Record<string, ApiKeyView['provider']> = { anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', moonshotai: 'kimi' }` indexed by `vendorOf(model)`
- **Classification:** Legitimate model-credential / API-key provider adapter boundary.
- **Root cause:** `lib/run-credential-source.ts` translates upstream catalog vendor identifiers (such as `moonshotai`) to stored `model_api_keys` preset providers (`kimi`) when resolving user API keys for catalog models.
- **Resolution:** Added `lib/run-credential-source.ts` to the explicit provider-adapter allowlist in `no-provider-or-plan-special-casing`.
- **Optional follow-up:** Moving `VENDOR_PRESET` into `lib/model-api-key-providers.ts` would allow removing this file's carve-out in a future refactor.

### 3. `lib/chat-attachments/transcribe.ts:18` — `no-provider-or-plan-special-casing` (Legitimate adapter boundary -> allowlisted)

- **Code:** `keys.filter((item) => item.provider === 'openai')`
- **Classification:** Legitimate speech-to-text provider adapter boundary.
- **Root cause:** `lib/chat-attachments/transcribe.ts` is the 40-line audio transcription adapter that routes user-supplied OpenAI Whisper/Transcribe API keys through LiteLLM's transcription endpoint.
- **Resolution:** Added `lib/chat-attachments/transcribe.ts` to the explicit provider-adapter allowlist in `no-provider-or-plan-special-casing`.
- **Optional follow-up:** Exposing a capability predicate (for example `supportsAudioTranscription(key)`) from `lib/model-api-key-providers.ts` would allow removing this file's carve-out in a future refactor.

### 4. Prefilter calibration in `no-constant-stub-tests` (Precision & performance improvement)

- **Observation:** Initial price-literal regex `/\$\d+/` matched PostgreSQL bind parameters (`$1`, `$2`, `$3`) in `.db.test.ts` files, causing unnecessary AST parsing of ~220 database integration tests and pushing full-repo wall time above 5s.
- **Resolution:** Tightened `BUSINESS_STRING_VALUE_RE` and `PREFILTER_BUSINESS_LITERAL_RE` to match genuine currency strings (`$20`, `$19.99`, `$20/mo`, `$200/yr`, `$15/seat`) and model IDs (`claude-*`, `gpt-*`, `gemini-*`) without matching SQL `$1` placeholders, cutting full-repo runtime from ~6.3s down to **~2.9–3.5s** with zero loss in rule recall.

## Explicit per-rule allowlist carve-outs

Every allowlist entry must correspond to a documented Tier-2/Tier-3/Tier-4 owner module, provider adapter, migration, or test boundary. Do not add broad catch-all globs.

### `no-hardcoded-business-policy`

| Glob pattern | Justification |
| --- | --- |
| `lib/billing/**` | Tier-3 billing catalog, Stripe checkout, points, and plan pricing boundary |
| `lib/runtime-config/**` | Tier-4 remote runtime configuration schemas, defaults, and adapters |
| `lib/governance/policy.ts`, `lib/governance/capabilities.ts` | Tier-3 declarative entitlement and workspace capability contracts |
| `lib/cloud-computer/machine-pricing.ts` | Canonical cloud machine pricing specification |
| `lib/abuse/policy.ts` | Canonical abuse-prevention policy thresholds |
| `migrations/**`, `**/migrations/**`, `drizzle/**` | Historical immutable database schema migrations |
| `tests/**`, `**/test/**`, `**/tests/**`, `**/fixtures/**`, `**/*.test.*`, `**/*.db.test.*`, `**/*.spec.*`, `**/*.fixture.*`, `**/*.bench.*`, `**/testing/**` | Test suites and test fixtures (covered separately by `no-constant-stub-tests`) |

### `no-mode-flags`

| Glob pattern | Justification |
| --- | --- |
| `lib/edition.ts`, `lib/governance/edition.ts` | Canonical deployment edition (`community` vs `cloud`) and `deploymentMode()` resolvers |
| `lib/governance/policy.ts`, `lib/governance/capabilities.ts` | Tier-3 resolvers translating deployment mode + plan into declarative `WorkspaceCapabilities` |
| `lib/env/**` | Tier-2 typed environment contract boundary |
| `lib/deployment-stage.mjs`, `lib/deployment-switches.ts`, `lib/feature-flags.ts`, `lib/server-info.ts` | Explicit deployment stage, rollout switch, feature-flag, and server metadata adapters |
| `lib/platform/**` | Platform runtime detection and host integration adapters |
| Test globs (`tests/**`, `**/*.test.*`, etc.) | Test suites and fixtures |

### `no-provider-or-plan-special-casing`

| Glob pattern | Justification |
| --- | --- |
| `lib/model-catalog*.ts` | Canonical model catalog metadata, vendor mapping, and snapshot loader |
| `lib/model-gateway/**` | Model gateway protocol translation (`anthropic` Messages / `openai` Responses / LiteLLM upstream) |
| `lib/model-api-key*.ts`, `lib/model-routing.ts`, `lib/model-order.ts`, `lib/run-credential-source.ts` | API-key provider presets, model routing, ordering, and catalog-vendor credential matching |
| `lib/chat-attachments/transcribe.ts` | Audio transcription provider adapter selecting OpenAI transcription keys for LiteLLM |
| `lib/subscription-*.ts` | BYOS subscription provider adapters and quota decoders |
| `lib/credentials/**`, `lib/plugins/**`, `lib/operations/**` | Credential brokers, plugin/integration adapters, and workspace operation adapters |
| `lib/auth*.ts`, `lib/google-link.ts` | OAuth identity provider adapters |
| `lib/eve/factory/providers.ts` | Factory provider registry adapter |
| `lib/governance/policy.ts`, `lib/governance/capabilities.ts`, `lib/governance/provisioning.ts`, `lib/enterprise/provisioning.ts`, `lib/billing/**` | Tier-3 governance capability resolvers, operator plan provisioning, and billing catalog boundary |
| Test globs (`tests/**`, `**/*.test.*`, etc.) | Test suites and fixtures |

### `no-constant-stub-tests`

| Glob pattern | Justification |
| --- | --- |
| *(none — empty allowlist)* | Applies to every `**/*.test.{ts,tsx,mts,js,mjs}` file in the scan scope; rare justified exceptions must use an explicit inline directive with a reason |

## Inline exception policy

When a localized exception is genuinely unavoidable outside an allowlisted adapter directory, engineers must use an explicit inline justification directive on the same line or immediately preceding line:

```ts
// semantic-lint-allow: no-mode-flags — legacy adapter shim tracked in #3342
```

Rules enforced mechanically by `scripts/semantic-lint/index.mjs`:
- A valid directive must name a known rule and supply a meaningful justification reason after `—` (or `--`, `–`, `-`, `:`).
- **Bare disable comments are forbidden:** `// semantic-lint-allow: <rule-name>` without a reason (or with an empty/punctuation-only reason) never suppresses the finding and itself emits a blocking lint finding.
- Directives inside string literals are ignored via TypeScript lexer scanning.

## Promotion criteria (`warn` -> `error`)

Use the following objective stage gates before promoting semantic lint (or any newly added semantic rule) from `--mode=warn` to blocking `--mode=error` in CI:

1. **Zero genuine unresolved debt:** `node scripts/semantic-lint/index.mjs --mode=warn --json` reports `totalFindings === 0` on `main` (all genuine findings burned down; zero temporary baselines).
2. **Zero audited false positives:** Every live-repo match during calibration has been audited and resolved either by tightening the rule's AST heuristic or by documenting an explicit architectural adapter boundary in this file.
3. **Full positive/negative fixture coverage:** Each rule has positive and negative fixture suites under `scripts/semantic-lint/fixtures/<rule-name>/` passing under `node --test scripts/semantic-lint/semantic-lint.test.mjs`, including verification that bare `semantic-lint-allow` comments fail closed.
4. **Performance budget:** Full-repository scan completes in `< 5 seconds` deterministically with zero network requests.
5. **Rollout sequence:**
   - **Stage 1 (Advisory / Calibration):** Run `node scripts/semantic-lint/index.mjs --mode=warn --json` in CI while auditing new rule heuristics on real PR traffic.
   - **Stage 2 (Blocking Enforcement):** Once criteria 1–4 hold continuously with 0 false positives, promote CI to `node scripts/semantic-lint/index.mjs --mode=error` (all four initial rules already satisfy criteria 1–4 on `main` and pass `--mode=error` with `0` findings today).
   - **Future rules:** Introduce new semantic rules behind `--mode=warn` during calibration, burn down any genuine findings to zero, add positive/negative fixtures, document carve-outs here, and only then promote the rule to `--mode=error`.
