## What and why

<!-- One or two sentences. Link MIK-xx / #nn. -->

## UI changes

<!-- Delete this section if the PR has no UI. A change under components/, apps/frontend/, the desktop renderer, or messages/ must include a screenshot or recording below. CI rejects the pull request otherwise. Opt out only with `Screenshots: not needed: <reason>`. -->

| Before | After |
| ------ | ----- |
|        |       |

- For changes to a business entity, field, state or command, list its entry points and link the shared implementation and behavior test.
- Review page (Artifact):
- Accepted Figma frames:
- Rules touched (docs/design/rules.md ids):
- Top-product reference per changed surface (ChatGPT / Codex, Claude / Claude Code, Capy, Linear: a Mobbin link or the unpacked app/source path), with every remaining difference and its reason; paid screenshots on a private page (docs/design/decisions/2026-11-27-1409-top-products-over-paid-blocks.md):
- [ ] `docs/review-checklist.md` passes
- [ ] Docs updated in this PR (rules / components / decisions / glossary / spec), or not needed

## Data and migrations

<!-- Delete if none. Idempotent? Tested on a real Postgres? -->

## How it was checked

<!-- Run `pnpm local:plan`; local red→green first, then `pnpm local:ready` and `pnpm local:mark-ready`. The ignored local record is not automatic remote proof. -->

- Local source HEAD SHA:
- Affected tests selected (Nx) and actual commands/exits:
- Local runtime / API / CLI / PG / UI outcome (expected vs observed):
- Product acceptance report or exact non-product exception:
- CI run and final result (after Ready):

## Acceptance

<!-- Choose one declaration and replace every placeholder. Evidence correctness
is reviewed independently; the deterministic check validates this declaration.

Runtime: E2B / device / both
Model: scripted (LiteLLM boundary; no real model calls)
Commit: full tested SHA
Fixtures: replay or scripted scenario names
Items: local-loop item numbers and passed/total count
Evidence: report link and, for UI files, a screenshot image link

OR
Not needed: concrete reason, such as docs only or a behavior-preserving refactor
with named regression coverage.

OR, only for OAuth, GitHub/Slack App installation, payments, or push:
Production only: external dependency that cannot be checked locally
Owner: acceptance owner
Internal account: authorized internal account alias (no credentials)

UI changes still need a screenshot unless Not needed explains the exemption.
-->
