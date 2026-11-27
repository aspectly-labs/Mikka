# Mikka Engineering Handbook

**Audience:** Engineers, designers, and coding agents shipping product, infrastructure, or operational changes across `aspectly-labs/Mikka`, `aspectly-labs/mikka-hosted-ui`, and `aspectly-labs/mikka-cloud`.
**Scope:** Mikka's end-to-end 6-stage Software Development Life Cycle (SDLC) and Three-Tier Documentation Architecture across Web, Desktop, iOS, API, Eve, Task runtime, CLI, daemon, and Cloudflare operations.
**Out of scope:** Secret values, account credentials, and private deployment targets (see private `mikka-cloud/AGENTS.md` and `mikka-cloud/docs/operations/README.md`), per-feature product specifications (`docs/design/`), and frozen pre-2026-11-01 history (`docs/design/decisions.md`).

This handbook is the single Living Standard for how Mikka moves work from specification to production and turns every production incident into a permanent mechanical guard. Start at [`AGENTS.md`](../../AGENTS.md) for agent context routing and [`docs/README.md`](../README.md) for the full documentation index.

## Six-stage SDLC at a glance

The following table maps each stage to its required artifact, owning repositories, and enforcing mechanical gates:

| Stage | Objective | Primary spec / template | Owning repositories | Enforcing mechanical gates |
| --- | --- | --- | --- | --- |
| **1. Product & UI Spec** | Define the user job, reference target, 7 interaction states, and copy before coding | [`templates/ui-spec.md`](templates/ui-spec.md), [`docs/design/design-system.md`](../design/design-system.md), [`docs/review-checklist.md`](../review-checklist.md) | `Mikka`, `mikka-hosted-ui` | `scripts/check-i18n.mjs`, `scripts/check-copy.mjs`, `scripts/copy-policy.mjs`, `mikka-hosted-ui/scripts/copy-budget.test.mjs` |
| **2. Architecture & Contracts** | Reuse Pit-of-Success primitives, preserve repo boundaries, and plan zero-downtime compatibility | [`templates/design-doc.md`](templates/design-doc.md), [`docs/architecture/primitives.md`](../architecture/primitives.md) | `Mikka`, `mikka-hosted-ui`, `mikka-cloud` | `scripts/no-public-ui.test.mjs`, `scripts/cloud-boundary-policy.mjs`, `scripts/check-migrations.mjs`, `mikka-hosted-ui/scripts/paid-sources.mjs` |
| **3. Coding Standards & Static Analysis** | Enforce security, SQL safety, UI contracts, and zero patch stacking at commit time | [`AGENTS.md`](../../AGENTS.md), [`docs/design/rules.md`](../design/rules.md) | `Mikka`, `mikka-hosted-ui` | `pnpm lint:code` (`oxlint`), `scripts/route-guard-policy.mjs`, `scripts/sql-safety-policy.mjs`, `scripts/error-cause-policy.mjs`, `scripts/polling-policy.mjs`, `mikka-hosted-ui/scripts/frontend-best-practices-policy.mjs` |
| **4. Automated Verification & Visual Gates** | Prove behavior with isolated tests, real rendered layouts, pixel diffs, and bundle budgets | [`docs/dev-workflow.md`](../dev-workflow.md), [`docs/acceptance.md`](../acceptance.md) | `Mikka`, `mikka-hosted-ui` | `.github/workflows/ui-policy.yml`, `.github/workflows/app-icon.yml`, `mikka-hosted-ui/.github/workflows/ui-policy.yml`, `mikka-hosted-ui/.github/workflows/pairs-with-public-main.yml`, `mikka-hosted-ui/scripts/bundle-budget.mjs` |
| **5. Progressive Release & Promotion** | Build immutable artifacts once, qualify in staging, and promote fail-closed | [`docs/operations/build-source-of-truth.md`](../operations/build-source-of-truth.md), [`docs/production-smoke.md`](../production-smoke.md) | `Mikka`, `mikka-cloud` | `.github/workflows/cloudflare-api-image.yml`, `.github/workflows/cloudflare-app-deploy.yml`, `mikka-cloud/scripts/verify-hosted-ui-gates.mjs`, `mikka-cloud/operations/primitives/rollout-probe.mjs`, `scripts/ops/production-smoke.mjs` |
| **6. Observability & Blameless COE** | Detect failures without silent gaps and convert every incident into a permanent Stage 1–5 gate | [`templates/coe-postmortem.md`](templates/coe-postmortem.md), [`docs/operations/tracing.md`](../operations/tracing.md) | `Mikka`, `mikka-hosted-ui`, `mikka-cloud` | `lib/tracing/sanitize.ts`, `mikka-hosted-ui/components/mikka/observability/`, `mikka-cloud/cloudflare/ops-scheduler/`, `mikka-cloud/operations/primitives/deep-health.mjs`, `mikka-cloud/.github/workflows/zero-residency-guard.yml` |

