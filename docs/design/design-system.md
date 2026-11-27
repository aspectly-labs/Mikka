# Mikka Design System v2

**Audience:** Frontend, mobile, and design contributors shipping UI in `mikka-hosted-ui` (Web and Desktop) and `apps/mobile` (iOS).
**Scope:** Visual tokens, restricted UI primitives, chat layout and viewport budgets, the 7-state interaction contract, copy density limits, and automated enforcement across Web, Desktop, and iOS.
**Out of scope:** Backend orchestration (`orchestration.md`) and domain terminology definitions (`glossary.md`). Paid blocks (BoardUI Pro, affectUI, beUI Pro) are in scope as raw material: they are edited in place in `mikka-hosted-ui` to match the reference product ([2026-11-27-1409](decisions/2026-11-27-1409-top-products-over-paid-blocks.md)).

**Visual authority ([2026-11-24-1518](decisions/2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md)):**
- **ChatGPT / Codex + Claude Code** govern chat chrome, transcript typography, composer, inline status/quota strips, and quiet error presentation.
- **Capy** governs the workspace right rail, tab bar, sidebar work tree, and task detail panel.
- **Linear** applies only to issue and board semantics not already covered above.
- Comma, Grok composer, old blue/grey bubble dogma, and LobeHub's bordered action bar are retired.

---

## 1. Design Tokens

All Web and Desktop tokens live in `mikka-hosted-ui/styles/palette.css` (the single override bridge unifying shadcn `core/app/globals.css`, BoardUI `styles/theme.css`, and affectUI shell variables). Mobile mirrors the same semantic ramp in `apps/mobile/styles/tokens.css` and `apps/mobile/lib/tokens.ts`.

### 1.1 Surfaces, Borders, and Text Contrast (T1 + T2)

Use semantic tokens only. Never introduce tinted greys (slate, zinc, teal) or ad-hoc opacity utilities (`text-muted-foreground/70`, R-104).

| Role | Token(s) | Light | Dark | Contract |
| --- | --- | --- | --- | --- |
| Shell / sidebar background | `--sidebar`, `--page`, `--color-background-full` | `#f8f8f8` | `#0e0e10` | Neutral canvas behind inset panels |
| Primary panel / chat canvas | `--background`, `--panel` | `#ffffff` | `#141416` | Main reading and conversation surface |
| Card / popover / composer | `--card`, `--popover`, `--color-background-primary-default` | `#ffffff` | `#1b1b1e` | Elevated surface; composer sits on `--card` |
| Soft control / hover tint | `--secondary`, `--mk-muted`, `--color-background-secondary-default` | `rgba(0, 0, 0, 0.04)` | `rgba(255, 255, 255, 0.06)` | Hover steps to `0.06` (light) / `0.09` (dark) |
| Structural hairline border | `--border`, `--sidebar-border`, `--color-separator-border` | `rgba(0, 0, 0, 0.06)` | `rgba(255, 255, 255, 0.08)` | Translucent; never opaque white hairlines (R-31) |
| **Card / notice rule (T2)** | `--rule`, `--color-rule` | `rgba(0, 0, 0, 0.08)` | `rgba(255, 255, 255, 0.09)` | Overrides opaque `#e5e5e5` / `#262626` in `palette.css` |
| Input / button border | `--input`, `--color-border-button-default` | `rgba(0, 0, 0, 0.10)` | `rgba(255, 255, 255, 0.12)` | Hover steps to `0.16` (light) / `0.18` (dark) |
| Primary text | `--foreground`, `--color-text-primary` | `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.90)` | `>= 12:1` contrast |
| **Secondary text (T1)** | `--muted-foreground`, `--color-text-secondary` | `rgba(0, 0, 0, 0.58)` | `rgba(255, 255, 255, 0.60)` | Clears WCAG AA (`>= 4.5:1`; `~5.3:1` light, `~6.9:1` dark on `--background` / `--card`) |
| **Placeholder & quiet chrome (T1)** | `--color-text-tertiary`, `--color-text-placeholder` | `rgba(0, 0, 0, 0.40)` | `rgba(255, 255, 255, 0.42)` | Placeholders, disabled chrome, decorative icons/separators; readable body-tier quiet text uses `--tertiary` / `--muted-foreground` (`>= 4.5:1`, R-104) |
| Brand accent / focus ring | `--ring`, `--color-accent-500`, `--color-border-focus-ring` | `#0060e2` | `#5b9aff` | Single interactive accent (R-30) |

