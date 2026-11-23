# Run delegation: `delegate_subagent` (#3089)

> Design contract for the first landed increment. Issue #3089 / epic #3076:
> a native Claude Code or Codex run must be able to delegate bounded work to a
> sub-agent through Mikka's existing dispatch and claim authority — the Capy
> "delegated run on another authorized machine" capability — without a second
> scheduler, state machine, per-tool approval layer or new launch site.

## Contract

`delegate_subagent` is a worker MCP tool. The daemon's `mikka` server advertises
its fixed schema and forwards the call to `/api/mcp` with the run token, exactly
like `record_decision`/`pr_status`. The server is the only authority; the agent
supplies `task` (bounded direction, ≤4000 chars) and `requestKey` (required
idempotency key, ≤140 chars). Nothing else is agent input.

The server creates a **child `agent_runs` row bound to the calling run**:

- Same `issueId`, `workspaceId`, `agentId`, `deviceId`, `deviceRepoId`, `botId`
  as the parent — verified inside the admission transaction, not trusted from
  the call.
- Model, `modelDispatch`, subscription binding, API key id, `agentProfile`,
  `policyCeiling`, `readOnly` and `pinnedDeviceId` are inherited from the
  parent's frozen `agentDefinition`. A delegated run can never widen the
  parent's credential or policy scope.
- Parent/child linkage is durable and immutable: the child's frozen definition
  records `agentDefinition.delegation = { parentRunId }`, like
  `repositoryAdmission` (admission-time provenance, outside the worker digest).
- The prompt is the normal run shape (`runPromptParts`): task title, task text,
  the Agent's own instructions, and the agent's `task` as the note.
- The child is an ordinary queued run. Its device claims it through the normal
  `/v1/devices/:deviceId/runs/:runId/claim` route with the same admission,
  subscription, credential and execution-identity checks — and the same native
  launch builders, so the child inherits `bypassPermissions` /
  `approvalPolicy: never` like every claimed run. There is no second claim path.
- `dispatchKey = delegate:<parentRunId>:<requestKey>` reuses the existing
  request-key replay contract: a retry returns the already-created child.

## Admission rule

`acceptLocalRun` keeps its one-live-run-per-issue rule with a single exception:
when `input.delegation` is set, the task's active set must be exactly the
declared parent. A live sibling (another delegated child or an unrelated run)
refuses as `runAlreadyActive`, so **at most one delegated run per task is live
at a time**. The parent must be live, un-stopped, not itself a delegated child
(no grandchild chains this increment), and match the child's Agent, device,
repository, Bot, workspace and harness. At most 8 delegated children may exist
per parent run (`delegationLimit`).

Because the parent's destination evidence travels with the child, a
task-destination dispatch (Factory/chat admission) stays bound to the device
the person chose; the child inherits the parent's `requestEventId` and marks
the admission `continuation`, so the replay shortcut that would name the parent
as the run cannot fire. Environment/baseBranch carry over through
`profileSourceRunId = parent.id`, the same path a thread continuation uses.

`queueDelegatedRun` resolves all dispatch inputs from the parent run row and
refuses cheaply (no issue, device not local, run not live, delegation marker
already present) before `queueAdmittedRun` re-runs the full admission:
Agent/device enabled, harness, repository binding, credential resolution,
execution-identity freeze, profile admission and the actives gate.

## Landed scope and deferred work

Landed now: daemon tool + proxy, worker tool, local-device parent path,
parent/child linkage, bounded serial delegation, idempotent retry.

Deferred, by design: parents on cloud task machines (`queueCloudRun` path —
needs the same marker plus its own actives serialization), parallel children,
cross-device targets, delegated-child delegation, automatic child cancellation
when the parent stops, and any UI grouping of child threads.