---

## Three-tier documentation architecture

Mikka separates active policy, historical provenance, and executable enforcement into three tiers so contributors never confuse an old snapshot with a live rule.

### Tier 1: Living standards and active specifications

Tier 1 documents are the **sole active prose authority**. Update the owning Tier 1 document in the same pull request that changes a product rule, primitive, or release workflow:

- **SDLC & engineering process:** `docs/engineering/HANDBOOK.md` (this document) and [`docs/dev-workflow.md`](../dev-workflow.md).
- **Agent context routers:** [`AGENTS.md`](../../AGENTS.md), `mikka-hosted-ui/AGENTS.md`, and `mikka-cloud/AGENTS.md`.
- **Product & visual standards:** [`docs/design/design-system.md`](../design/design-system.md), [`docs/design/glossary.md`](../design/glossary.md), [`docs/design/rules.md`](../design/rules.md), [`docs/design/components.md`](../design/components.md), [`docs/design/copy.md`](../design/copy.md), and [`docs/design/brand.md`](../design/brand.md).
- **Executable architecture & truth standards:** [`docs/architecture/primitives.md`](../architecture/primitives.md) and [`docs/architecture/five-tier-truth.md`](../architecture/five-tier-truth.md).
- **Build & release ownership:** [`docs/operations/build-source-of-truth.md`](../operations/build-source-of-truth.md) and [`docs/operations/tracing.md`](../operations/tracing.md).

Keep one source of truth per topic. Link to the owning Tier 1 document rather than restating its rules in a second file.

### Tier 2: Dated architecture decision records (`docs/design/decisions/`)

Every file in [`docs/design/decisions/`](../design/decisions/README.md) records **why** a decision was made on a specific date. Historical ADRs remain immutable provenance:

1. **Preserve history:** Never delete historical ADRs from `docs/design/decisions/` and never modify the frozen pre-2026-11-01 archive in [`docs/design/decisions.md`](../design/decisions.md).
2. **Require an explicit status header:** Every `docs/design/decisions/20*.md` file carries a top-level status header within its first 15 lines:
   - `- **Status:** Accepted`
   - `- **Status:** Superseded by [<successor>](<successor>.md)`
   - `- **Status:** Superseded in part by [<successor>](<successor>.md)`
3. **Update both directions when superseding:** When a later decision replaces an earlier ADR, add the replacement ADR, update the earlier ADR's `Status:` header to link to its successor, and update the affected Tier 1 document in the same pull request.

### Tier 3: Rule-as-code automated gates

Durable engineering rules live in TypeScript contracts and automated CI policy scripts so violations fail closed before merge. When prose and an executable gate disagree, update the stale side in the same pull request rather than bypassing the check.

### Authority precedence

When two sources conflict, the higher row wins:

1. **Alex's latest explicit approved decision**, reflected in Tier 1 documents and current code.
2. **Tier 3 executable primitives and CI policy gates** (compile-time types, static AST policies, layout/visual invariants, release preflight verifiers).
3. **Tier 1 Living Standards** (`HANDBOOK.md`, `design-system.md`, `glossary.md`, `rules.md`, `build-source-of-truth.md`).
4. **Verified current `main` implementation.**
5. **Tier 2 dated ADRs** (`docs/design/decisions/` — historical provenance only; a dated ADR never overrides a later Tier 1 standard or Tier 3 gate).

---

## Stage 1: Product and UI specification

Define what the user accomplishes, which visual standard governs the surface, and every edge state before writing UI or cross-cutting feature code.

### Mandatory specification inputs

1. **Choose the template:**
   - Copy [`docs/engineering/templates/ui-spec.md`](templates/ui-spec.md) for any Web, Desktop, or iOS UI change.
   - Copy [`docs/engineering/templates/design-doc.md`](templates/design-doc.md) for backend architecture, protocol, database schema, security, or release changes.
   - Use [`docs/design/spec-template.md`](../design/spec-template.md) for design-only Figma specifications.
