# Correction of Errors (COE): <INCIDENT_TITLE>

- **Incident / Issue:** `#<number>`
- **Date & UTC window:** `YYYY-MM-DD HH:MM–HH:MM UTC`
- **Severity:** `SEV-1` (outage / data loss / security) | `SEV-2` (degraded core flow / broken release) | `SEV-3` (recurring post-merge user defect)
- **Owner:** `<engineer or agent>`
- **Affected surfaces / repositories:** `Mikka` | `mikka-hosted-ui` | `mikka-cloud` (`<exact services/routes>`)
- **Status:** Draft | Reviewed | Guards Shipped

This postmortem is **blameless**. Focus strictly on missing primitives, contracts, tests, and release gates — never on individual mistakes. Never include secrets, credentials, or user PII.

## 1. Customer and system impact

- **User-visible symptom:** `<exact broken workflow or error seen by users>`
- **Scope & blast radius:** `<affected platforms (Web/Desktop/iOS), routes, tenants, or build SHAs>`
- **Duration:** `<total time from trigger to mitigation and full recovery>`
- **Detection latency & source:** `<time to detect; alert, canary, smoke, or user report>`
- **Data or external side-effect impact:** `<none, or exact verified scope and reconciliation status>`

## 2. Timeline (UTC)

Record observable events with exact timestamps, SHAs, and run/trace IDs:

| Time (UTC) | Event | Evidence (SHA / run ID / trace ID) |
| --- | --- | --- |
| `HH:MM` | Triggering change merged or external condition began | `<SHA / PR / run>` |
| `HH:MM` | First observable failure or alert fired | `<trace / log / report>` |
| `HH:MM` | Mitigation or rollback executed | `<release manifest / revert PR>` |
| `HH:MM` | Recovery verified across smoke and live telemetry | `<smoke run / metric>` |

## 3. Detection and response review

- **What worked well:** `<fast rollback, trace correlation, or clear error contract>`
- **What lagged or stayed blind:** `<missing alert, browser engine gap, or unverified private repo merge>`

## 4. Five Whys root cause analysis

Stop only when you reach a **systemic absence of a primitive, contract, or automated gate**. "Developer forgot to check X" is invalid — ask *Why was it possible to ship without X?*

1. **Why did the user-visible failure occur?** `<direct technical cause>`
2. **Why did that defect reach the runtime?** `<missing compile-time contract, policy, or test>`
3. **Why did CI and review not block it?** `<gap in Stage 3 static gate or Stage 4 visual/E2E coverage>`
4. **Why did staging and release promotion not stop it?** `<gap in Stage 5 preflight/smoke or cross-repo gate>`
5. **Why did our engineering system allow that class of failure?** `<root structural cause>`

## 5. Stage 1–6 gap classification

Check every stage where the failure slipped through:

- [ ] **Stage 1 (Spec):** Missing visual target, state contract, or copy/terminology requirement
- [ ] **Stage 2 (Architecture):** Missing Pit-of-Success primitive or stacked patch-on-patch override
- [ ] **Stage 3 (Static Analysis):** Missing lint, AST policy, or ratcheted baseline check
- [ ] **Stage 4 (Verification & Visual):** Missing Chromium/WebKit layout invariant, pixel diff, or isolated DB/fixture test
- [ ] **Stage 5 (Release & Promotion):** Missing fail-closed promotion gate, staging smoke, or migration check
- [ ] **Stage 6 (Observability):** Silent failure, missing alert, or blind telemetry path

## 6. Mandatory permanent mechanical guards

**Closure rule:** Every COE must ship at least one permanent **Stage 1–5 mechanical guard** in code or CI that fails red on the exact failure class. "Be more careful" is not an action item.

| # | Permanent mechanical guard | Target stage (1–5) | Repository & exact file / CI gate | Owner | Tracking issue / PR SHA | Verified red→green? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `<compile-time primitive / AST policy / layout invariant / release gate>` | `Stage <N>` | `<repo/path>` | `<owner>` | `#<issue> / <SHA>` | `[ ] Yes` |

## 7. Immediate remediation and cleanup

List short-term fixes (hotfix PR, data reconciliation, documentation/ADR status update) separately from permanent guards:

| Action | Repository / doc | Owner | PR / issue | Status |
| --- | --- | --- | --- | --- |
| `<hotfix or Tier 1/Tier 2 doc update>` | `<path>` | `<owner>` | `#<id>` | `Open / Done` |

## 8. Closure verification

- [ ] Every permanent mechanical guard in §6 is merged to `main` and verified failing on the pre-fix reproduction and passing on the fix.
- [ ] Tier 1 Living Standards (`docs/engineering/HANDBOOK.md`, `mikka-hosted-ui/docs/design/design-system.md`, `docs/architecture/primitives.md`) and any superseded Tier 2 ADR `Status:` headers are updated.
- [ ] Zero secrets, credentials, or user PII appear anywhere in this document.
