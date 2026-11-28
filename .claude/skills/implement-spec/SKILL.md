---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on `main`, one PR per ticket, with every ticket resolved the way the issue tracker closes work. Never collect tickets on an integration branch or merge them into one batch PR (ADR `docs/design/decisions/2026-11-27-1930-no-batch-prs.md`).

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Start every subagent with a fresh context window.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Use a fresh **implementer subagent** for each ticket on the frontier, each in its own worktree on its own branch cut from the latest `main`. Each implementer subagent:
   - calls the Skill tool with `tdd` to build the ticket;
   - opens its own PR to `main`, closing that ticket, and keeps `main` green on its own (a flag or an unused-until-wired path when the feature isn't complete yet).

4. Review each ticket's PR with `code-review`, fix its findings in that PR, and merge it once CI is green.

5. When a merge changes the **frontier** of available tickets, kick off **implementer subagents** for the new tickets from the new `main`. This allows for maximum concurrency.

6. Once every ticket's PR has merged, close the spec.

7. Clean up all **implementer subagent** worktrees.
