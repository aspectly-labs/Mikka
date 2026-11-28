# Start engineering Docker Cloud Sandboxes at Medium

- Date: 2026-11-28
- **Status:** Accepted
- Source: Alex, 2026-11-28; [#3484 decision](https://github.com/aspectly-labs/Mikka/issues/3484#issuecomment-7245126640).
- Rule: [Engineering Handbook — Local-first development discipline](../../engineering/HANDBOOK.md#local-first-development-discipline).

## Decision

For engineering across Mikka, mikka-cloud and mikka-hosted-ui, prefer an existing authorized cloud Linux environment that meets the task's requirements. If Docker Cloud Sandbox (Docker Agentic Platform) is needed, start at Medium, preferably by reusing an existing released sandbox. Medium is the default minimum starting tier: do not start on Small or require a Small failure before using Medium. Escalate to Large only when Medium's observed resource or capability limitations prevent the required work. Stop the sandbox when the work is finished and verify the stopped state. Existing budget, authorization, isolation, and local-first verification requirements remain in force.

## Rationale

In [#3486](https://github.com/aspectly-labs/Mikka/issues/3486#issuecomment-7243596643), a complete API build failed in the 4 GiB Small engineering sandbox. A targeted diagnostic on the same candidate observed SIGKILL and an increased cgroup OOM kill count. Repeated environment preparation and failed builds waste engineering time and compute. This decision supersedes Small-first instructions in earlier issue bodies, handoffs and private engineering guides; historical evidence remains unchanged.

## Scope

Engineering sandbox sizing only. This decision does not change product/user cloud-computer tiers, E2B task-machine prices or sizes, Cloudflare CI workloads, production resource allocations, or existing release gates.