2. **Pin a mandatory visual reference before coding UI:** Name either an accepted Figma frame (`zPe5LKycb2XuT1ivCLRw07`, or `12Yn4bNPchBdDvdIb83KER` for brand mark and app icons) or the governing reference product from [`docs/design/design-system.md`](../design/design-system.md):
   - **ChatGPT / Codex + Claude Code:** chat chrome, transcript typography, composer, inline single-CTA status/quota strips, and flat quiet errors.
   - **Capy (`0.9.2`):** right rail, flat single-level tab bar, sidebar work tree, list pages (Pull Requests, Threads, Tasks), and task detail panel.
   - **Linear:** issue and board semantics not covered above.
   - **Apple Human Interface Guidelines (iOS 26/27 & macOS 26):** native mobile (`mikka-hosted-ui/mobile-next/`) and Desktop window chrome.
   - **Top products over paid blocks (R-90):** each surface matches its top-product reference (ChatGPT / Codex, Claude / Claude Code, Capy, Linear); BoardUI Pro, affectUI, and beUI Pro are raw material edited in place in `mikka-hosted-ui`, and the UI PR cites the reference per surface ([2026-11-27-1409](../design/decisions/2026-11-27-1409-top-products-over-paid-blocks.md)).
3. **Specify all seven interaction states (`design-system.md` §4):** Loading (shape-matched skeleton), Empty (first-use vs. zero-match search with Clear), Error & Recovery (inline recovery preserving user drafts; status re-check for unknown effectful mutations), Pending & double-submit lock, Dirty & destructive guard (dirty forms, one-time secrets, R-102 confirm), Keyboard/Focus/IME/Esc isolation, and Touch/Hover (`@media (hover: hover)`, `>= 44×44px` coarse hit target, `320px` reflow).
4. **Enforce copy density and domain terminology:** Follow R-40 (delete every string whose removal leaves the screen unchanged), [`docs/design/copy.md`](../design/copy.md) (`C-01`..`C-10`), and [`docs/design/glossary.md`](../design/glossary.md). Chinese UI uses `线程` (never `对话` except `对话框`, never `会话`), `群聊`, `Bot`, `Agent`, `Mikka Cloud`, and `daemon`.
5. **Trace action coverage both ways:** For business actions, verify `command × permission × business transition × promised UI entry` with `.claude/skills/mikka-action-coverage/SKILL.md` and [`docs/review-checklist.md`](../review-checklist.md).

### Stage 1 exit criteria

- Reference Figma frame or reference product screen named explicitly.
- Desktop, Mobile, Light, Dark, and all seven interaction states specified.
- Zero unresolved severity 3–4 usability gaps on the user task walkthrough (`docs/review-checklist.md`).

---

## Stage 2: Architecture and contracts

Build inside Mikka's Pit-of-Success primitives so recurring security, SQL, protocol, and UI bugs are impossible by construction rather than caught only in review.

### Repository ownership boundaries

| Repository | Owns | Forbidden content | Guard |
| --- | --- | --- | --- |
| `aspectly-labs/Mikka` (public) | Node API (`apps/api`), Eve, Task runtime, `drizzle/` migrations, `@mikka/protocol`, CLI, `packages/daemon`, public build & CI orchestration | Web/Desktop/Mobile `.tsx`, CSS, fonts, `components/`, `hooks/`, legacy 1.x mobile client tree, `@ui-slot/` imports, paid UI source, private cloud issuers/credentials | `scripts/no-public-ui.test.mjs`, `scripts/cloud-boundary-policy.mjs` |
| `aspectly-labs/mikka-hosted-ui` (private) | Official Web/Desktop UI (`core/`, `web/`, `slots/`, `styles/palette.css`, `components/mikka/`), `mobile-next/`, living `/preview/design-system` gallery | Backend API routes, database migrations, production secrets, preview bundles leaking into official builds | `mikka-hosted-ui/scripts/public-build-ownership.test.mjs`, `mikka-hosted-ui/scripts/official-build-excludes-preview.test.mjs` |
| `aspectly-labs/mikka-cloud` (private) | Deployment policy, secret delivery (Infisical OIDC), staging/production promotion, rollback, runtime monitors, ops scheduler | Product application source | `mikka-cloud/scripts/verify-hosted-ui-gates.mjs`, `scripts/ci/private-runner-placement.mjs` |

### Seven-layer backend and cross-repo primitive architecture

Every recurring defect class maps to one executable primitive layer (full path map in [`docs/architecture/primitives.md`](../architecture/primitives.md)):

