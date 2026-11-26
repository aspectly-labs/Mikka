# Paid blocks are themed by Mikka's tokens, not kept on their own defaults

- Date: 2026-11-25 16:30 UTC
- **Status:** Superseded in part by [2026-11-26-0200](2026-11-26-0200-best-practice-review-copy.md) (rule 4: conflicts are resolved by changing the earlier rule, not listed for Alex)
- Source: Alex, 2026-11-25, after the page-by-page benchmark against Capy and other top agent products: asked whether
  「付费块内部不动」 is right, compared it with Capy (one set of design primitives across the whole app), and approved
  the change: 「去做吧」.
- Rule: replaces the visual half of the as-shipped rule; `AGENTS.md` (mikka-hosted-ui) 「付费块：组件来源，不是视觉标准」.
- Replaces: [2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md) — its rule that paid blocks keep their own
  colours, radii, borders, density and motion, and that a block's native look wins over Mikka's rules.

## Why

Capy's renderer is built from one set of primitives on one token table (control heights, icon sizes, surfaces,
purpose radii, intent colours, motion). Mikka combined three paid libraries (BoardUI Pro, affectUI, beUI Pro), each
kept on its own defaults by the as-shipped rule. The result was three visual dialects in one app: `--muted` and
`--accent` meaning a background in one place and a text tone or brand blue in another, white cards on white panels,
blue and black switches side by side, a 760px column in the middle of full-width list pages. The benchmark found these
seams on almost every page.

The blocks already expose theme hooks (affectUI's 27 `--aui-*` custom properties for surfaces, ink, borders, radii,
primary and accent colours, focus, shadows, font and easing), so they can follow Mikka's tokens without editing their
source.

## Decision

1. **Mikka's tokens are the single visual standard.** They follow Capy's token families (control heights, icon sizes,
   surfaces with a panel/card split, purpose radii, text tones, intent colours, motion durations, touch sizes).
2. **Paid blocks are a component source, not a visual standard.** Each block is themed through its own hooks
   (affectUI `--aui-*`, BoardUI semantic tokens, beUI's variables), set to Mikka's tokens in the token layer. Setting
   theme variables is not a restyle and needs no exception.
3. **What a theme hook cannot reach** (layout such as a block's fixed column width or its own header, a hard-coded
   colour) is changed by a patch in `patches/` and recorded in `paid-overrides.json` and `AGENTS.md`, as before.
4. **Benchmark first, not precedent.** Whether a page or control should exist, and how it looks, is decided against
   the user's mental model and top agent products (Capy, Codex/ChatGPT, Claude, Cursor, Devin, Perplexity). An earlier
   Mikka design or decision record is not a reason to keep something; conflicts are listed for Alex to decide.

Unchanged: paid source stays in `mikka-hosted-ui` only; licence keys stay in Infisical; copy still goes through
`messages/*.json` and `docs/design/copy.md`.
