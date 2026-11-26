# Five-Tier Truth Model & anti-hardcoding gates

**Audience:** Engineers and coding agents adding configuration, pricing, entitlements, model catalogs, host routing, runtime flags, or localized copy across `aspectly-labs/Mikka` and `mikka-hosted-ui`.
**Scope:** The five truth tiers (T1–T5), the placement decision rule, the six mechanical CI gates (G1–G6) enforced at zero ratchet baselines, and the four-rule semantic lint gate.
**Out of scope:** Secret values and private deployment inventories (see private `mikka-cloud/AGENTS.md`), visual token rules ([Design System v2](../design/design-system.md)), and historical decision snapshots (`docs/design/decisions.md` is frozen pre-2026-11-01 history and is not operating policy).

Start at the [documentation index](../README.md) for general orientation and [7-layer primitive architecture](primitives.md) for the broader executable gate map. When prose and code disagree, the executable gate wins; update this document in the same pull request.

## Five-Tier Truth Model (T1–T5)

Every value in Mikka belongs to exactly one tier based on what owns it and how it changes:

| Tier | Truth class | Owning modules & surfaces | Contract & boundary |
| --- | --- | --- | --- |
| **T1** | Structural invariants (code) | `lib/primitives/*`, `lib/db/*`, `lib/governance/capabilities.ts` | Protocol codecs, SQL schemas, auth/tenant isolation invariants, state machines, and Zod schemas. Changing these alters system invariants or wire contracts and legitimately requires code review and deployment. |
| **T2** | Deployment / environment configuration (validated env boundary) | `lib/env/runtime.mjs`, `lib/env/server.ts`, `lib/env/public.ts`, `lib/env/hosts.ts`, `lib/env/hosts-constants.mjs` (re-exported via `lib/env/index.ts`) | Zod-validated typed helpers with explicit `EnvMap` injection so tests never mutate global `process.env`. Zero raw `process.env` reads and zero hardcoded loopback or internal host strings (`127.0.0.1`, `localhost`, `::1`, `[::1]`, `product.internal`) outside `lib/env/**`. |
| **T3** | Authoritative domain & billing catalog (API / provider / DB) | `WorkspaceCapabilities` (`lib/governance/capabilities.ts`, `lib/governance/policy.ts`, `lib/governance/entitlements.ts`, `lib/governance/lease.ts`), live Stripe-backed `BillingCatalog` (`lib/billing/catalog.ts`, `lib/billing/catalog-client.ts`, `GET /api/billing/catalog` in `app/api/billing/catalog/route.ts`), and model catalog (`lib/model-catalog.ts`, `lib/model-catalog-metadata.ts`, `lib/model-catalog-server.ts`, `lib/model-catalog-snapshot.json`, `lib/model-display-name.ts`) | Server-authoritative plans, pricing, machine SKUs, workspace capabilities, and model catalogs. Routes and UI consume semantic capabilities and catalog entries instead of branching on tier names or hardcoding upstream model IDs or prices. |
| **T4** | Mutable runtime configuration (Remote Config / flags) | `lib/runtime-config/schema.ts`, `lib/runtime-config/adapters.ts`, `lib/runtime-config/index.ts`, generated [`docs/operations/config-contracts.md`](../operations/config-contracts.md) | Registered in `RUNTIME_CONFIG_DEFINITIONS` (`mikka-config-*`) with strict Zod schemas, safe fallbacks, `[startAt, endAt)` time windows, optional `environments` (`production`, `preview`, `local`) scoping, synchronous non-throwing reads, throttled lazy refresh (no background polling), PostHog `/flags?v=2` + KV/DB composite adapters, and production-guarded test overrides (`overrideRuntimeConfig`). |
| **T5** | Localized presentation copy | `messages/zh-CN.json`, `messages/en.json` (`messages/*.json`) | ICU-parameterized user-facing copy only. Never hardcode currency prices, billing rates, credit conversion ratios, or machine SKU specs in translation strings; supply dynamic values from T2–T4 data via ICU placeholders. |

## Decision rule: "Should changing this require a deploy?"

Ask three questions before introducing any constant, branch, or copy string:

1. **Does changing this alter a protocol contract, SQL schema, state machine, or auth/tenant invariant?**
   - **Yes → T1 (code).** Define it as a typed invariant or Zod contract in `lib/primitives/`, `lib/db/`, or the owning domain module.
   - **No →** continue to Question 2.
2. **Is it a per-environment binding, origin, host, or secret locator that stays fixed for a deployment revision?**
   - **Yes → T2 (`lib/env/`).** Add a Zod-validated accessor accepting an optional `EnvMap = runtimeEnv()` under `lib/env/` and never read `process.env` or hardcode loopback/internal hosts elsewhere.
   - **No →** continue to Question 3.
3. **Is it authoritative commercial/domain catalog state or an operator-tuned runtime knob?**
   - **Provider/DB source of truth (prices, plan entitlements, machine SKUs, model metadata) → T3.** Expose it through `BillingCatalog` (`GET /api/billing/catalog`), `WorkspaceCapabilities` (`lib/governance/capabilities.ts`), or `lib/model-catalog*.ts`.
   - **Operator-tuned or time-bounded knob (intro offers, banners, safety caps, temporary entitlement overrides) → T4.** Register a `mikka-config-*` contract in `lib/runtime-config/schema.ts` with a strict Zod schema, owner, and safe fallback, then run `pnpm docs:generate`.
   - **User-visible wording presenting any T1–T4 value → T5.** Add ICU-parameterized strings to `messages/*.json` and pass all amounts, rates, SKUs, and durations as parameters.

## Mechanical CI gates (G1–G6)

All six anti-hardcoding gates run at **zero ratchet baselines**. The historical `scripts/baselines/` directory is permanently deleted and its continued absence is enforced by `scripts/anti-hardcoding-gates.test.mjs`; any new violation or re-created baseline directory fails CI immediately.

| Gate | Rule / checker | Enforced by | Scope & rule |
| --- | --- | --- | --- |
| **G1** | `mikka/no-raw-process-env` | `scripts/oxlint-plugin-mikka.mjs` (`.oxlintrc.json`), `pnpm lint:code`, `pnpm test:anti-hardcoding` | Bans direct `process.env`, `globalThis.process.env`, `global.process.env`, destructuring `env` from `process`, and importing `env` from `process`/`node:process` outside `lib/env/**` and explicit script/config/test allowlists. |
| **G2** | Business literals in i18n | `scripts/check-i18n.mjs`, `pnpm i18n:check`, `pnpm test:i18n` | Rejects hardcoded currency amounts (`$`, `US$`, `¥`, `€`, `£`, `USD`, `CNY`, `EUR`, `GBP`, `美元`, `人民币`, `元`), billing rates (`/hr`, `/mo`, `/yr`, `/小时`, `/月`, `/年`), machine SKU specs (`vCPU`, `GiB`), and credit/point conversion equations in `messages/*.json`. |
| **G3** | `mikka/no-plan-name-branching` | `scripts/oxlint-plugin-mikka.mjs` (`.oxlintrc.json`), `pnpm lint:code`, `pnpm test:anti-hardcoding` | Bans equality comparisons, `switch` cases, `.includes()`, `Set.has()`, and keyed object lookups on plan identifiers (`free`, `pro`, `enterprise`, `starter`, `max`) or plan-derived editions (`team_free`, `team_pro`, `enterprise`) outside the governance/billing policy modules; callers must read `WorkspaceCapabilities`. |
| **G4** | `mikka/no-hardcoded-model-ids` | `scripts/oxlint-plugin-mikka.mjs` (`.oxlintrc.json`), `pnpm lint:code`, `pnpm test:anti-hardcoding` | Bans literal `claude-*`, `gpt-*`, and `gemini-*` upstream model IDs in strings, templates, and regexes outside `lib/model-catalog*.ts`, `lib/model-catalog-snapshot.json`, `lib/model-display-name.ts`, and test fixtures. |
| **G5** | `mikka/no-hardcoded-hosts` | `scripts/oxlint-plugin-mikka.mjs` (`.oxlintrc.json`), `pnpm lint:code`, `pnpm test:anti-hardcoding` | Bans literal `127.0.0.1`, `localhost`, `::1`, `[::1]`, and `product.internal` in strings, templates, and regexes outside `lib/env/**` and explicit dev-script/test allowlists. |
| **G6** | Config & capability contract sync | `scripts/config-contract-sync.mjs`, `pnpm check:config-contracts`, `pnpm docs:check` | Validates every `RUNTIME_CONFIG_DEFINITIONS` entry (`key`, unique `mikka-config-*` flag, `owner`, `description`, optional `environments`, strict Zod `schema`, schema-valid `fallback`), enforces 1:1 owner coverage between `workspaceCapabilitiesSchema` and `WORKSPACE_CAPABILITY_OWNERS`, and verifies [`docs/operations/config-contracts.md`](../operations/config-contracts.md) is freshly generated. |

