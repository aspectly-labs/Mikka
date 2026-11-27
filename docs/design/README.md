# Design docs: start here

This folder holds Mikka's product and backend design: the words, the
orchestration model, feature specs that public code implements, and the
backend, product, architecture and process decision records.

UI rules and UI design live in the private hosted repository
(`mikka-hosted-ui/docs/design/`), not here (owner decision, 2026-11-27): the
design system, `rules.md`, `components.md`, `copy.md`, `brand.md`, the
information architecture, UI-only decision records, design research and
screenshots. Research derived from competitor apps is in
`mikka-hosted-ui/docs/research/` and `mikka-hosted-ui/docs/tasks/`. Start UI
work at `mikka-hosted-ui/docs/design/README.md`.

## Read in this order

1. [`glossary.md`](glossary.md): what bot, chat, task and thread mean.
2. [`orchestration.md`](orchestration.md): models, Agents, machines,
   scheduling, credentials in runs and who pays.
3. [`decisions/`](decisions/README.md): read the **applicable latest,
   non-superseded** decision when a behavior is disputed. The frozen
   [`decisions.md`](decisions.md) is historical context, **not** a live
   instruction source.
4. The feature's own spec in this folder, if it has one.
5. [`../review-checklist.md`](../review-checklist.md): run it before you ask
   for review.

## When sources disagree

Higher wins. Fix the lower source in the same PR, or say in the PR which
source is now out of date and who owns it.

| # | Source | Decides |
| --- | --- | --- |
| 1 | Alex's latest explicit decision, reflected in current `AGENTS.md`, active rules and current source | Anything it names; historical decision records never override a later decision |
| 2 | `glossary.md` | Words and the bot / chat / thread model |
| 3 | The latest applicable record in `decisions/` | The behavior it decides |
| 4 | Feature specs in this folder | What the feature does and its stated evidence |

Chat messages, project memory and handoff notes are not sources. Record a
lasting decision in `decisions/` (backend, product, architecture, process) or
in `mikka-hosted-ui/docs/design/decisions/` (UI only). Feature specs record
requirements and their stated implementation evidence; acceptance of a design
does not establish that it shipped. Dated audits and research keep their
original revision and findings.

There is one UI ([decision](decisions/2026-11-08-2133-one-ui.md)), and all of
its code lives in `mikka-hosted-ui`
([decision](decisions/2026-11-24-1000-all-ui-in-hosted.md)).

## Where things live and who keeps them

| What | Where | Kept by |
| --- | --- | --- |
| Words | `docs/design/glossary.md` | Whoever changes the model, in the same PR |
| Backend, product and process decisions | `docs/design/decisions/`, one file each (`decisions.md` is frozen) | Whoever hears the decision, the same day |
| UI rules, design system, components, copy, brand, UI decisions | `mikka-hosted-ui/docs/design/` | Frontend threads, after Alex decides |
| Enforced UI rules that run here | `scripts/lint-ui.mjs`, `scripts/*-policy.mjs`, `ui-policy.json` | Frontend threads |
| UI copy | `messages/zh-CN.json`, `messages/en.json` | The thread that writes the UI |
| Feature specs | `docs/design/<feature>.md` | The feature's thread |
| Review and done | `docs/review-checklist.md` | Any thread; Alex decides changes to the definition of done |

Project memory keeps only context that does not belong in the repo (Figma
node ids for work in progress, open questions, who is doing what).
