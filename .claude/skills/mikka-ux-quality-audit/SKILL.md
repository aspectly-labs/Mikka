---
name: mikka-ux-quality-audit
description: "Run a cross-product Mikka UI/UX and functional-quality audit: discoverability and missing actions, dead controls, state/permission parity, error recovery, keyboard/touch, responsive layout and accessible flows. Use for broad UX reviews and quality sweeps; route concrete command coverage to mikka-action-coverage."
---

# Mikka UX and quality audit

## Preflight

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/design/README.md`, `docs/review-checklist.md`, `docs/ci/test-ownership.md` and the actual current issue owner. Respect the single official UI and the top-product authority (paid blocks are raw material, `2026-11-27-1409`). The public Server-only build is **not** another UI to review.

Before auditing, record exact public `Mikka` and private `mikka-hosted-ui` source SHAs, application/runtime build and tested environment. Search existing #1646/#1979/#1980/#1966 and #2212 findings before assigning new work. Keep one issue/PR owner per affected source path; never race the #1954 production cutover owner.

## Procedure: investigate, fix, verify

1. **Choose user journeys, not arbitrary screens.** Inventory roles (personal, team member/lead, org admin, read-only/revoked), the important jobs those users expect to finish, and the official entry paths (Web, Electron, applicable Expo/iOS, Cloud/self-hosted). Include first use, daily tasks and failure/recovery. Note an explicitly allowed redirect from a compact view.
2. **Audit missing and misleading functionality first.** Invoke [mikka-action-coverage](../mikka-action-coverage/SKILL.md). Map authorized backend command and state transition -> reachable UI affordance -> handler -> authoritative API -> durable readback. Reverse from visible controls to real operations. A static callback reference is not proof of a working action.
3. **Audit usability by evidence, not aesthetics.** Use [ux-heuristics](../ux-heuristics/SKILL.md) for the screen score and the Nielsen audit, [cognitive-walkthrough](../cognitive-walkthrough/SKILL.md), [ui-ux-pro-max](../ui-ux-pro-max/SKILL.md), adapted [web-design-guidelines](../web-design-guidelines/SKILL.md) and [impeccable-audit](../impeccable-audit/SKILL.md). Prioritize status visibility, navigation, accurate feedback, focus, touch, wrapping, screen-reader semantics, error/empty/loading state and unnecessary network work. No new design system.
4. **Verify at actual boundaries.** Use [mikka-browser-qa](../mikka-browser-qa/SKILL.md) and the adapted [webapp-testing](../webapp-testing/SKILL.md). Pin a local production-build source pair. Distinguish source inspection, DOM/browser evidence, real HTTP + isolated PostgreSQL, packaged Electron, Expo Web and physical TestFlight. Test authorized write/readback and denied write; simulate 409, 401/403, 5xx, lost ACK, retries, cold/hot readiness and navigation only where relevant. Clean only disposable isolated fixtures.
5. **Triage and fix.** Each finding includes a real affected journey, fixed SHA and route/role, observed before/after, severity 0-4, occurrence (1-10) and impact (1-10), root-cause owner, exact failed contract and regression. Dedupe against open issues. Honor `AGENTS.md` risk triage: low occurrence×impact under 5 is filed rather than speculative refactoring unless security/irreversible harm. Fix confirmed meaningful bugs in their canonical source; do not clone a second reader, state machine or paid component.
6. **Ship with independent proof.** Read the existing [diagnosing-bugs](../diagnosing-bugs/SKILL.md), [test-audit](../test-audit/SKILL.md), and [verification-before-completion](../verification-before-completion/SKILL.md). Show a pre-fix failing observation and post-fix evidence at the strongest owner boundary. Run affected Nx/lint/API/PG and local production UI acceptance, review merge risk and use normal protected PR merge. Preserve platform/runtime production owner gates and close only when the issue's DoD truly holds.

## Mandatory Red-Team & Anti-Whack-a-Mole Gates

1. **Whole-Surface Sweep (Never Whack-a-Mole)**: When the user flags a pattern defect on 1–3 screens (e.g., non-searchable pickers, copy drift, dead actions, small tap targets, grabber collision), audit **every sibling route and active client** (Web Settings, Web Workspace, Standalone/Auth/Error, Desktop Electron, active Mobile iOS) in the same pass — **including upstream/inherited directories** (such as `mobile-next/apps/mobile/src/features/threads/*` and `features/pull-requests/*`). Never assume inherited UI is compliant.
2. **External Benchmark Before Building or Passing**: Never judge a screen only against "old Mikka". Cross-check every audited or redesigned screen against:
   - Authoritative Mikka docs (`docs/design/decisions/`, `docs/design/glossary.md`, top products over paid blocks `2026-11-27-1409`).
   - Installed craft skills: `.hosted-ui/.claude/skills/kubai-design-tips/`, `ux-heuristics`, `ios-design`, `swiftui-expert-skill`.
   - Real top-tier product references: **Mobbin MCP** (`search_screens` / `search_flows`) and unpacked reference **Electron frontend + backend** code (Codex, Capy, Cursor) to understand both UI anatomy **and** underlying workflow/data contracts.
3. **Rendered Evidence Only (Never Code-Only Visual PASS)**: Do not claim visual, layout, contrast, glass, or spacing PASS from `.tsx` reading alone. Require compiled screenshots (Desktop + `390×844` Mobile, Light + Dark) compared side-by-side against reference benchmarks. Where native iOS shaders or physical-device gestures cannot run in Linux CI, explicitly label them `unverified-on-device` and attach a physical TestFlight checklist.
4. **Walk Real Gestures, States, Scale (50+ Items) & Existing Capabilities**:
   - Trace interactive gesture bounds end-to-end (e.g., sidebar swipe-to-close must work on the sidebar surface itself, not only a thin edge strip) and verify tactile feedback (`expo-haptics` on iOS).
   - Stress-test list/picker controls with **10–50+ realistic items** (searchable comboboxes; no flat checkbox dumps, raw `KEY=VALUE` textareas, or 400-item flat `<Select>`s).
   - Verify state-filter semantics (`进行中` / `Active` must never include `failed`, `stopped`, `done`, or `canceled`; filter IDs must match real section IDs).
   - Reuse existing backend APIs and built-in native screens (e.g., `/api/mobile/model`, built-in PR/diff views) before writing hardcoded stubs or escaping to Safari.
5. **No Unrequested Inventions or Speculative Redaction**:
   - Preserve Mikka's Bot-managed architecture (no fake `"还没有线程"` / `"+ 新线程"` under empty Bots; only render expand chevrons when `threads.length > 0`; no standalone global `Threads +` section).
   - Do not add general regex output redaction or UUID scrubbing on tool-call commands/logs that Codex/Cursor do not perform — protect explicitly tagged Secrets at the environment/egress boundary and show verbatim tool commands & output.

## Evidence and reporting

Run the [domain workflow](../../../docs/design/ux-quality-audit.md#run-one-domain) from the public checkout. Attach the command results and observed interaction to the source-bound matrix. Statuses: `verified-missing`, `verified-broken`, `source-only-candidate`, `verified-intentional`, `verified-fixed`, `not-tested`. Never treat an empty result list or an AST pass as full functional coverage.

No general browser E2E CI gate, product polling, Vercel preview or new paid UI source. An audit does not authorize production data writes or publishing. If production/physical-device acceptance is unavailable, record the exact remaining gate; continue unrelated actionable work without declaring the entire goal finished.