1. **Design System v2 & restricted UI primitives:** `docs/design/design-system.md`, `mikka-hosted-ui/styles/palette.css`, `ChatStatusStrip`, `TakeoverCard`, `AlertRow`, `WhyDisabled`, and `mikka-hosted-ui/components/mikka/list-page/` (`CapyListPage`).
2. **Unified error and quota recovery:** `lib/primitives/error-contract.ts` (`MikkaErrorContract`) normalizes refusals, quota/rate limits, model unavailability, auth/Turnstile errors, and run failures with at most one typed `primaryAction` CTA and zero stack or secret leakage.
3. **Unified API route guards:** `lib/primitives/define-route.ts` (`defineRoute(spec, handler)`) requires explicit `auth`, `origin` (including native `mikka://` mobile clients), `workspace`, and `write` declarations, maps `WorkspaceError` to canonical `403`/`409` JSON (never unhandled `500`), and enforces PAT `tokenWorkspace` fencing.
4. **Unified conversation, thread, and subagent protocol:** `lib/primitives/conversation-protocol.ts` normalizes `bot:`, `group:`, `thread:`, and `subagent:` IDs, shells, turns, and cursors across backend, Web, and iOS, enforcing `readOnly: true` and `canReply: false` on subagent shells at compile time.
5. **Safe SQL and JSONB projections:** `lib/primitives/jsonb-predicates.ts` provides typed Drizzle JSONB helpers (`jsonbFlagIsTrue`, `jsonbFlagIsNotTrue`, `jsonbUnsetOrFalse`, `jsonbText`, `jsonbSafeInt`, `jsonbSafeUuid`) so queries never throw PostgreSQL `500` errors on unguarded `->>'...'::boolean` or scalar casts.
6. **Ops release, probe, registry, and deep health:** `mikka-cloud/operations/primitives/{rollout-probe,world-release-registry,deep-health}.mjs` govern deployment convergence, Cloudflare container-cap pruning, and composite readiness checks.
7. **Rule-as-code verification:** `scripts/engineering-handbook.test.mjs` and `scripts/rule-as-code-audit.mjs` verify that active architecture maps, ADR status headers, frozen snapshots, and documentation links stay aligned with code on disk.

### Frontend one-version rule and zero patch-on-patch

- **One shared primitive per surface grammar:** Reuse `CapyListPage` (`mikka-hosted-ui/components/mikka/list-page/`) for Pull Requests, Threads, and Tasks directories, `ChatBottomSlotProvider` + `ChatStatusStrip` + `TakeoverCard` for chat overlays, and `@hosted/core/components/icons` for Mikka UI icons. Do not build per-page toolbars or import duplicate icon/primitive libraries (`@remixicon/react`, `react-aria-components`, raw `lucide-react` outside task status glyphs).
- **Replace, never stack patches:** Never stack a second CSS override layer or `z-`/`zz-` patch on top of an existing paid-block override (`mikka-hosted-ui/patches/*.patch`). Either consolidate into one authoritative rule or extract Mikka-owned chrome into `mikka-hosted-ui/components/mikka/` through a single minimal structural render-slot prop. Per-target patch counts may only decrease, never increase.
- **Decouple UI view models from dispatch projections:** Project full user-owned catalogues (models, credentials, tasks) directly rather than inferring UI rows or sort order from filtered backend scheduling candidates ([2026-11-22-2205](../design/decisions/2026-11-22-2205-headless-public-engine-and-ui-decoupling.md)).

### Breaking contracts and database migrations

- **Three-step breaking API changes (`packages/protocol/src/version.ts`):**
  1. Ship readers accepting both old and new shapes and sending the next `HOSTED_API_VERSION`; retain old keys on servers and add an immutable old-caller regression test.
  2. Release all four installed clients (Desktop, iOS, CLI, and daemon) from that reader commit or a descendant and record each client's immutable release receipt.
  3. Remove the old shape and raise `HOSTED_API_FLOOR` in a later PR so older clients receive HTTP `426` `update_required` while `/api/version` stays readable.
- **Expand-backfill-contract migrations:** Generate timestamps with `pnpm migration:new MIGRATION_NAME` under `drizzle/` (`YYYYMMDDHHMMSS_<name>.sql`), add tables/columns and compatible code first, backfill, and contract in a separate later PR with a reviewed `-- migrate: contract #<issue> <evidence>` header (`scripts/check-migrations.mjs`). Executed SQL files are immutable forever.

### Stage 2 exit criteria

- Non-trivial architecture, protocol, security, or schema changes carry a reviewed design doc (`templates/design-doc.md`).
- Every new route uses `defineRoute`, every new JSONB query uses `jsonb-predicates.ts`, and every new user error maps through `MikkaErrorContract`.
- Rollback behavior and backward compatibility with the last serving release are documented explicitly.

---

## Stage 3: Coding standards and static analysis

