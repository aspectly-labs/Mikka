# Best practice wins, screenshots get an independent review, UI copy has no padding, agent products are the benchmark

- Date: 2026-11-26 02:00 UTC
- **Status:** Accepted
- Source: Alex, 2026-11-25, as standing rules for every session and every agent: 「所有的事情都按照这个 best practice
  去做；如果现有规则跟 best practice 有冲突，立刻更改现有规则」; 「截图发给我之前肯定要交给独立 subagent 去审。这是全局的要求」;
  on UI copy, padded labels such as 「模型（用于新线程）」 are not acceptable and copy is written as Capy/Codex ship it;
  and 「肯定是优先对标 Agent 的产品啊，没有的话你不要去做呀」.
- Rule: `AGENTS.md` 「Standing rules」 (this repository and `mikka-hosted-ui`), [copy.md](../copy.md) C-11,
  [Handbook](../../engineering/HANDBOOK.md#independent-screenshot-review) 「Independent screenshot review」.
- Research: C-11 was checked against Apple HIG (Writing), Material Design (Writing; text fields), the Microsoft Writing
  Style Guide and Windows writing style, GOV.UK (Service Manual; Design System text input and question pages), Nielsen
  Norman Group (UI copy; tooltip guidelines; placeholders), Atlassian, Shopify Polaris, GitLab Pajamas and Elastic EUI.
  Sources and quotes are in copy.md's 「来源」 table.

## Decision

1. **Best practice wins.** Everything follows frontend/UX best practice and what top products ship. When an existing
   rule, decision record or `AGENTS.md` exception conflicts with it, the rule is replaced in the same change (the record
   is superseded, the Tier 1 standard rewritten), not worked around. Questions that best practice or top products
   already answer are not taken to Alex; only questions with no evidence are.
2. **Independent screenshot review.** Before any UI screenshot is sent to Alex, a subagent that did not make the change
   reviews it against the reference (Capy/Codex source and the top-product screenshots) and the rules (`design-system.md`,
   `rules.md`, `copy.md`). The author fixes each finding or lists it with its reason. Self-review does not count. This
   applies to every session and every agent.
3. **UI copy has no padding (C-11, sharpened).** Labels are only labels and values only values. The research kept three
   parts as written and corrected two:
   - Kept: short labels that are not sentences and carry no full stop or colon; no restating what is already on screen;
     no 「将会」「用于」「可以」 explanations in labels — every guide checked says this.
   - Corrected, parentheses: none in labels, buttons, titles or values, except the optional-field mark 「（选填）」 /
     `(optional)` (GOV.UK, Polaris) and the first expansion of an abbreviation (GitLab). Units go into the field suffix,
     「推荐」 into a badge, plurals into ICU `plural`.
   - Corrected, explanations: what a person needs to act (format, limits, consequences, where to find it) stays visible
     in one short line under the field or in the error text, never only in a tooltip (NN/g, GOV.UK, Polaris); other
     explanation goes in a tooltip or nowhere; needing to explain how the interface works means fixing the interface.
   - UI copy is reviewed with the `unslop` copy pass and `kubai-design-tips` design-system pass (and `design:ux-copy`
     where available), with copy.md winning a conflict.
   - `scripts/check-copy.mjs` now ratchets the two parts a script can decide without false positives: no full stop at
     the end of a label, button, tab or title, and no parenthetical note in one. Existing strings are baselined in
     `scripts/check-copy-baseline.json`; only new ones fail.
4. **Benchmark agent products first:** Capy, ChatGPT/Codex, Claude, Cursor, Devin, Perplexity. Category leaders (Linear,
   Jira, GitHub, Vercel …) are a reference only for a surface no agent product has. A feature no agent product has is not
   built unless Alex asks for it.
5. **No sprints or cycles (迭代).** No agent product has them, so they are not built (decided by rule 4).

## Supersedes

- [2026-11-25-1630](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md) in part: rule 4's 「conflicts are listed for
  Alex to decide」. A conflict with best practice or the benchmark is now resolved by changing the earlier rule; only a
  question with no evidence goes to Alex. The rest of 1630 stands.
