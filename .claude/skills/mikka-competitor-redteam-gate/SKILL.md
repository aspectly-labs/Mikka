---
name: mikka-competitor-redteam-gate
description: >-
  Run a strict competitor-benchmarked UI/UX red-team gate for Mikka Web, Desktop,
  and Mobile iOS (mobile-next) before shipping or declaring visual pass. Enforces
  Mobbin + Electron (Codex/Capy/Cursor) benchmarking, Kubai Design Tips, Nielsen
  H1-H10, Apple HIG 44pt/Liquid Glass/grabber/haptics rules, 50-item scalability,
  and rendered-screenshot verification.
---

# Mikka Competitor Red-Team & Native Craft Gate

Use this skill before finalizing any UI redesign, PR review, or before-and-after report across Mikka Web, Desktop, or `mobile-next` iOS.

## Gate 1 — Authoritative & Competitor Baseline
1. Read applicable `mikka-hosted-ui/docs/design/decisions/` and `mikka-hosted-ui/docs/design/glossary.md` first (e.g., `2026-11-09-0050` paid blocks as shipped, `2026-11-18-1200` Capy sidebar rows, Bot-managed threads, zero `对话`/`会话`/`Issue` in Chinese UI).
2. Inspect real competitor benchmarks before writing UI code:
   - Query **Mobbin MCP** (`best-practices` → `search` → `search_screens`) for the exact platform (`ios` or `web`) and screen type (ChatGPT, Claude, Cursor, Linear, GitHub, v0).
   - For Agent workflows (tool calls, sidebar/captains/crew, PRs, threads, secrets), inspect the reference Electron **frontend + backend** protocol rather than mimicking surface visuals alone.
3. Load `.hosted-ui/.claude/skills/kubai-design-tips/SKILL.md` (especially `004 Continuous corners`, `009 Overlays`, `010 Liquid glass`, `011 Easing curves`, `015 UI continuity`, `016 Toast`, `017 Loading states`, `020 Choice controls`, `022 Empty states`) and `.claude/skills/ux-heuristics/SKILL.md`.

## Gate 2 — Apple HIG & Native iOS (`mobile-next`) Hard-0 Checklist
Audit **both** `features/mikka/*` **and** inherited `features/threads/*`, `features/pull-requests/*`, `components/ui/*`:
- **Touch targets & Icon scale**: Every interactive button/icon has `>= 44×44pt` effective touch target (`width/height` + `hitSlop`); message/composer/bar action icons are `18–24pt` at crisp contrast (never `28pt` buttons or `13pt` faint icons).
- **Native Liquid Glass (iOS 26)**: Use `expo-glass-effect` `GlassContainer` + `GlassView` with `isInteractive`, `tintColor={null}`, zero opaque `bg-glass-surface` fill, and full-bleed scrolling content behind floating bars (never place glass over a solid opaque footer — Kubai `010`). Do not put `overflow: "hidden"` on the same view as iOS drop shadows.
- **Native Sheets (`formSheet`)**: Any sheet with `sheetGrabberVisible` must have `>= 24pt` (`pt-6`/`pt-7`) top padding and content-fit detents (`fitToContents` or tight detents — zero empty 60% voids).
- **Gestures & Physics**: Drawer swipe-to-close must work across the entire open drawer surface (root-level pan simultaneous with scroll views), tracking 1:1 with velocity-fed `withSpring` and continuous radius/dim interpolation (Kubai `011` & `015`).
- **Taptic Engine**: Wire `expo-haptics` (`selection`, `impactLight`/`Medium`, `success`/`error`) on drawer snaps, tab/segment switches, model picks, tool toggles, sends, and destructive confirms.
- **Composer Vertical Lock**: Across `Chat`, `Tasks`, and `Thread`, verify `ΔY === 0pt` (no double safe-area/tab-bar inset).
- **Built-in Native Reuse**: Wire existing Mikka backend endpoints (`/api/mobile/model`, PR/diff APIs) into built-in native T3 screens (`MikkaModelPickerSheet`, `PullRequestRouteScreen`) instead of hardcoded stubs or Safari escapes.

## Gate 3 — Web & Cross-Client Hard-0 Checklist
- **No paid-block bypass**: Never replace shipped `affectUI` / `BoardUI Pro` / `beUI Pro` screens with custom stubs (`DRIFT_CEILING = 0`).
- **50+ item stress check**: Every repo, secret, model, timezone, member, bot, label, or file picker must support search/filtering and bounded scroll height; use structured KV/chip editors instead of raw newline/`KEY=VALUE` textareas.
- **Zero DB jargon & honest state**: Strip raw `versionId`, `sha256`, `revision`, `approved`, raw UUIDs, lowercase DB enums, fake disabled switches, and `· 待接入` badges. `进行中` / `Active` filters must exclude `failed`, `stopped`, `done`, and `canceled`.
- **Verbatim tool calls (Codex standard)**: Align tool-call schema and fold/expand UX with Codex (`read|search|listFiles|exec|edit|mcp|web|agent`, streaming inline, exploration coalescing, auto-fold after answer unless failed or manually expanded); do not add speculative regex output masking or UUID scrubbing beyond environment/secret boundaries.

## Gate 4 — Rendered Visual Proof Before Reporting Done
- Capture compiled Light + Dark screenshots of **100% of affected routes** (never skip secondary dialogs/sheets or mobile `390×844` views).
- Inspect screenshots side-by-side against the benchmark screenshots from Gate 1 before declaring PASS.
- Any native capability not testable in Linux CI (iOS 26 `UIGlassEffect` refraction, physical Taptic Engine, swipe feel) must be explicitly listed as an on-device TestFlight verification checklist.
