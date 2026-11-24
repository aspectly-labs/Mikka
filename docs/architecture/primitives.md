# Mikka 7-layer primitive architecture

**Audience:** Engineers and coding agents building features, routes, queries, UI, or release automation across `aspectly-labs/Mikka`, `mikka-hosted-ui`, and `mikka-cloud`.
**Scope:** The seven executable Pit-of-Success primitive layers that turn product, security, reliability, and UI rules into compile-time types and automated CI gates.
**Out of scope:** Historical decision logs (`docs/design/decisions.md` is a frozen snapshot from 2026-10-31 and is not operating policy), per-feature specifications (`docs/design/`), and hosted secret runbooks (`docs/operations/README.md`).

Start at the [documentation index](../README.md) for general orientation. When prose and code disagree, the executable primitive and its CI gate win; update the documentation in the same pull request.

## Architecture map

The following table maps each primitive layer to its Pit-of-Success rule, owning module, and automated CI gate. Paths prefixed with `mikka-hosted-ui` or `mikka-cloud` (such as `mikka-hosted-ui/scripts/paid-overrides.mjs`) live in their respective private companion repositories; all unprefixed paths are verified on disk in `aspectly-labs/Mikka` by `scripts/rule-as-code-audit.mjs`.

| Layer | Domain | Pit-of-Success rule | Owning module / spec | Automated CI gate |
| --- | --- | --- | --- | --- |
| **1** | Design System v2 & UI primitives | Single token bridge (`palette.css`, WCAG AA `>= 4.5:1`, translucent `--rule`, quiet status washes), restricted primitives (`ChatStatusStrip` max 1 primary CTA, `TakeoverCard` mandatory `onDefer`/`Escape` + `max-h-[min(42dvh,320px)]`), `>= 55%` desktop / `>= 50%` compact scrollable transcript, 7-state interaction contract, and R-90 as-shipped paid blocks. | `docs/design/design-system.md`, `docs/design/decisions/2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md`, `mikka-hosted-ui/styles/palette.css`, `mikka-hosted-ui/components/mikka/chat-bottom/chat-status-strip.tsx`, `mikka-hosted-ui/components/mikka/chat-bottom/takeover-card.tsx`, `mikka-hosted-ui/preview/design-system/` (`/preview/design-system`) | `scripts/lint-ui.mjs`, `scripts/ui-policy.mjs`, `scripts/interaction-policy.mjs`, `scripts/copy-policy.mjs`, `scripts/check-i18n.mjs`, `scripts/check-copy.mjs`, `scripts/contrast.test.mjs`, `scripts/no-public-ui.test.mjs`, `mikka-hosted-ui/scripts/paid-overrides.mjs`, `mikka-hosted-ui/scripts/web-ui-policy.test.mjs`, `mikka-hosted-ui/scripts/chat-layout-governance.test.mjs`, `mikka-hosted-ui/scripts/design-system-geometry.test.mjs`, `mikka-hosted-ui/scripts/design-system-visual-evidence.mjs`, `mikka-hosted-ui/scripts/copy-budget.test.mjs`, `mikka-hosted-ui/scripts/official-build-excludes-preview.test.mjs`, `.github/workflows/ui-policy.yml`, `mikka-hosted-ui/.github/workflows/ui-policy.yml` |
| **2** | Error & quota recovery | Every user-reachable refusal, quota/rate limit, model-unavailable, auth/Turnstile/email, or execution failure normalizes to `MikkaErrorContract` with canonical machine `code`, `category`, `httpStatus`, `retryable`, optional `resetAt`, and strictly at most one typed `primaryAction` recovery CTA (zero stack or secret leaks). | `lib/primitives/error-contract.ts` | `pnpm test:hosted-usage`, `lib/primitives/error-contract.test.ts`, `scripts/error-cause-policy.mjs`, `.github/workflows/ui-policy.yml` |
| **3** | API route guards | Every HTTP route handler declares `auth`, `origin`, `workspace`, and `write` through `defineRoute(spec, handler)`, mapping `WorkspaceError` to canonical `403`/`409` JSON (never unhandled `500`), enforcing PAT workspace fencing, ratcheting unguarded legacy routes strictly downward, and enforcing diff-aware migration when legacy routes are modified. | `lib/primitives/define-route.ts` | `pnpm check:route-guard`, `lib/primitives/define-route.test.ts`, `scripts/route-guard-policy.mjs`, `scripts/route-guard-baseline.json`, `scripts/route-guard-policy.test.mjs`, `apps/api/scripts/generate-routes.mjs`, `.github/workflows/ui-policy.yml` |
| **4** | Conversation, thread & subagent protocol | Bot DMs (`bot:ID`), group chats (`group:ID`), task threads (`thread:ID`), and subagents (`subagent:ID`) share one typed ID codec, shell summary, turn/item union, and cursor page contract, enforcing `readOnly: true` and `canReply: false` on subagent shells at compile time. | `lib/primitives/conversation-protocol.ts` | `pnpm test:coordinator-stream`, `lib/primitives/conversation-protocol.test.ts`, `.github/workflows/ui-policy.yml` |
| **5** | Safe SQL & JSONB projections | Queries never perform unguarded `->>'...'::boolean` (or unguarded `::int`, `::integer`, `::bigint`, `::uuid`, `::numeric`, `::double precision`) casts on JSONB fields; all JSONB boolean, text, and scalar predicates use typed Drizzle helpers (`jsonbFlagIsTrue`, `jsonbFlagIsNotTrue`, `jsonbUnsetOrFalse`, `jsonbText`, `jsonbSafeInt`, `jsonbSafeUuid`). | `lib/primitives/jsonb-predicates.ts` | `pnpm check:sql-safety`, `lib/primitives/jsonb-predicates.test.ts`, `scripts/sql-safety-policy.mjs`, `scripts/sql-safety-policy.test.mjs`, `.github/workflows/ui-policy.yml` |
| **6** | Ops release, probe, registry & deep health | Rollout convergence probing (`rollout-probe.mjs`), fail-closed multi-World `EVE_RELEASES` reading and zero-instance pruning (`world-release-registry.mjs`), and composite `/health` + `/jwks.json` + release-version checks (`deep-health.mjs`) run through shared ops primitives while public core remains free of private cloud credentials and issuers. | `mikka-cloud/operations/primitives/rollout-probe.mjs`, `mikka-cloud/operations/primitives/world-release-registry.mjs`, `mikka-cloud/operations/primitives/deep-health.mjs`, `scripts/cloud-boundary-policy.mjs` | `pnpm check:cloud-boundary`, `scripts/cloud-boundary-policy.mjs`, `scripts/cloud-boundary-policy.test.mjs`, `.github/workflows/ui-policy.yml`, `.github/workflows/cloudflare-app-deploy.yml`, `mikka-cloud/.github/workflows/eve-lifecycle-tests.yml`, `mikka-cloud/.github/workflows/zero-residency-guard.yml` |
| **7** | Rule-as-code verification | Every local path, markdown link, and `pnpm` script cited in this map exists on disk; cross-repo markers use explicit `mikka-hosted-ui` or `mikka-cloud` prefixes; frozen `docs/design/decisions.md` retains its non-authoritative banner with no post-freeze rows; `docs/README.md` stays free of broken links and undated or unlinked rule contradictions. | `scripts/rule-as-code-audit.mjs`, `docs/architecture/primitives.md` | `pnpm check:rule-as-code`, `scripts/rule-as-code-audit.mjs`, `scripts/rule-as-code-audit.test.mjs`, `.github/workflows/ui-policy.yml` |

