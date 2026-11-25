# Architecture decision records (`docs/design/decisions/`)

**Tier 2 — Immutable historical provenance** under Mikka's [Three-Tier Documentation Architecture](../../engineering/HANDBOOK.md#three-tier-documentation-architecture).

**Current behavior comes from Tier 1 Living Standards ([`HANDBOOK.md`](../../engineering/HANDBOOK.md), [`AGENTS.md`](../../../AGENTS.md), [`design-system.md`](../design-system.md), [`rules.md`](../rules.md), [`build-source-of-truth.md`](../../operations/build-source-of-truth.md)) and Tier 3 executable CI gates.** This directory records *why* each decision was made at its date; a file's date does not make it active forever.

## Standard `Status` header convention

Every dated ADR (`20*.md`) carries a canonical status line within its first 15 lines, enforced in CI by `scripts/engineering-handbook.test.mjs`:

- `- **Status:** Accepted` — active decision (may include parenthetical context such as approval date or narrow amendment note).
- `- **Status:** Superseded by [<successor>](<successor>.md)` — completely replaced by a later ADR; read the linked successor and its owning Tier 1 standard instead.
- `- **Status:** Superseded in part by [<successor>](<successor>.md)` — specific clauses replaced by a later ADR while unaffected clauses remain valid.

## Immutability and supersession workflow

