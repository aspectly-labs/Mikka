# Top products are the authority; paid blocks are raw material

- Date: 2026-11-27 14:09 UTC
- **Status:** Superseded in part by [2026-11-27-1615-no-permission-approvals](2026-11-27-1615-no-permission-approvals.md) (the words "approval/permission cards" only; Accepted, Alex, 2026-11-25)
- Source: Alex, effective 2026-11-25, restated 2026-11-27: anything not aligned with the top products must not stay.
- Supersedes: [2026-11-09-0050-paid-blocks-as-shipped](2026-11-09-0050-paid-blocks-as-shipped.md) (「原样使用，只换数据」) in full, and the "Retains: Paid blocks as shipped" clause of [2026-11-24-1518-design-system-v2-chatgpt-cc-standard](2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md). The rest of 2026-11-24-1518, including its precedence of reference products, stands. Supersedes in part: [2026-11-18-1900-icons-hugeicons](2026-11-18-1900-icons-hugeicons.md), its 「付费库原样保留」 bullet only (paid libraries keep their own icons); the rest of that decision, the task-status exception included, stands. Supersedes in part: [2026-11-01-0015-main-is-the-design](2026-11-01-0015-main-is-the-design.md), rule 1 only for surfaces a top product covers (`main` still decides where no reference covers the surface).
- Icons source: owner, 2026-11-27: 「我们使用的 huge icons」.

## Decision

1. **Top products are the authority.** Each UI surface matches the
   corresponding surface of the top agent products:
   - ChatGPT / Codex and Claude / Claude Code for chat, composer,
     approval/permission cards, status and errors;
   - Capy for the workspace right rail, tab bar, sidebar work tree and task
     detail;
   - Linear for issue/board semantics.

   This is the precedence 2026-11-24-1518 already set; it now covers paid
   blocks too.
2. **Paid blocks and components are raw material.** BoardUI Pro, affectUI and
   beUI Pro source may be edited in place, in the private hosted repository
   only, to match the reference: layout, content, controls, icons, colours,
   anything. A paid block's look is never a reason to keep a difference from
   the reference.
3. **An element no top product has is removed** (for example a floating
   summary pill), unless Alex approves it by name.
4. **One icon set: Hugeicons.** Hugeicons through `@/components/icons`
   (`components/icons/index.tsx`) is Mikka's single icon set everywhere,
   including inside a paid block when it is edited to match a reference. Pick
   the Hugeicons glyph closest to the reference's glyph and match its rendered
   size and stroke weight; a glyph the set lacks is a line added to
   `components/icons/index.tsx`, not another package. Task status icons keep
   their exception (`TaskStatusIcon`, `TaskRunMark`, `TaskStatusMark`,
   [2026-11-18-1900](2026-11-18-1900-icons-hugeicons.md)). Paid source not yet
   edited may still carry its library's icons until it is.
5. **Every UI PR cites its reference per changed surface** (a Mobbin link, or
   the unpacked app or source path) in its `## Visual comparison` /
   `## 视觉对照` section, and lists the differences that remain, each with its
   reason. In the hosted repository the `## Visual comparison` section carries
   one line per changed surface in the form
   `Reference: <ChatGPT|Codex|Claude|Claude Code|Capy|Linear> <surface> — <https://mobbin.com/screens/… | unpacked app/source path>`,
   or `No rendered UI change: <reason>` when nothing rendered changes.

## Unchanged

- Paid source never goes public: `scripts/no-public-ui.test.mjs`, the hosted
  repository's import and paid-source guards, and private-only paid
  screenshots all stay.
- Licence keys are never written into a commit, PR, issue or log.
- Copy rules: [`copy.md`](../copy.md) and [`glossary.md`](../glossary.md)
  (线程, 群聊), R-40, i18n through `messages/*.json`. A paid block's text slots
  follow them like any other text.
- BoardUI's token and type mechanics for Mikka's own UI, the single UI in the
  hosted repository ([2026-11-24-1000](2026-11-24-1000-all-ui-in-hosted.md)),
  and the 7-state interaction contract of
  [`design-system.md`](../design-system.md).
- The owner rule that overflow and collision are fixed in place is now part of
  rule 2: fixing a paid block in its own source is the normal path.

## Consequences

- The hosted repository retires its visual-restyle guard
  (`scripts/paid-overrides.mjs`, which failed a PR that restyled a paid part
  without an approved exception). The paid-source list and the patch ledger
  stay checked, since the no-public guards and patch re-application depend on
  them. The approved exceptions it recorded are kept as history in the hosted
  `patches/README.md`.
- The hosted PR visual-evidence check requires the visual comparison to name a
  top-product reference (ChatGPT, Codex, Claude, Claude Code, Capy, Linear, or
  a `mobbin.com/screens/` link). A paid block's library demo is no longer a
  reference.
- Living docs that stated the as-shipped rule (`AGENTS.md`, `rules.md`,
  `design-system.md`, `components.md`, `review-checklist.md`, the PR
  template and others) are rewritten to this rule in the same change.
- Historical decisions and the frozen [`decisions.md`](../decisions.md) keep
  their text.
