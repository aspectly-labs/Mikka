# UI Spec: <SURFACE_OR_FEATURE_NAME>

- **Status:** Draft | In Review | Accepted | Superseded by `<link>`
- **Owner:** `<engineer, designer, or agent>`
- **Tracking issue:** `#<number>`
- **Target surface(s):** Web | Desktop | iOS (`mikka-hosted-ui` / `apps/mobile`)
- **Visual reference target (mandatory before coding):**
  - Figma file & frame ID: `<for example, zPe5LKycb2XuT1ivCLRw07 node XX:YY>` OR
  - Governing reference screen: `<ChatGPT / Codex | Claude Code | Capy 0.9.2 (exact asset/route) | Linear | Apple HIG | Paid block demo>`

Copy this template before coding UI. Every UI PR must reference the completed spec and attach side-by-side visual evidence (`## 视觉对照`).

## 1. User job and entry points

- **Job:** One or two sentences describing what the person accomplishes, in their words.
- **Entry points & navigation:** Where the surface opens, what triggers it, what it replaces, and how the person returns (`docs/design/glossary.md` terms only).
- **Roles & permissions:** Behavior for owner/admin, member, first-time user, and unauthorized caller (with `WhyDisabled` where controls are disabled).

## 2. Component reuse and zero patch-on-patch (R-90)

List every part of the screen and the exact existing primitive it reuses (`docs/design/design-system.md` §2, `docs/design/components.md`, `mikka-hosted-ui/components/mikka/list-page/`):

| Surface part | Existing primitive / paid block | Notes (top-product reference if paid block) |
| --- | --- | --- |
| `<Header / toolbar / list / strip / card>` | `<CapyListPage / ChatStatusStrip / TakeoverCard / paid block edited to the reference>` | `<notes>` |

- **New primitive justification (omit if none):** Explain why no existing primitive fits and confirm `docs/design/components.md` updates in the same PR.
- **Zero patch-on-patch check:** Confirm no additional CSS/patch layer is stacked onto an existing paid-block override (`mikka-hosted-ui/patches/*.patch`).

## 3. Layout and viewport budgets

- **Desktop (`1440×900` & `1280×760`):** Column widths, single-row header/toolbar heights, right-rail bounds (`320px` min, `520px` default), scrollable chat transcript `>= 55%`.
- **Compact (`960×720`):** Panel wrapping/collapse rules, scrollable chat transcript `>= 50%`.
- **Mobile (`390×844` & `320px` reflow):** Zero horizontal overflow (`scrollWidth <= innerWidth`), full-width drawers (`100%`), `>= 44×44px` coarse hit targets, no `absolute` + `pointer-coarse:opacity-100` overlays covering leading icons or metadata.
- **Tokens:** Semantic tokens from `mikka-hosted-ui/styles/palette.css` only (zero raw `#hex`/`rgb()`, zero `dark:` color overrides, WCAG AA `>= 4.5:1`).

## 4. Mandatory 7-state and theme matrix

Every applicable row must be defined before implementation:

| # | State | Desktop Light & Dark | Mobile (`390px`) Light & Dark |
| --- | --- | --- | --- |
| **1** | **Loading** | `<shape-matched skeleton; never disables inputs>` | `<same height; zero shift>` |
| **2** | **Empty** | `<first-use (1 state + 1 action) vs. 0-match + Clear>` | `<reflows cleanly>` |
| **3** | **Error & Recovery** | `<inline InlineLoadError/SettingsSaveError; preserves drafts; Retry or status re-check>` | `<visible inside open modal/sheet>` |
| **4** | **Pending & Double-Submit** | `<sync pending ref; targeted button spinner; dismiss guard>` | `<touch double-tap locked>` |
| **5** | **Dirty & Destructive Guard** | `<dirty form / one-time secret protection; R-102 confirm or 8s Undo>` | `<sheet swipe/backdrop guarded>` |
| **6** | **Keyboard, Focus, IME & Esc** | `<isComposing safe; ignores hidden/inert/modals; single-layer Esc; focus restore; zero nested interactive controls>` | `<Enter/return key & focus safe>` |
| **7** | **Touch, Hover & Reflow** | `<hover actions gated by @media (hover: hover)>` | `<coarse actions visible in-flow; >= 44px targets; 320px reflow>` |

## 5. Copy and i18n (R-40, C-01..C-10)

List every new or modified string in both `messages/zh-CN.json` and `messages/en.json`. Delete any subtitle, reassurance sentence, or explanatory filler that can be removed without losing meaning.

| Key | `zh-CN` | `en` | Constraint check (`线程`/`群聊`, zero raw UUID/enum) |
| --- | --- | --- | --- |
| `<namespace.key>` | `<Chinese copy>` | `<English copy>` | `<verified>` |

## 6. Action coverage and honest completion

Trace every user action both ways (`command × permission × transition × UI entry`):

| Action | Trigger & route/RPC | Permission | Pending / ACK / error & readback |
| --- | --- | --- | --- |
| `<Action>` | `<UI control -> API/RPC>` | `<role>` | `<pending indicator, durable readback, inline error>` |

## 7. Visual comparison checklist (`## 视觉对照`)

Copy this table into the PR body and complete every row before merging:

| Reference specification item | Implemented / intentional delta (with reason) | Desktop `1440×900` (Light & Dark) | Mobile `390×844` (Light & Dark) |
| --- | --- | --- | --- |
| `<Header / toolbar / row / drawer / contrast / budget>` | `<Implemented or justified delta>` | `[ ] Verified` | `[ ] Verified` |

- [ ] Targeted local screenshots captured and visually inspected in cloud Linux (`pnpm --dir mikka-hosted-ui visual:local --target <slug>`, 0 horizontal overflow, 0 console/page errors).
- [ ] `mikka-hosted-ui` static `Cloudflare UI Policy` (`paid-sources`, `oxlint`, `frontend-policy`, unit tests) and `Cloudflare UI Fast Gate` (official Web build + `bundle-budget`) passed.
- [ ] `docs/review-checklist.md` passed end to end.

## 8. Out of scope

- `<explicitly excluded work>`
