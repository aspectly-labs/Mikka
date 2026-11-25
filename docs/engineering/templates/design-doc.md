# Design Doc: <TITLE>

- **Status:** Draft | In Review | Accepted | Superseded by `<link>`
- **Owner:** `<engineer or agent>`
- **Tracking issue:** `#<number>`
- **Target repositories:** `aspectly-labs/Mikka` | `aspectly-labs/mikka-hosted-ui` | `aspectly-labs/mikka-cloud`
- **Related ADRs / specs:** `<relative links or none>`

Delete sections that do not apply only with a one-line reason; never leave placeholders unfilled.

## 1. Problem and non-goals

State the user or system failure mode in 2–4 concrete sentences.

**Non-goals:**
- `<explicitly excluded scope so contributors do not expand the design>`

## 2. Current state and failure modes

Describe the owning reader, owning writer, existing entry points, and exact code paths that fail or lack a contract today. Cite file paths and issue/trace evidence.

## 3. Proposed architecture and contracts

- **Pit-of-Success primitive reuse:** Name the existing layer(s) in `docs/architecture/primitives.md` this design builds on (`defineRoute`, `MikkaErrorContract`, `conversation-protocol`, `jsonb-predicates`, `CapyListPage`, `ChatBottomSlotProvider`, ops primitives). Justify any new primitive.
- **Data flow and ownership:** Define the single authorized reader and writer per operation. Include a concise diagram or interface signature when introducing a new contract.
- **API / protocol / schema contract:** Specify request/response shapes, error codes (`MikkaErrorContract`), idempotency keys, and bounds/pagination limits.

## 4. Security, tenant isolation, and privacy

- **Route guard matrix (`defineRoute`):** For each new or modified endpoint, specify `auth`, `origin`, `workspace`, and `write`.
- **Tenant & PAT boundary:** Confirm workspace scoping, personal vs. team isolation, and PAT `tokenWorkspace` fencing.
- **Secret & telemetry hygiene:** Confirm secrets stay in Infisical/KMS (never committed, logged, or exposed to unreadable scopes) and any new OpenTelemetry attribute is added to `lib/tracing/sanitize.ts` + its privacy test.

## 5. Compatibility, migrations, and rollback

- **Client/service compatibility:** If changing a hosted API or internal API↔Eve↔Task↔World contract, specify all three rollout steps (`HOSTED_API_VERSION` / `HOSTED_API_FLOOR`, immutable old-caller fixture).
- **Database migrations:** Follow expand-backfill-contract using `pnpm migration:new`. Confirm zero unreviewed `DROP COLUMN` statements and forward-only rollback safety.
- **Rollback procedure:** State the exact reversible action (previous immutable artifact digest / revert PR) and any external side effects that cannot be undone automatically.

## 6. Verification plan

List the exact deterministic checks proving the design before and after merge:

- **Unit & static policy checks:** `<commands>`
- **Isolated PostgreSQL 17 DB / HTTP / scripted model fixtures:** `<commands>`
- **Visual / layout / bundle gates (if UI touched):** `<commands or N/A>`
- **Staging & external-only production checks:** `<checks or Not needed: reason>`

## 7. Alternatives considered

| Option | Trade-offs | Why rejected |
| --- | --- | --- |
| `<Option A>` | `<cost / complexity / risk>` | `<concrete reason>` |

## 8. Rollout, observability, and kill switch

- **Default state:** Ships enabled in production (per `HANDBOOK.md` Stage 5), unless an approved cost/incident flag applies.
- **Telemetry & alerts:** Spans, structured logs, or ops-monitor signals that confirm healthy operation and detect regressions.
- **Kill switch (only if justified by paid cost or incident blast radius):** `<env var / switch and removal trigger, or None>`
