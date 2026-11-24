# Design System v2: ChatGPT / Codex + Claude Code + Capy as the single UI authority

- **Date:** 2026-11-24 15:18 UTC
- **Status:** Accepted (Alex, 2026-11-24)
- **Supersedes:**
  - Comma (`app.comma.surf`) as Mikka's look-and-feel authority (`docs/design/README.md` source table #6, `2026-11-01-1204-type-follows-comma.md`, `R-32`/`R-35` Comma look clauses).
  - Grok-style composer and the old `R-10` independent-review composer clause (`docs/design/rules.md` R-10).
  - Old blue/grey chat bubble dogma (`docs/design/rules.md` R-14) in favor of full-width quiet assistant replies and subtle neutral user bubbles across Web, Desktop, and iOS.
  - Old LobeHub bordered action-bar pill and 960px column overrides (`2026-11-22-2000-chat-look-as-lobehub.md` §1, §5; author headers in group chat only from `2026-11-23-0300-agent-messages-as-rows.md` remain in effect).
- **Retains:**
  - Single UI (`2026-11-08-2133-one-ui.md`) and all interface code in `mikka-hosted-ui` (`2026-11-24-1000-all-ui-in-hosted.md`).
  - Paid blocks as shipped (`2026-11-09-0050-paid-blocks-as-shipped.md`) — BoardUI Pro, affectUI, and beUI Pro keep their shipped visuals unless explicitly patched under the `paid-overrides.mjs` ratchet.
  - One state-mark registry (`2026-11-19-1630-one-mark-registry.md`), R-40 zero filler, `copy.md` C-01..C-09, and `glossary.md` terminology (`线程`, `群聊`, `Bot`, `Mikka Cloud`, `daemon`).

## Context

Earlier design rules accumulated overlapping look-and-feel precedents (Comma, Grok, Hark, LobeHub, and four competing CSS token layers). Side-by-side audits against unpacked Electron builds of ChatGPT / Codex Desktop, Claude Desktop / Claude Code, Capy `0.9.2`, and Orca (`2026-11-24`) showed two root causes behind chat clutter and visual inconsistency:

1. **Component, layout, and copy architecture (~80–85% of observed issues):** bottom takeovers capped at `60dvh` (`456px` on a `760px` window), `TodoList` opening expanded by default (`292px`), unbounded approval cards mounted outside `ThreadScreen`, duplicate notice text shown simultaneously in the transcript and bottom slot, double-nested `.ui-th-error` cards, and 4–6 button quota/refusal boxes crushing scrollable chat to 17–31% of the viewport.
2. **Design token gaps (~15–20% of observed issues):** secondary text at `rgba(0,0,0,0.45)` / `rgba(255,255,255,0.45)` failing WCAG AA `4.5:1` contrast (`3.38:1` light, `4.1:1` dark), un-overridden opaque `--rule` (`#262626` dark) paired with `16px` `rounded-2xl` notice frames directly above `8px` `0.5px`-hairline composer cards, and missing quiet semantic status wash tokens.

## Decision

Establish **Mikka Design System v2** ([`docs/design/design-system.md`](../design-system.md)) as the single executable visual and interaction standard across Web, Desktop, and iOS:

1. **Single precedent hierarchy:** **ChatGPT / Codex + Claude Code** govern chat chrome, transcript typography, composer, inline status/quota strips, and quiet error presentation; **Capy** governs the workspace right rail, tab bar, sidebar work tree, and task detail panel; **Linear** remains the reference only for issue/board semantics where not already covered. Comma, Grok composer, blue/grey bubble dogma, and LobeHub's bordered action bar are retired.
2. **Surgical token calibration (no palette rewrite):** Preserve the neutral shell surfaces (`#f8f8f8`/`#ffffff` light; `#0e0e10`/`#141416`/`#1b1b1e` dark), `Mikka Inter` + `Geist Mono`, and `0.5px` hairline shadows in `mikka-hosted-ui/styles/palette.css`. Fix the three concrete token defects:
   - **T1 (WCAG AA contrast):** Raise `--muted-foreground` / `--color-text-secondary` to `rgba(0,0,0,0.58)` (light) / `rgba(255,255,255,0.60)` (dark) and `--color-text-tertiary` / `--color-text-placeholder` to `rgba(0,0,0,0.40)` / `rgba(255,255,255,0.42)`.
   - **T2 (Hairline `--rule` & radius alignment):** Override `--rule` in `styles/palette.css` to translucent `rgba(0,0,0,0.08)` (light) / `rgba(255,255,255,0.09)` (dark), and standardize composer-adjacent strips and takeover cards on `8px` (`rounded-lg`) or `12px` (`rounded-xl`) — retiring `16px` `rounded-2xl` notice frames above `8px` composers.
   - **T3 (Quiet semantic status washes):** Define `--status-{warning,error,info}-{bg,border}` soft wash tokens (`8–12%` fill, `18–22%` border) and default quota/rate-limit strips to a neutral card surface + hairline border + muted tinted `16px` icon.
3. **Viewport budget & single bottom slot:** Chat columns cap at `896px` max-width; a single priority bottom slot (`permission > question > notice > composer`) prevents unbounded stacking; `TakeoverCard` caps at `min(42dvh, 320px)` (`min(40dvh, 260px)` mobile) with mandatory `Later` / `Esc` collapse; `TodoList` defaults collapsed; `composer-ground-strip` caps at `104px` (`6.5rem`); scrollable transcript keeps `>= 55%` viewport on desktop (`1280×760`) and `>= 50%` on compact (`960×720`); and active bottom strips/cards never duplicate full text in the transcript.
4. **Mandatory 7-state interaction contract & automated gates:** Every interactive surface implements Loading, Empty, Error (with Retry preserving drafts), Pending (double-submit lock), Dirty (unsaved/one-time-secret guard), Keyboard/Focus/IME/Esc isolation, and Touch vs. Hover (`@media (hover: hover)` + `44px` coarse hit target), enforced by TypeScript slot contracts, static policy checks, Playwright geometry/contrast CI gates, and the `preview/design-system/` living gallery in `mikka-hosted-ui`.

## Consequences

- `docs/design/design-system.md` becomes the primary visual and interaction authority referenced by `docs/design/README.md`, `docs/design/rules.md`, `docs/design/copy.md`, `docs/design/components.md`, `docs/review-checklist.md`, and `AGENTS.md`.
- All web/desktop token and primitive implementations ship in `mikka-hosted-ui` (`styles/palette.css`, `components/mikka/chat-bottom/`, `preview/design-system/`, and `scripts/{design-system-geometry,copy-budget}.test.mjs`), keeping public `aspectly-labs/Mikka` free of web/desktop UI source (`scripts/no-public-ui.test.mjs`).
- `docs/design/decisions.md` stays untouched as frozen history.