1. **Preserve historical ADRs:** Never delete dated ADRs from `docs/design/decisions/` and never modify the frozen pre-2026-11-01 log in [`../decisions.md`](../decisions.md).
2. **Update Tier 1 first:** When Alex approves a new architectural or product decision, update the owning Tier 1 Living Standard (`AGENTS.md`, `HANDBOOK.md`, `design-system.md`, `rules.md`, or `build-source-of-truth.md`) in the same pull request.
3. **Link supersessions both ways:** Create the new `YYYY-MM-DD-HHMM-slug.md` record with `- **Status:** Accepted`, and update the earlier ADR's top `Status:` header to `- **Status:** Superseded by [<new-file>](<new-file>.md)` (or `Superseded in part by`) in the same pull request.
4. **Never treat history as present-tense authority:** When a historical ADR conflicts with current Tier 1 standards or verified `main` code, follow the [authority precedence](../../engineering/HANDBOOK.md#authority-precedence) and record or fix the mismatch rather than reverting product behavior.

## Inventory summary

All `315` dated decision records carry verified `Status:` headers (`212` Accepted, `26` Superseded, `77` Superseded in part).

### Key active architectural decisions

| Area | Decision record | Status | Owning Tier 1 standard |
| --- | --- | --- | --- |
| **Brand mark & App Icon** | [2026-11-24-2235-new-mikka-ribbon-mark.md](2026-11-24-2235-new-mikka-ribbon-mark.md) | Accepted | [`docs/design/brand.md`](../brand.md) |
| **Design System v2** | [2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md](2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md) | Accepted | [`docs/design/design-system.md`](../design-system.md) |
| **All Web/Desktop UI in `mikka-hosted-ui`** | [2026-11-24-1000-all-ui-in-hosted.md](2026-11-24-1000-all-ui-in-hosted.md) | Accepted | [`AGENTS.md`](../../../AGENTS.md), [`HANDBOOK.md`](../../engineering/HANDBOOK.md) |
| **Settings structure from the benchmark (groups, 数据与隐私, no 团队权限 / 默认 Harness / run-location preference, 身份与访问)** | [2026-11-26-0100-settings-structure-from-benchmark.md](2026-11-26-0100-settings-structure-from-benchmark.md) | Accepted | [`docs/design/design-system.md`](../design-system.md) |
| **Environments hold repositories; task 「环境」; group chats are threads; notification bell, no inbox; right column 概览; subagents in the right column; mobile drawer only** | [2026-11-26-0110-pages-environments-from-benchmark.md](2026-11-26-0110-pages-environments-from-benchmark.md) | Accepted | [`docs/design/design-system.md`](../design-system.md), [`docs/design/glossary.md`](../glossary.md) |
| **One email-first 「登录或注册」 page with codes, ≤2-step onboarding + home checklist, one create dialog, no Start work, one account menu, non-blocking updates, quota notice card** | [2026-11-26-0120-auth-and-overlays-from-benchmark.md](2026-11-26-0120-auth-and-overlays-from-benchmark.md) | Accepted | [`docs/design/design-system.md`](../design-system.md) |
| **Single flat right-column tabs** (its 「no Overview」 rule superseded by 2026-11-26-0110) | [2026-11-23-2200-right-column-as-tembo.md](2026-11-23-2200-right-column-as-tembo.md) | Superseded in part | [`docs/design/design-system.md`](../design-system.md) |
| **Node 24 CI toolchain** | [2026-11-22-1430-ci-node24-only.md](2026-11-22-1430-ci-node24-only.md) | Accepted | [`docs/dev-workflow.md`](../../dev-workflow.md) |
| **Scripted model acceptance (no live inference in CI)** | [2026-11-20-1855-scripted-model-acceptance.md](2026-11-20-1855-scripted-model-acceptance.md) | Accepted | [`docs/acceptance.md`](../../acceptance.md), [`HANDBOOK.md`](../../engineering/HANDBOOK.md) |
| **Dependency-based SDLC delivery** | [2026-11-20-1640-sdlc-delivery.md](2026-11-20-1640-sdlc-delivery.md) | Accepted | [`docs/dev-workflow.md`](../../dev-workflow.md) |
| **3-step hosted API compatibility** | [2026-11-20-1300-hosted-api-compatibility.md](2026-11-20-1300-hosted-api-compatibility.md) | Accepted | [`AGENTS.md`](../../../AGENTS.md), [`HANDBOOK.md`](../../engineering/HANDBOOK.md) |
| **Mandatory LiteLLM model egress** | [2026-11-20-0530-litellm-only-model-egress.md](2026-11-20-0530-litellm-only-model-egress.md) | Accepted | [`AGENTS.md`](../../../AGENTS.md) |
| **Environment (not Project), Bot = Captain, create-only tasks** | [2026-11-19-2100-environment-not-project.md](2026-11-19-2100-environment-not-project.md), [2026-11-19-2105-bot-is-captain-no-promote.md](2026-11-19-2105-bot-is-captain-no-promote.md), [2026-11-19-2110-new-task-create-only.md](2026-11-19-2110-new-task-create-only.md) | Accepted | [`docs/design/glossary.md`](../glossary.md) |
| **One state-mark registry** | [2026-11-19-1630-one-mark-registry.md](2026-11-19-1630-one-mark-registry.md) | Accepted | [`docs/design/components.md`](../components.md) |
| **Automatic UTC migration IDs** | [2026-11-11-1151-automatic-migration-ids.md](2026-11-11-1151-automatic-migration-ids.md) | Accepted | [`docs/dev-workflow.md`](../../dev-workflow.md) |
| **Native MCP configuration & credential delivery** | [2026-11-11-0534-eve-and-native-mcp.md](2026-11-11-0534-eve-and-native-mcp.md), [2026-11-19-native-mcp-authorization.md](2026-11-19-native-mcp-authorization.md) | Accepted | [`AGENTS.md`](../../../AGENTS.md) |
| **Paid blocks themed by Mikka's tokens (R-90)** | [2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md) (supersedes [2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md)) | Accepted | [`docs/design/design-system.md`](../design-system.md) |
| **Chat follows Codex; memory deferred; views, old task frame and projects page removed** | [2026-11-25-2330-owner-decisions-chat-memory-views-projects.md](2026-11-25-2330-owner-decisions-chat-memory-views-projects.md) | Accepted | [`docs/design/design-system.md`](../design-system.md) |
| **One UI across Cloud & self-hosted** | [2026-11-08-2133-one-ui.md](2026-11-08-2133-one-ui.md) | Accepted | [`docs/operations/build-source-of-truth.md`](../../operations/build-source-of-truth.md) |
| **Execution boundary vs. task Secret exposure** | [2026-11-06-1800-machine-is-the-execution-boundary.md](2026-11-06-1800-machine-is-the-execution-boundary.md), [2026-11-08-0240-credential-exposure-boundary.md](2026-11-08-0240-credential-exposure-boundary.md) | Accepted | [`AGENTS.md`](../../../AGENTS.md) |
| **No new polling & keep error causes** | [2026-11-05-0200-no-new-polling.md](2026-11-05-0200-no-new-polling.md), [2026-11-05-0330-error-causes.md](2026-11-05-0330-error-causes.md) | Accepted | [`HANDBOOK.md`](../../engineering/HANDBOOK.md) |

### Key superseded chains

| Retired direction | Superseded ADR(s) | Active successor |
| --- | --- | --- |
| **Comma typography/look & LobeHub action-bar overrides** | [2026-11-01-1204-type-follows-comma.md](2026-11-01-1204-type-follows-comma.md), [2026-11-22-2000-chat-look-as-lobehub.md](2026-11-22-2000-chat-look-as-lobehub.md) (in part) | [2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md](2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md) |
| **5×5 dot-grid black icon artwork** | [2026-11-12-0449-browser-app-icon.md](2026-11-12-0449-browser-app-icon.md) (in part) | [2026-11-24-2235-new-mikka-ribbon-mark.md](2026-11-24-2235-new-mikka-ribbon-mark.md) |
| **Public `@ui-slot/*` overlay & public UI pages** | [2026-11-06-2000-hosted-ui-overlay.md](2026-11-06-2000-hosted-ui-overlay.md), [2026-11-19-2120-slots-for-paid-surfaces.md](2026-11-19-2120-slots-for-paid-surfaces.md), [2026-11-22-2205-headless-public-engine-and-ui-decoupling.md](2026-11-22-2205-headless-public-engine-and-ui-decoupling.md) (in part) | [2026-11-24-1000-all-ui-in-hosted.md](2026-11-24-1000-all-ui-in-hosted.md) |
| **Right-column Overview tab with nested inner tabs** | [2026-11-09-2330-overview-as-work-area-tab.md](2026-11-09-2330-overview-as-work-area-tab.md) | [2026-11-23-2200-right-column-as-tembo.md](2026-11-23-2200-right-column-as-tembo.md) (flat tabs); a flat 「概览」 tab returns in [2026-11-26-0110](2026-11-26-0110-pages-environments-from-benchmark.md) |
| **Direct provider egress & optional LiteLLM converter** | [2026-11-15-2000-one-model-gateway.md](2026-11-15-2000-one-model-gateway.md) (in part) | [2026-11-20-0530-litellm-only-model-egress.md](2026-11-20-0530-litellm-only-model-egress.md) |
| **Per-call connected-app Decision/Allow-Ask-Deny matrix** | [2026-11-01-1330-write-judgment-unavailable-goes-ahead.md](2026-11-01-1330-write-judgment-unavailable-goes-ahead.md), [2026-11-10-1730-workspace-app-permissions.md](2026-11-10-1730-workspace-app-permissions.md) (in part) | [2026-11-19-native-mcp-authorization.md](2026-11-19-native-mcp-authorization.md) |
| **Node 22 CI matrix verification** | [2026-11-18-0300-node22-everywhere.md](2026-11-18-0300-node22-everywhere.md) (in part) | [2026-11-22-1430-ci-node24-only.md](2026-11-22-1430-ci-node24-only.md) |
| **Thread bubble iconography** | [2026-11-04-2220-task-circle-thread-bubble.md](2026-11-04-2220-task-circle-thread-bubble.md) | [2026-11-19-1630-one-mark-registry.md](2026-11-19-1630-one-mark-registry.md) |
| **Right column without Overview; subagent replacing the main chat** | [2026-11-23-2200-right-column-as-tembo.md](2026-11-23-2200-right-column-as-tembo.md), [2026-11-22-1400-subagent-cards.md](2026-11-22-1400-subagent-cards.md) (in part) | [2026-11-26-0110-pages-environments-from-benchmark.md](2026-11-26-0110-pages-environments-from-benchmark.md) |
| **Board Project → repository → environment binding; group chat as its own object; 收件箱 page** | [2026-11-07-2300-work-domain-model.md](2026-11-07-2300-work-domain-model.md), [2026-11-19-2100-environment-not-project.md](2026-11-19-2100-environment-not-project.md), [2026-11-22-1510-group-chat-as-bot-chat.md](2026-11-22-1510-group-chat-as-bot-chat.md), [2026-11-13-1405-one-task-status.md](2026-11-13-1405-one-task-status.md) (in part) | [2026-11-26-0110-pages-environments-from-benchmark.md](2026-11-26-0110-pages-environments-from-benchmark.md) |
| **Four-step onboarding, send-time plan dialog, CreateWindow shell, Start work dialog, forced update gates** | [2026-11-15-1900-models-on-gateway-like-capy.md](2026-11-15-1900-models-on-gateway-like-capy.md), [2026-11-15-1111-capy-create-windows.md](2026-11-15-1111-capy-create-windows.md), [2026-11-19-2110-new-task-create-only.md](2026-11-19-2110-new-task-create-only.md), [2026-11-03-1437-required-app-refresh.md](2026-11-03-1437-required-app-refresh.md) (in part); [2026-11-02-1638-desktop-update-on-launch.md](2026-11-02-1638-desktop-update-on-launch.md) | [2026-11-26-0120-auth-and-overlays-from-benchmark.md](2026-11-26-0120-auth-and-overlays-from-benchmark.md) |
| **默认 Harness row, global run location, 重新播放引导 in settings** | [2026-11-23-2000-settings-models-capy-boardui.md](2026-11-23-2000-settings-models-capy-boardui.md), [2026-11-02-1610-model-settings-r1-r5.md](2026-11-02-1610-model-settings-r1-r5.md), [2026-11-02-0203-personal-workspace-keeps-bots.md](2026-11-02-0203-personal-workspace-keeps-bots.md) (in part) | [2026-11-26-0100-settings-structure-from-benchmark.md](2026-11-26-0100-settings-structure-from-benchmark.md) |
| **Pre-2026-11-01 frozen decision table** | [`../decisions.md`](../decisions.md) (frozen archive) | Tier 1 Living Standards + `20*.md` records above |