### Companion hosted-UI gates

Private `mikka-hosted-ui` enforces matching zero-baseline AST rules across Mikka-owned UI production directories (`components/mikka/**`, `slots/**`, `web/**`, `core/**`, `hooks/**`, `lib/**`, `utils/**`) via `mikka-hosted-ui/scripts/oxlint-plugin-mikka-ui.mjs`:

- `mikka-ui/no-raw-process-env` (G1)
- `mikka-ui/no-plan-name-branching` (G3)
- `mikka-ui/no-hardcoded-model-ids` (G4)
- `mikka-ui/no-hardcoded-hosts` (G5)
- `mikka-ui/no-hardcoded-pricing-literals` (UI companion to G2 for inline TSX/TS strings)

As-shipped paid-block vendor directories remain untouched under R-90.

## Semantic lint gate

Static AST rules (G1–G5) catch token- and expression-level patterns deterministically, while `scripts/semantic-lint/` (`scripts/semantic-lint/index.mjs`, run via `pnpm lint:semantic` and verified via `pnpm test:semantic-lint`) executes a full-repository TypeScript AST scan across `DEFAULT_SCAN_ROOTS` at zero baselines to catch higher-level architectural anti-patterns that evade literal matching:

| Rule | Anti-pattern caught | Required truth tier / pattern |
| --- | --- | --- |
| `no-hardcoded-business-policy` | Hardcoded trial/promo durations, pricing/discount constants, campaign start/end dates, and plan quota ceilings encoded directly in application logic (i18n/UI credit rates and SKU specs are guarded separately by G2 and `mikka-ui/no-hardcoded-pricing-literals`). | Read from T3 (`lib/billing/catalog.ts`, `lib/governance/capabilities.ts`) or T4 (`lib/runtime-config/`), with ICU-parameterized T5 copy. |
| `no-mode-flags` | Host/deployment/surface mode boolean flags (`isHostedMode`, `isCloudMode`, `isSelfHostMode`, `surfaceMode`, `deploymentModeFlag`, etc.) and multi-branch `if/else if` or `switch` checks on `'cloud' \| 'hosted' \| 'selfhost' \| 'community'`. | Branch on declarative `WorkspaceCapabilities` (`lib/governance/capabilities.ts`) or platform adapters (`lib/platform/`) instead of edition/host mode toggles. |
| `no-provider-or-plan-special-casing` | Scattered AI provider checks, switches, or lookup maps (`openai`, `anthropic`, `google`, `vertex`, `bedrock`, etc.) and plan-tier branching (`tier`, `subscriptionTier`, `planSlug`, etc.) outside model gateway/catalog/provider adapters or governance/billing policy modules. | Centralize provider metadata in `lib/model-gateway/` / `lib/model-catalog*.ts` and feature gating in `lib/governance/capabilities.ts`. |
| `no-constant-stub-tests` | Tautological constant-stub test assertions that compare local hardcoded business/pricing/plan/model constants or trivial stub helpers against static literals without calling any production code. | Import and exercise real T1–T4 production modules with injected `EnvMap`, Zod schema inputs, and real capability/catalog/config evaluators. |

Calibration methodology, allowlist justification, and full-repository scan results are maintained in [`docs/operations/semantic-lint-calibration.md`](../operations/semantic-lint-calibration.md).

## Verification commands

Run these local checks whenever modifying configuration boundaries, billing/model catalogs, workspace capabilities, runtime config schemas, or localized copy:

```bash
pnpm lint:code
pnpm i18n:check
pnpm test:anti-hardcoding
pnpm check:config-contracts
pnpm lint:semantic
pnpm test:semantic-lint
pnpm docs:check
```