Enforce quality mechanically on every pull request so defects never depend on reviewer memory.

### Local-first development discipline

- Develop, build, typecheck, and run isolated PostgreSQL 17 / API / daemon tests inside cloud Linux (`pnpm local:plan`, `pnpm local:check --test=SCRIPT`, `pnpm local:ready`).
- **Do not run dev servers, databases, `pnpm build`, or `pnpm typecheck` on the developer's Mac.** Small source-only `node --test` unit and policy checks may run locally without a server.
- Keep shell commands non-interactive (`-y`, `--force`, `DEBIAN_FRONTEND=noninteractive`). Never commit or print secret values in terminal logs, screenshots, or PR bodies.

### Static analysis and ratcheted policy gates

The following gates run in CI (`source-checks` in `.github/workflows/ui-policy.yml` and `mikka-hosted-ui/.github/workflows/ui-policy.yml`):

| Category | Gate / script | Rule enforced |
| --- | --- | --- |
| **Lint & types** | `pnpm lint:code` (`oxlint`), `pnpm typecheck`, `pnpm --filter @mikka/protocol typecheck`, `mikka-hosted-ui` `oxlint` (`react`, `react-hooks`, `jsx-a11y`, `typescript`) | Zero lint warnings/errors and strict TypeScript checking across backend, protocol, and hosted UI |
| **API route security ratchet** | `pnpm check:route-guard` (`scripts/route-guard-policy.mjs` + `scripts/route-guard-baseline.json`) and `node apps/api/scripts/generate-routes.mjs --check` | Blocks any new unguarded `app/api/**/route.ts`, ratchets legacy ceiling strictly downward (fail-closed on shallow PR checkouts), and enforces the **diff-aware Boy Scout rule** (`--base <ref>` + automatic CI PR/merge-group diff check: modifying any legacy unguarded route fails CI unless migrated to `defineRoute` or documented in `exemptRoutes`) |
| **SQL & JSONB safety** | `pnpm check:sql-safety` (`scripts/sql-safety-policy.mjs`) | Blocks unguarded JSONB type casts (`->>'...'::boolean`, `::int`, `::uuid`, `::numeric`, `::double precision`) across source |
| **Error causes & polling** | `scripts/error-cause-policy.mjs`, `scripts/polling-policy.mjs`, `scripts/focus-refetch-policy.mjs`, `tests/idle-request-budget.json` | Preserves `{ cause: error }` and localized `RunErrors.*`; bans new polling loops (`refreshInterval`, `setInterval`) in favor of `lib/live/*` push; idle page request ceilings in `tests/idle-request-budget.json` only decrease (`#1212`) |
| **Execution & cloud boundaries** | `pnpm check:cloud-boundary` (`scripts/cloud-boundary-policy.mjs`), `scripts/litellm-policy.mjs`, `scripts/external-client-mock-policy.mjs`, `scripts/check-migrations.mjs`, `scripts/no-public-ui.test.mjs` | Keeps private cloud code out of public `Mikka`, enforces LiteLLM-only managed model egress, forbids unreviewed `DROP COLUMN`, and keeps Web/Desktop UI out of public `Mikka` |
| **UI, copy & paid-block ratchets** | `pnpm lint:ui` (`scripts/ui-policy.mjs`, `scripts/interaction-policy.mjs`, `scripts/control-size-policy.mjs`, `scripts/motion-policy.mjs`, `scripts/split-pane-policy.mjs`, `scripts/icon-button-policy.mjs`, `scripts/navigation-policy.mjs`, `scripts/copy-policy.mjs`), `pnpm i18n:check`, `node scripts/check-copy.mjs`, `mikka-hosted-ui/scripts/paid-sources.mjs`, `mikka-hosted-ui/scripts/frontend-best-practices-policy.mjs` | Enforces Design System v2 tokens, control heights, motion tokens, copy/i18n rules, zero stale paid patches, per-file patch-count ceiling, and bans `transform`+`translate` double-shift, scrollWidth-inflating negative tab insets, `absolute` + `pointer-coarse:opacity-100` row-icon overlays, raw hex colors, and duplicate icon/UI imports |
| **Anti-hardcoding & five-tier truth** | `pnpm test:anti-hardcoding`, `pnpm check:config-contracts`, `pnpm lint:semantic`, `scripts/oxlint-plugin-mikka.mjs`, `scripts/config-contract-sync.mjs`, `scripts/semantic-lint/index.mjs`, `mikka-hosted-ui/scripts/oxlint-plugin-mikka-ui.mjs` | Enforces the [Five-Tier Truth Model](../architecture/five-tier-truth.md) (T1–T5) at zero baselines: bans raw `process.env`, plan-name branching, hardcoded model IDs, hardcoded loopback/internal hosts, business literals in `messages/*.json` (`pnpm i18n:check`), full-repository semantic AST anti-patterns, and drift between runtime-config/capability schemas and [configuration contracts](../operations/config-contracts.md) |
| **Handbook & ADR integrity** | `pnpm check:handbook` (`scripts/engineering-handbook.test.mjs`), `pnpm check:rule-as-code` (`scripts/rule-as-code-audit.mjs`) | Verifies every ADR in `docs/design/decisions/20*.md` carries a valid `Status:` header, `docs/design/decisions.md` stays frozen, and every local path, link, and `pnpm` script referenced by `HANDBOOK.md` and `primitives.md` exists |

