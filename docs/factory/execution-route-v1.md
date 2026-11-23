# Factory execution route v1 (issue #3081) and execution envelope v1 (issue #3087)

Source of truth: `lib/factory/execution-route.ts` (matrix, resolver, receipt
schema) and `lib/factory/execution-view.ts` (canonical projection). Epic #3076.
Consumers: Factory dispatch, task detail/activity UI, audit reads.

## Execution route contract v1

Every Factory-bound stage run resolves to exactly one execution route before it
is bound, inside the same dispatch transaction as the run freeze and
`bind_run`. The resolved route is frozen on the attempt at
`factory_attempts.output.executionRoute` as its audit receipt.

Declared matrix (place × driver):

| routeId | place | executor | driver |
| --- | --- | --- | --- |
| `cloud.claude_code` | `cloud` | `cf_task_machine` | native Claude Code in the Cloudflare Task Machine |
| `cloud.codex` | `cloud` | `cf_task_machine` | native Codex in the Cloudflare Task Machine |
| `device.claude_code` | `device` | `local_daemon` | native Claude Code on the person's registered device |
| `device.codex` | `device` | `local_daemon` | native Codex on the person's registered device |
| `cloud.eve_factory` | `cloud` | `eve_factory` | third-party provider through the Eve Software Factory adapter |

`place` is derived from the run's own `devices.kind` (`cloud` → `cloud`,
`local` → `device`); `harness` is the run's frozen `agentDefinition.harness`;
`provider` is the selected third-party provider id on the Eve route. Exactly
one of `harness` or `provider` selects a route.

Refusal is explicit, never a fallback: an unmatched place/harness/provider
combination — including `provider` off cloud, `harness` + `provider` together,
or a run with no resolvable place — throws `factoryRouteUnavailable` and rolls
the dispatch back. There is no `auto` place, no harness substitution, no model
swap, and Eve is never injected as a native-harness fallback. Ordinary Bot
chat keeps its existing Eve Agent Runtime and is not a Factory route; Eve is
not a `TaskAgent` value and there is no `eveTasks` table.

Legacy harnesses (`cursor`, `mock`) predate this contract and resolve only as
`device.<harness>` rows with `declared: false`, so previously queued local
runs stay valid; they are never admitted on cloud.

The receipt (`executionRouteSchema`, `version: 1`) records `routeId`, `place`,
`executor`, `harness`, `provider` and `declared`. Attempts written before the
contract derive their route on the read path from the persisted device and
frozen harness instead of being rewritten.

Authorization and availability stay with the existing queue admission checks
(device membership, cloud runtime target, model/subscription selection); the
resolver verifies the admitted result belongs to the matrix rather than
re-deciding admission.

## Canonical execution envelope v1

`GET /api/factory/tasks/[taskId]/execution` returns one projection per task —
the session owner's authorized view only (`factoryHumanWorkspaceResponse`,
same as task detail/activity). It is a read-only projection over
`factory_tasks`/`factory_attempts`, `agent_runs`, `agents`, `devices`,
`factory_candidates`, `thread_machines`, `run_publications` and the run-chain
walk; it adds no table and no second state machine.

Each stage attempt entry carries: `taskId`, `attemptId`, `stage`,
`stageStatus`, `runId`, `threadId` (the run-chain root over retryOf,
`continuesRunId` and question continuations), the route receipt (or a
`derived`/`recorded` `routeSource`), `executor`, `place`, `harness`, `model`,
`agent`, `device`, `sourceSha` (the candidate SHA), `artifacts` (evidence refs
plus the published pull request), `cost` (`thread_machines` compute seconds,
explicitly `unavailable` otherwise) and lifecycle `timers`. A bound run that
fails the owner join reports `runId: null` with `runUnavailable: true`;
unresolvable thread chains report `threadId: null` rather than a guessed
root. Nothing is fabricated.

## Deferred scope

- #3082 (Eve Factory adapter) binds the declared `cloud.eve_factory` route to
  actual third-party runs inside the same FactoryTask lifecycle. The route id
  is reserved and validated by this contract; no adapter is installed here.
- The `execution` envelope is an additive read surface; activity/task-detail
  responses and the stage state machine are unchanged.
- Harness permission contracts (Claude Code bypass permissions, Codex
  approval `never` + danger-full-access) are unchanged and live in their
  adapters, not in this contract.
