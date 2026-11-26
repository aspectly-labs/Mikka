# Acceptance lives in the task description and the PR tab; environments get E2B snapshots, built the top products' way

- Date: 2026-11-26 02:10 UTC
- **Status:** Accepted
- Source: decided from evidence under Alex's standing rules of 2026-11-25
  ([2026-11-26-0200](2026-11-26-0200-best-practice-review-copy.md) rules 1 and 4: questions the benchmark answers are
  not handed to Alex). Evidence: the acceptance research (part B of the 2026-11-25 「环境快照 vs 模板；软件工厂里的验收」
  benchmark): Warp Factories, Factory.ai, Vercel eve's software-factory template (Foreman), 8090, Devin, Codex cloud,
  Capy, plus Linear, GitHub and Jira for the surfaces no agent product has. This closes W4 left open in
  [2026-11-26-0110](2026-11-26-0110-pages-environments-from-benchmark.md). Alex then approved both, relayed by the
  coordinator on 2026-11-25: acceptance as recommended (superseding 2026-11-04's Artifact window), and environment
  snapshots yes, done the top-products way, E2B only for now. This also closes E7 left open in 0110.
- Rule: [rules.md](../rules.md) R-56, R-85, R-89; `mikka-hosted-ui` `AGENTS.md` 「A task as Capy's」.
- Count: 「n/m」 is n of the m products compared.

## Decision

### Acceptance

1. **Criteria are a checklist in the task description.** The plan agent writes it first; a person can edit it before and
   during the work. It stays stored in the existing acceptance structure, because the independent checks judge each
   criterion against it. Evidence 6/10 keep criteria in the description or spec (Linear, Jira, 8090, Factory.ai
   delegation, Warp's spec PR, Foreman's analysis); 0/10 have a separate acceptance section on the task page.
2. **Results and the decision are in the right-column PR tab.** Each criterion shows passed or failed with its evidence
   and the verification that produced it, expandable in place, beside the PR's checks and review; the actions are
   **合并** (primary) and **要求修改** (focuses the composer). On phones the same content is a page pushed from the PR
   (0110 rule 20). Evidence 8/10 put results with the PR or the conversation (Warp, Factory.ai, Foreman, Devin, Codex,
   Capy, GitHub, Jira's Development panel); 10/10 make the merge the person's decision.
3. **The task page keeps one property row** for this, in the BoardUI property style, e.g. 「PR 待审 · 3 项已检查 · 1 项未检查
   →」, opening the PR tab. No card under the description and **no step bar**; stage progress lives in 活动 and the
   thread's event lines.
4. **Three terms:** **标准** (the criteria in the description), **检查** (the independent review and verification results
   in the PR tab), **合并** (the person's action). The button 「验收并合并」 becomes 「合并」; merging still uses the
   person's own GitHub identity, bound to the candidate SHA, as 2026-10-30-2307 decided.

### Environment snapshots

5. **A snapshot build may use the environment's secrets during setup only,** as Codex (secrets available to the setup
   script, removed before the agent runs) and Cursor (「User secrets … don't become part of a shared snapshot」) do.
   Secrets are removed before the snapshot is taken; personal secrets, subscription logins, GitHub credentials and
   device identity never enter a snapshot (the existing credential cleanup applies).
6. **Environments get snapshots (Alex, approved).** Built the way top products build them (Capy, Codex, Cursor, Devin,
   Jules; 5/7): one snapshot per environment, taken after the repositories are cloned and setup has run; a failed build
   keeps the last good snapshot; the environment page shows the snapshot's state and 「构建快照」; a change to setup,
   repositories, variables or secrets marks it for rebuild. **E2B only for now** (filesystem snapshots on the person's
   own E2B project); Cloudflare task machines come later.
7. **调研中:** the compute architecture (eve on Cloudflare vs E2B desktops and threads) is being researched separately
   and is not decided here.

## Supersedes

- [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md) in part: 「The acceptance page」 — acceptance no longer
  opens in the Artifact window, and the task page's 验收 button goes; the Factory flow itself stays.
- [2026-11-08-2328](2026-11-08-2328-factory-visual-evidence-required.md) in part: rule 6's acceptance-report Artifact as
  the place evidence is shown; the evidence requirements stay and the evidence is shown in the PR tab.
- [2026-10-30-2307](2026-10-30-2307-acceptance-is-the-merge.md) in part: the label 「验收并合并」 (now 「合并」); the merge
  semantics stay.