### Review risk triage

For every actionable review finding, estimate real-world `occurrence (1–10) × impact (1–10)` with a concrete failure path:

- **Product `< 5`:** File or deduplicate an issue and avoid speculative rewrite churn.
- **Hard override:** Never use the score to defer credible security, authorization, tenant isolation, privacy, credential exposure, data loss, or irreversible external side-effect risks.

---

## Stage 4: Automated verification and visual gates

CI is the independent final merge gate, not the first debugging loop. Draft PRs run required aggregators that **fail closed** (`#2997`); marking a PR Ready for review activates full affected checks, and the GitHub Merge Queue (`merge_group`) verifies the exact combined candidate before merge.

### Layered backend and daemon verification (`aspectly-labs/Mikka`)

1. **Selected unit, integration, and daemon suites:** Nx Core selection (`scripts/ci/select.mjs`) runs affected `Core unit checks`, `Integration unit checks`, `Source checks`, and `Daemon checks` on Node 24, with conservative full fallback on global, security, or unknown inputs (`docs/ci/incremental.md`).
2. **Isolated PostgreSQL 17 database shards:** `Database checks` runs across isolated PG17 shards with empty-database migration replay (`tests/migrate-empty-db.test.mjs`), `workspace-governance-checks`, and `analytics-checks` — zero skipped suites permitted (`REQUIRE_DB=1`).
3. **Scripted model acceptance (never live inference):** Development acceptance, CI, and local-loop jobs substitute only the LiteLLM HTTP boundary with scripted or recorded responses covering streaming, tool calls, timeouts, `429`, upstream `5xx`, and usage/cost receipts ([2026-11-20-1855](../design/decisions/2026-11-20-1855-scripted-model-acceptance.md)).

### Frontend verification, local visual review, and Electron e2e CI (`aspectly-labs/mikka-hosted-ui`)

Per [2026-11-27-1100-electron-e2e-ci-no-pixel-diff.md](../design/decisions/2026-11-27-1100-electron-e2e-ci-no-pixel-diff.md) (superseding 2026-11-26-0645), hosted-UI CI runs end-to-end tests in Electron with DOM and behaviour assertions only, never screenshots or pixel comparison, and visual review stays local in cloud Linux against a real compiled build:

1. **Zero known test failures:** `mikka-hosted-ui/scripts/known-test-failures.json` stays ratcheted at `0`. Phase 1 on every Ready PR and `main` push (`mikka-hosted-ui/scripts/cloudflare-ci.mjs`, the same stage list in Workers Builds and the `mikka-hosted-ui-ci` container) runs all non-browser hosted tests, `paid-sources` (paid-source list and patch ledger), `oxlint`, `frontend-best-practices-policy` and `pr-visual-evidence-check`, reported as `Cloudflare UI Policy` and `Cloudflare UI Fast Gate` (Draft PRs launch zero CI containers). Running this repository's official-UI tests there with `MIKKA_REQUIRE_OFFICIAL_UI=1` (a missing checkout fails instead of skipping) lands with the hosted Electron CI change; the Desktop release's route contract (`test:desktop-release-guard`) already sets it.
2. **Routed Electron e2e (lands with the hosted Electron CI change; these checks do not exist until then):** a Ready PR runs the `mikka-hosted-ui/e2e/electron/` specs that `e2e/electron/routes.json` routes its changes to (`Cloudflare Electron E2E`; `skipped` when none); `main` runs the golden smoke (`Cloudflare Desktop Golden Smoke`); the nightly runs every spec plus the DOM layout audit (`Cloudflare UI Nightly`). Only failing tests keep a trace or screenshot, in private R2.
3. **Targeted local visual verification (`mikka-hosted-ui/scripts/local-visual-verify.mjs`):** Before marking a UI PR Ready, verify changed routes locally in cloud Linux via `pnpm --dir mikka-hosted-ui visual:local --target <slug>` against the real compiled build using local Chrome/Chromium (Desktop `1440×900` & Mobile `390×844`, Light & Dark). Inspect every rendered PNG directly for layout, contrast, horizontal overflow (`scrollWidth <= innerWidth`), tab/drawer geometry, and zero console/page errors.
4. **PR `## 视觉对照` / `## Visual comparison` enforcement (a review requirement, not a CI comparison):**
   - On `Mikka`, `scripts/ci/frontend-screenshot-check.mjs` verifies that frontend PR descriptions include a screenshot/media link or an accepted opt-out reason.
   - On `mikka-hosted-ui`, `mikka-hosted-ui/scripts/pr-visual-evidence-check.mjs` enforces the `## 视觉对照` / `## Visual comparison` section naming the reference target and documenting local real-build screenshot verification.
   - The screenshot sweep and pixel diff (`mikka-hosted-ui/scripts/cloudflare-playwright-ci.mjs`, `visual-pixel-diff.mjs`) are manual local tools only.