## Layer contracts

The following sections summarize the failure mode each layer eliminates and the rule contributors follow when adding or modifying code.

### Layer 1: Design System v2 & UI primitives

Visual tokens, chat layout geometry, copy density, and the 7-state interaction contract are specified in [Design System v2](../design/design-system.md). Build Mikka surfaces with restricted primitives (`ChatStatusStrip` for 1-line single-CTA notices; `TakeoverCard` with mandatory `onDefer` and `Escape` inside `ChatBottomSlotProvider`), keep paid blocks as shipped under `mikka-hosted-ui/scripts/paid-overrides.mjs`, and inspect specimens in the isolated `/preview/design-system` gallery (`mikka-hosted-ui/preview/design-system/`).

### Layer 2: Error & quota recovery

Map backend refusals, billing/quota limits, model unavailability, Turnstile/auth-email errors, and run failures through `lib/primitives/error-contract.ts` (`MikkaErrorContract`). Each error emits at most one typed `primaryAction` so Web, Desktop, and iOS render a single-action strip rather than multi-button walls or raw internal errors.

### Layer 3: API route guards

Wrap HTTP handlers under `app/api/` with `defineRoute` from `lib/primitives/define-route.ts` so authentication mode, origin policy (including native mobile `mikka://`), workspace membership or PAT scope, and write guards are explicit at declaration time. Never add an unguarded route above the ratcheted ceiling or modify a legacy unguarded route without migrating it under `scripts/route-guard-policy.mjs`.

### Layer 4: Conversation, thread & subagent protocol

Normalize Bot DM, group chat, task thread, and subagent payloads through `lib/primitives/conversation-protocol.ts`. Typed prefixed IDs (`bot:`, `group:`, `thread:`, `subagent:`), shell summaries, turn/item unions, and pagination cursors stay identical across backend, Web, and iOS, and subagent shells are read-only by type.

### Layer 5: Safe SQL & JSONB projections

Use `lib/primitives/jsonb-predicates.ts` whenever filtering or projecting JSONB columns in SQL. Direct casts such as `(message->>'mikkaSuperseded')::boolean` throw PostgreSQL runtime `500` errors when a field stores a string or UUID; `scripts/sql-safety-policy.mjs` fails CI if an unguarded cast appears in source.

### Layer 6: Ops release, probe, registry & deep health

Hosted deployment convergence, container-capacity hygiene (`EVE_RELEASES` pruning under the Cloudflare container ceiling), and deep readiness checks live in `mikka-cloud/operations/primitives/` (`rollout-probe.mjs`, `world-release-registry.mjs`, `deep-health.mjs`). Public `aspectly-labs/Mikka` stays strictly free of private cloud issuers, credentials, and metering schemas through `scripts/cloud-boundary-policy.mjs`.

### Layer 7: Rule-as-code verification

Run the local audit and its unit suite whenever you add, rename, or retire a primitive, CI gate, or authoritative document:

```bash
pnpm check:rule-as-code
```

The gate runs `node scripts/rule-as-code-audit.mjs` and `node --test scripts/rule-as-code-audit.test.mjs`, verifying every local path and script citation on this page, preserving the frozen-history guard in `docs/design/decisions.md`, and preventing stale or unlinked rule contradictions in `docs/README.md`.