### 1.2 Quiet Semantic Status Washes (T3)

Quota, rate-limit, and model-unavailable strips default to a **neutral `--card` surface + hairline `--rule` border + muted `16px` tinted icon** (Claude Code / Codex / Orca pattern). Use soft status washes only when an inline alert needs background emphasis — never saturated `red-500` borders or card-in-card nesting:

| Severity | Background Token | Light / Dark Fill | Border Token | Light / Dark Border | Foreground |
| --- | --- | --- | --- | --- | --- |
| Warning | `--status-warning-bg` | `rgba(217, 119, 6, 0.08)` / `rgba(245, 158, 11, 0.12)` | `--status-warning-border` | `rgba(217, 119, 6, 0.18)` / `rgba(245, 158, 11, 0.22)` | `--warning-foreground` (`>= 4.5:1`) |
| Error | `--status-error-bg` | `rgba(220, 38, 38, 0.08)` / `rgba(239, 68, 68, 0.12)` | `--status-error-border` | `rgba(220, 38, 38, 0.18)` / `rgba(239, 68, 68, 0.22)` | `--destructive-foreground` (`>= 4.5:1`) |
| Info | `--status-info-bg` | `rgba(0, 96, 226, 0.08)` / `rgba(91, 154, 255, 0.12)` | `--status-info-border` | `rgba(0, 96, 226, 0.18)` / `rgba(91, 154, 255, 0.22)` | `--info-foreground` (`>= 4.5:1`) |

### 1.3 Radii, Elevation, Typography, Controls, Motion, and Breakpoints

- **Radii (T2):** `6px` (`rounded-md`) buttons, tabs, tags, compact rows; **`8px` (`rounded-lg`)** composer, `TakeoverCard`, notice strips, inputs, board cards; **`12px` (`rounded-xl`)** floating strips, inset panels, dialogs (`--radius-panel`); `9999px` (`rounded-full`) pills and avatars. Never place a `16px` (`rounded-2xl`) notice box above an `8px` composer; never exceed `12px` on lists, tables, rows, menus, or popovers (R-97).
- **Elevation (hairline-first):** Inline cards stay flat (`0 0 0 0.5px var(--border)`). Only the composer, bottom `TakeoverCard` (`.hth-takeover-card`), popovers, and toasts carry ambient shadow (`0 4px 12px rgba(0,0,0,0.025), 0 2px 6px rgba(0,0,0,0.03), 0 1px 1px rgba(0,0,0,0.04)` light; `0 3px 8px rgba(0,0,0,0.16), 0 2px 5px rgba(0,0,0,0.14), 0 1px 1px rgba(0,0,0,0.20)` dark).
- **Typography:** Self-hosted `Mikka Inter` (UI/body, `font-display: block`, `font-synthesis: none`) and `Mikka Geist Mono` (code); system CJK fallback with zero self-hosted CJK glyphs.
  - Chat prose & composer input: `14px / 22px` (`text-sm` in standard scale, `15px` prose in documents/Artifact reader).
  - Compact chrome, list titles, buttons, status strips: `13px / 18–20px` (`text-body-2-regular` / `medium`).
  - Metadata, timestamps (`tabular-nums`), group headings, captions: `12px / 16–18px` (`text-caption-1-*`).
  - Micro badges / keycaps: `11px / 14px` (`text-caption-2-*`, floor — nothing smaller than `11px`).
  - Page titles: `20px` SemiBold (`R-100`); document titles: `24px / 32px` SemiBold. Weights stop at SemiBold (`600`), sentence case only (no uppercase tracked headers).