5. **PR bundle size budget (`mikka-hosted-ui/scripts/bundle-budget.mjs`):** Runs in `Cloudflare UI Fast Gate` / `Workers Builds` after the official Web Vite build, records raw, gzip-9, and brotli-11 totals in `bundle-report.{json,md}`, and fails CI if Total JS, Total CSS, Largest JS, or Largest CSS exceeds the tight `+8%` ceiling in `mikka-hosted-ui/scripts/bundle-budget.json`.
6. **Native iOS 26/27 & macOS 26 App Icon gate (`.github/workflows/app-icon.yml`):** Compiles `apps/desktop/build/icon.icon` for both iOS and macOS with Xcode `actool` on `macos-26`, and exports all six Liquid Glass renditions (`Default`, `Dark`, `TintedLight`, `TintedDark`, `ClearLight`, `ClearDark`) with `ictool` into `app-icon-previews`.

---

## Stage 5: Progressive release and fail-closed promotion

Code merge, artifact build, staging qualification, and production promotion are distinct, auditable gates.

### Build once, promote immutable digests

- **Public-root trusted build:** Pushing to `aspectly-labs/Mikka` `main` triggers `.github/workflows/cloudflare-api-image.yml`, which checks out the exact `overlaySource` SHA pinned in `mikka-cloud/docs/operations/releases/deploy-build-inputs.json` read-only into `.hosted-ui/`, builds content-addressed artifacts for changed services (Web, API, Eve, Task, World, LiteLLM), and uploads `release-manifest.json` with migration identity `v3` ([`docs/operations/build-source-of-truth.md`](../operations/build-source-of-truth.md)).
- **Ship features on:** Finished features ship enabled in production. Feature flags exist only for per-use paid compute/model cost, live incident kill switches, or explicit decisions from Alex.

### Fail-closed hosted-UI promotion gate

Because private `aspectly-labs/mikka-hosted-ui` cannot rely solely on GitHub branch protection, `mikka-cloud/scripts/verify-hosted-ui-gates.mjs` enforces fail-closed admission on every overlay sync (`mikka-cloud/.github/workflows/overlay-source-sync.yml`) and before every staging or production deployment (`mikka-cloud/operations/business-api/pipeline-preflight.mjs`):

1. `Cloudflare UI Policy` (browser-free static UI policy, `paid-sources`, `oxlint`, `frontend-policy`, and non-browser hosted unit tests; or legacy `ui-policy.yml`) reached `completed` + `success` on `main` for the exact `overlaySource` SHA (never exemptible).
2. `Cloudflare UI Fast Gate` / `Workers Builds` (official Web Vite build + `bundle-budget`; or legacy `pairs-with-public-main.yml`) reached `completed` + `success` on `main` for that exact SHA (exemptible only with an explicit audited break-glass reason).
3. Remote CI screenshot archives (`ui-visual-evidence`) are not required for routine promotion; visual verification happens locally in cloud Linux before merge (operators may still opt in to strict artifact checks via `--require-visual-artifact` after a manual audit).

### Staging qualification, production cutover, and mobile releases