- **Control heights (R-99):** `--control-xs` `24px`, `--control-sm` `28px`, `--control-md` `32px`, `--control-lg` `36px`. Adjacent controls in one row share one step.
- **Motion (R-103):** `--motion-fast` `100ms`, `--motion-base` `200ms`, `--motion-slow` `320ms`. Panels and columns switch instantly (R-37). No `transition-all`.
- **Breakpoints (R-105):** Tailwind standard `sm` `640`, `md` `768`, `lg` `1024`, `xl` `1280`, `2xl` `1536` only.

---

## 2. Restricted Primitives and TypeScript Slot Contracts

Build Mikka's own surfaces from a small, closed set of primitives so layout, density, and escape hatches are enforced at compile time rather than by code review alone. Paid blocks (BoardUI Pro, affectUI, beUI Pro) are raw material: edit their source in place to match the reference product rather than layering overrides on top ([2026-11-27-1409](decisions/2026-11-27-1409-top-products-over-paid-blocks.md)); `mikka-hosted-ui/scripts/paid-sources.mjs` keeps the paid-source list and patch ledger consistent.

| Primitive | Purpose | Mandatory TypeScript Contract & Constraints |
| --- | --- | --- |
| `ChatStatusStrip` | Non-blocking quota, rate-limit, credits, model-unavailable, offline, or fallback notice above the composer or inline in transcript | Single horizontal row (`min-h-10`, `40–44px`), neutral `--card` bg + hairline `--rule` + `rounded-lg`/`rounded-xl`. Props enforce `icon`, short `label`, optional inline `detail`, **at most 1 `primaryAction`** (`ChatStripAction`), optional `secondaryActions` (collapsed behind `…` menu), and optional `onDismiss`. **Forbids** switches, paragraphs, and >1 visible primary button. |
| `TakeoverCard` (`components/mikka/chat-bottom/takeover-card.tsx`) | Blocking interactive card in the single bottom slot (permission approval, question, credential sign-in, write approval) | `max-h-[min(42dvh,320px)]` (`max-md:max-h-[min(40dvh,260px)]`), `rounded-lg`, `p-3`, `shrink-0` header/footer, scrollable middle body (`min-h-0 flex-1 overflow-y-auto overscroll-contain`), inner code/diff/log previews capped at `max-h-36` (`144px`). **Mandatory escape hatch:** every instance accepts `onDefer` (`稍后` / `Later`) and handles `Escape` to collapse to a 1-line reopen strip above the composer. Never carries inflated `minHeight` from a prior expanded todo/queue strip. |
| `AlertRow` (flat error/warning block) | Inline run refusal, turn error, or failed action inside transcript or forms | **Single flat container** (`rounded-lg`, `--status-error-bg`/`--status-error-border` or hairline `--card`). Severity in the leading icon, 1 short state title + 1 concise sentence + max 1–2 actions (`Retry` + single primary fix). Raw error codes/traces live inside a collapsed `<details>` (`max-h-28`). **Never** wrap an `<Alert>` inside `.ui-th-error` or any outer bordered card (R-39). |
| `ComposerSurface` (`chat-composer-clean.tsx`) | The single chat composer across Bot, Coordinator, Group, and Agent threads (R-10) | `rounded-lg`, `12px` padding, `14px` text, `0.5px` hairline shadow. Model chip renders **model name (+ subtle dot when limited)** only — never appends full quota status sentences. |
| `InlineLoadError` / `SettingsSaveError` | Failed read or write inside a panel, list, or settings section | Concise state text (`role="alert"`) + explicit `Retry` button for failed reads and safe/idempotent writes (or read-only status re-check `重新检查` when an effectful write's outcome is unknown; see §4 row 3). Never disguise a read error as an empty list or "No items". |
| `WhyDisabled` (`components/ui/why-disabled.tsx`) | Any control disabled by permission, plan, owner, or missing connection (R-101) | Sets `title` on wrapper and clones `aria-describedby` onto single-element child so pointer and screen-reader users learn why it is disabled. |

---

## 3. Layout and Viewport Budget

Chat and workspace surfaces follow hard geometric budgets measured on Desktop (`1280×760`), Compact (`960×720`), and Mobile (`375×812`).

### 3.1 Chat Column and Transcript Dominance

- **Reading column width:** `max-width: 896px` (`56rem`) centered with `16px` horizontal gutters (`32px` total), shared by messages, tool rows, code blocks, strips, and composer.
- **Message rhythm (ChatGPT / Claude Code standard):**
  - **One-to-one Bot, Coordinator, and Agent threads:** Full-width quiet assistant replies with no avatar, no name header, and no background bubble. User messages use a compact subtle neutral bubble (`--secondary`, `rounded-xl`, `px-3 py-2`) aligned right (no loud accent-blue bubble).
  - **Group chats:** Keep speaker avatar (`28px`) and name header once per same-author run (`2026-11-23-0300`).
  - **Message actions:** Hover/focus-revealed lightweight icon row (no heavy bordered pill container), always visible on touch (`@media (hover: none), (pointer: coarse)`), reserving its height at rest (`2026-11-22-1500`).
- **Minimum scrollable transcript share:** Measured as the share of the thread pane below the `48px` header (`712px` on a `1280×760` desktop window, `672px` on `960×720` compact), the scrollable transcript keeps **`>= 55%`** on desktop (`>= 392px`, which `712 - 320px` `TakeoverCard` satisfies because an active takeover replaces the composer and collapses non-blocking strips) and **`>= 50%`** on compact (`>= 336px`) and mobile (`375×812`) even under worst-case expanded todos, queued rows, or a bottom takeover card.

### 3.2 Single Bottom-Slot Priority State Machine

Exactly **one** interactive control occupies the bottom slot at a time, governed by a strict priority chain:

```text
permission / write-approval  >  question / credential-login  >  blocking-notice  >  composer
```

1. **Zero unbounded external stacks:** Every approval, write-action, login, and question card mounts inside `ChatBottomSlotProvider`. Never mount sibling approval lists (`ApprovedWriteActions`, etc.) outside `<ThreadScreen>`.
2. **Non-blocking warnings keep the composer visible:** Quota limits, model-unavailable warnings, offline status, and waiting-thread reminders render as a single `40–44px` `ChatStatusStrip` above the intact composer — never hijacking or hiding the composer.
3. **Bounded `composer-ground-strip`:** `TodoList` defaults to **collapsed** (1-line `32–36px` progress summary chip). When expanded, the combined `composer-ground-strip` (todos + queued messages) caps at **`max-h-[104px]` (`6.5rem`)** with `overflow-y-auto overscroll-contain`.
4. **Zero stream↔bottom duplication:** While an interactive card or strip is open in the bottom slot, the transcript renders at most a **1-line muted stub** (`Waiting for approval`, `Waiting on you`, clickable to reopen after `Later`). Never repeat the full question, option list, or quota paragraph in both places.

### 3.3 Right Column and Task Panel (Capy Standard)

- **Right rail width:** Default `520px`, minimum `320px`, maximum `calc(100% - sidebar - 320px)` so the chat column always retains `>= 320px`. Width persists in `localStorage`; double-clicking the resize handle resets to `520px`; dragging narrower than `160px` collapses the rail.
- **Tab bar:** `28px` ghost tabs, `12px` Medium, `6px` radius, `14px` status/PR icon, `×` close revealed on hover/focus (always visible at `<= 767px` / coarse pointer with `44px` hit target). Tabs show task code (`SPOT-4`) or PR ref (`mikka#42`), never raw UUIDs or URLs.
- **Task detail panel:** Large editable title, code + relative age, compact property rows (omitting unset fields), description, subtasks, activity log. No duplicate inner title bar when opened in a right-column tab.

---

## 4. Mandatory 7-State Interaction Contract

Every page, list, modal, drawer, and form must implement all seven states before review. Omitting any applicable state is a review blocker (mapped to Jakob Nielsen's 10 Usability Heuristics H1–H10):

| # | State | Mandatory Behavior |
| --- | --- | --- |
| **1** | **Loading** | Render a shape-matched skeleton at real row/card height (no layout shift, no bare `"Loading…"` strings, no flashing false empty states on tab switch). Never disable user-editable inputs or label Submit `"Creating…"` while auxiliary metadata loads. |
| **2** | **Empty** | Distinguish first-use empty (`1 concrete state line + 1 action`, R-41) from zero-match search/filter (`"No matches for '<query>'" + Clear action`). Active filters must remain visible and clearable even when switching tabs yields 0 matches. |
| **3** | **Error & Recovery** | Render inline `<InlineLoadError>` / `<SettingsSaveError>` / `<FieldError>` right inside the affected panel or open dialog (never hidden behind an open modal backdrop, never swallowed via `catch {}`, never disguised as an empty list). **Preserve user drafts** on failure — never unmount editors or clear forms before a write returns `2xx`. Offer **Retry** for failed reads and safe idempotent writes; when an effectful mutation's outcome is **unknown** (for example a lost response on an external write approval, `copy.md` §失败与未确认), report the state as unknown and offer a read-only **status re-check** (`重新检查`), never a blind effectful re-submit. |
| **4** | **Pending & Double-Submit Lock** | Guard every async submit with a synchronous ref or per-item pending ID inside `try / catch / finally` so thrown errors never deadlock controls. Show a spinner **only on the specific button clicked** (clicking Decline must never spin Approve) and block accidental Esc/backdrop dismissal while in flight. |
| **5** | **Dirty & Destructive Guard** | Protect multi-field dirty forms (automations, instructions, environments, skills, MCP servers, review comments) and **one-time secrets** (PATs, service keys, pairing tokens, SCIM/DNS tokens, recovery codes, invite links) against accidental Esc, backdrop click, or tab-switch unmount. Every irreversible or high-impact mutation (PR merge, production publish, webhook/key/token rotate or revoke, 2FA disable, SSO enforce, permanent delete) requires explicit confirmation (R-102) or an `8s` Undo toast where reversible. |
| **6** | **Keyboard, Focus, IME & Esc Isolation** | Global and panel shortcuts must check `event.defaultPrevented`, `event.isComposing` (IME safety), editable targets (including Shadow DOM `composedPath()`), hidden/inactive tabs (`[hidden]`, `[inert]`), and open modals (`[role="dialog"], [role="alertdialog"]`). `Escape` dismisses strictly one layer at a time (dropdown → sub-overlay → modal) and returns focus to the exact opener element. Interactive controls never nest (`<button>` inside `<button>` or `<label>`). |
| **7** | **Touch, Hover & Reflow** | Gate hover-only reveals behind `@media (hover: hover)` and reveal them permanently on `@media (hover: none), (pointer: coarse)` (`pointer-coarse:opacity-100`). Every coarse-pointer button/tab/trigger provides a `>= 44×44px` hit target (`lib/touch-target.ts`). Every Settings and workspace page reflows cleanly down to `320px` CSS width with zero horizontal overflow or stranded controls (never hide the only mobile trigger with `max-md:hidden`). |

---

## 5. Copy and Information Density Budget

Extends **R-40** (zero filler) and **[`copy.md`](copy.md) (C-01..C-09)** with concrete density caps:

- **Status strips (`ChatStatusStrip`):** Headline `2–5` words (`已达到 5 小时限额`, `Usage limit`, `Model unavailable`), optional inline detail on the same line (`12:20 重置`), **max `1` primary CTA button**, optional `×` dismiss or `…` overflow. Zero paragraphs, zero toggle switches, zero bullet lists.
- **Approval / decision cards (`TakeoverCard`):** Max `2–3` footer controls (`Later` / `Deny` + `Allow`, or split primary `Allow once ▾`). Collapse raw payloads, headers, and stack traces inside `<details>` (`max-h-28`–`max-h-36`).
- **Composer model chip:** Model name (+ subtle warning dot when limited) only. Detailed quota reasons live inside the dropdown row and the 1-line strip above the composer.
- **Zero internal leakage:** Never render raw UUIDs (`actorId`, `issueId`, `organizationId`, `accountId`), raw enum slugs (`request_changes`, `client_secret_basic`, `timed_out`), or unlocalized separators (use `Intl.ListFormat` / `format.list`, never hardcoded CJK `、` in English).
- **Exact terminology (C-09, `glossary.md`):** Chinese UI uses `线程` (never `对话` except `对话框`, never `会话` for chats), `群聊`, `Bot`, `Agent` (never `harness`/`执行器`), `Mikka Cloud` (never translated), `daemon` (never prefixed with `Mikka`).

---

## 6. Automated Enforcement Matrix

Every pillar above maps to a concrete compile-time or CI check across public `aspectly-labs/Mikka` and `mikka-hosted-ui`:

| Pillar / Rule | TypeScript / Code Mechanism | Automated Check / CI Gate |
| --- | --- | --- |
| **1. Tokens & WCAG AA contrast (T1–T3, R-30..R-38, R-104)** | Single token bridge `mikka-hosted-ui/styles/palette.css` | `mikka-hosted-ui/scripts/design-system-geometry.test.mjs` (Playwright computed contrast `>= 4.5:1` for effective `styles/palette.css` readable text tokens and all 6 `--status-*` text/surface pairs in Light & Dark, plus structural hairline `--rule` token verification), `scripts/contrast.test.mjs` (base `core/app/globals.css` `--tertiary` token), `scripts/ui-policy.mjs` (`lint:ui`) |
| **2. Restricted primitives & paid-source boundary (R-39, R-90)** | Typed props on `ChatStatusStrip`, `TakeoverCard` (required `onDefer`), `AlertRow`; `WhyDisabled` | `mikka-hosted-ui/scripts/paid-sources.mjs` (paid-source list and patch ledger), `mikka-hosted-ui/scripts/pr-visual-evidence-check.mjs` (top-product reference per UI PR), `scripts/ui-policy.mjs` (`style/nested-frame`, `style/secondary-button-fill`, `style/search-input`) |
| **3. Layout & viewport budget (Chat `>=55%`/`>=50%`, `<=1` takeover, `<=104px` ground strip)** | `ChatBottomSlotProvider` single-slot priority state machine, `TakeoverCard` `max-h-[min(42dvh,320px)]`, `TodoList` default collapsed | `mikka-hosted-ui/scripts/design-system-geometry.test.mjs` (Playwright `1280×760`, `960×720`, `375×812` Light/Dark), `mikka-hosted-ui/scripts/right-column-narrow.test.mjs`, `scripts/control-size-policy.mjs`, `scripts/motion-policy.mjs`, `scripts/split-pane-policy.mjs` |
| **4. 7-state interaction contract** | Synchronous pending ref, `try/finally`, `InlineLoadError`, `AlertDialog` R-102, `@media (hover: hover)` + `pointer-coarse:opacity-100` | `scripts/interaction-policy.mjs`, `scripts/icon-button-policy.mjs`, `scripts/navigation-policy.mjs`, `scripts/polling-policy.mjs`, `scripts/error-cause-policy.mjs`, `mikka-hosted-ui/scripts/core-ui.test.mjs` |
| **5. Copy & density budget (R-40..R-44, C-01..C-09)** | `messages/{zh-CN,en}.json`, `ChatStatusStrip` single-CTA prop | `scripts/check-i18n.mjs` (`pnpm i18n:check`), `scripts/check-copy.mjs`, `scripts/copy-policy.mjs`, `mikka-hosted-ui/scripts/copy-budget.test.mjs` |
| **6. Visual specimen & prod isolation** | Standalone living gallery in `mikka-hosted-ui/preview/design-system/` (all tokens + 7 states + viewport-budget specimen, Light/Dark + Desktop/Compact/Mobile) | `mikka-hosted-ui/scripts/official-build-excludes-preview.test.mjs` (0 bytes in production builds), `scripts/no-public-ui.test.mjs` (0 web/desktop UI in public `Mikka`) |