1. **Staging zero-human smoke:** `mikka-cloud` stages changed services only, confirms container convergence with `mikka-cloud/operations/primitives/rollout-probe.mjs`, prunes unreferenced revisions under the Cloudflare container ceiling (`mikka-cloud/operations/primitives/world-release-registry.mjs`, alerting at 80% capacity), checks `/health` + `/jwks.json` + serving revision (`mikka-cloud/operations/primitives/deep-health.mjs`), and runs `mikka-cloud/operations/business-api/staging-smoke-fixture.mjs`.
2. **Production promotion & database window:** The release owner controls Cloudflare promotion and `production-migrate-database` windows through `#1954`. Never bypass migration admission checks.
3. **Post-deploy smoke & external-only acceptance:** Every production Web deploy runs `scripts/ops/production-smoke.mjs` (sign-in, shell, capability reads), and `.github/workflows/cloud-run-canary.yml` runs a scheduled real cloud run canary four times daily (`docs/production-smoke.md`). External-only integrations (OAuth, subscriptions, model providers, GitHub App, payments, push notifications) are verified in production using the shared smoke account (`docs/acceptance.md`).
4. **iOS TestFlight & OTA releases:** Native builds run `.github/workflows/mobile-next-ios.yml` using the single persistent Apple Distribution certificate stored in Infisical OIDC (`prod:/platform`); runners never create new certificates. JS-only mobile updates run `.github/workflows/mobile-next-update.yml` and record the update group ID.

### Rollback policy

- **Restore code/artifacts, never delete data:** Roll back by re-promoting the previous immutable `release-manifest.json` / image digests through `mikka-cloud`, and revert or fix forward in Git through a normal PR.
- **Forbidden manual mutations:** Never delete deployments, revoke shared tokens, modify production Neon settings, or create paid cloud resources without explicit approval from Alex.

---

## Stage 6: Observability and blameless Correction of Errors (COE)

Production systems fail visibly, preserve privacy, and feed every failure back into Stages 1–5 as an automated guard.

### Observability stack and privacy invariants

| Signal layer | Implementation | Contract & privacy boundary |
| --- | --- | --- |
| **Backend APM, DB, daemon & AI tracing** | PostHog OpenTelemetry (`docs/operations/tracing.md`, `apps/api/runtime/request-trace.ts`, `packages/daemon/src/tracing.ts`, `lib/tracing/ai.ts`) | One W3C `traceparent` + bounded opaque carrier (`mikka.run_id`, `mikka.thread_id`, `mikka.task_id`, `mikka.workflow_run_id`) end to end. Allowlist enforced in `lib/tracing/sanitize.ts`: zero SQL literals, zero prompt/output text, zero emails/IPs/secrets; errors export class + code only |
| **Frontend RUM & global error boundaries** | `mikka-hosted-ui/components/mikka/observability/` (`AppErrorBoundary`, `SectionErrorBoundary`, Core Web Vitals `LCP`/`CLS`/`INP`/`FCP`/`TTFB` collector) | Prevents white-screen crashes with localized `Retry`/`Reload` recovery; flushes sanitized metrics strictly on `visibilitychange === 'hidden'` / `pagehide` or route transition (zero idle polling under `#1212`, zero query strings or PII) |
| **Structured logs & ops monitor** | `lib/request-log.ts`, `app/api/cron/ops-monitor` (`ops_monitor_observations`) | Tracks API success, dispatch start, due work, wake backlog, expired worker leases, uncertain provider receipts, secret cleanup, and DB health; 503 on collector failure so dead monitors surface |
| **Out-of-band cloud guardrails** | `mikka-cloud/cloudflare/ops-scheduler/`, `mikka-cloud/operations/primitives/deep-health.mjs`, `mikka-cloud/operations/runtime-monitor/zero-residency-guard.mjs` → Datadog US5 (`us5.datadoghq.com`) | Continuous external health probing, container-capacity warnings (80% cap), and Cloudflare/Oracle residency metrics routed to approved alert webhooks |

### Blameless Correction of Errors (5-Whys COE loop)

Write a COE from [`docs/engineering/templates/coe-postmortem.md`](templates/coe-postmortem.md) after every production outage, security or tenant-isolation defect, broken release, or recurring user-reported regression:

1. **Blameless systems analysis:** Focus strictly on missing primitives, ambiguous specs, blind tests, or leaky release gates. "Someone forgot to check X" is never a root cause.
2. **Five Whys to the structural root:** Ask *Why?* iteratively until you reach a systemic cause that a computer can enforce automatically.
3. **Mandatory mechanical close-out:** A COE is incomplete until at least one permanent **Stage 1–5 mechanical guard** (a compile-time primitive, static AST policy rule, layout invariant, pixel-diff route, or fail-closed release check) is merged and proven red→green on the exact failure mode.
4. **Close the documentation loop:** If the incident revealed a stale Tier 1 rule or an undocumented supersession, update the Tier 1 document and affected Tier 2 ADR `Status:` header in the same pull request.
