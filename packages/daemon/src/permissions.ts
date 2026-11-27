// A run's permissions (ADR 0009, ADR 0028). The policy arrives with each
// run's assignment (`RunAssignment.policy`). Agents run with full access and
// never ask anyone for permission (ADR 2026-11-27-1615): no workspace setting
// restricts a run, and an older server's `deny` for dependency installs,
// writes or the network is ignored. What still takes an action away is set by
// the host: a read-only independent check (ADR 0046), the daemon's own push
// and the computer grant. This file applies them: the decision for one
// action, whether the daemon pushes, the rules a CLI that has its own
// permission model is given, and the lines that tell the agent what it may do.
import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

import {
  defaultRunPolicy,
  PERMISSION_ACTIONS,
  PERMISSION_DEFAULTS,
  READ_ONLY_DENIED,
  type PermissionAction,
  type PermissionDecision,
  type RunPolicy,
} from "@mikka/protocol/agent-policy"


export { PERMISSION_ACTIONS, PERMISSION_DEFAULTS }
export type { PermissionAction, PermissionDecision, RunPolicy }

export interface PermissionContext {
  /** Trusted host assignment only, never model-supplied. Defaults when absent. */
  policy?: RunPolicy
}

export function decide(
  action: string,
  context: PermissionContext = {}
): PermissionDecision {
  const policy = context.policy
  // A read-only check (ADR 0046) changes nothing: it reads the worktree,
  // reports, and stops. It takes no action it does not know either.
  if (policy?.readOnly && (!Object.hasOwn(PERMISSION_DEFAULTS, action) || READ_ONLY_DENIED.includes(action as PermissionAction)))
    return "deny"
  // The computer grant is the host's (workspace computer policy, the device's
  // own consent); an older server's assignment without one reads as allow.
  if (action === "computer_use") return policy?.permissions.computer_use ?? "allow"
  // Everything else is allowed, the agent's own git push included (decision
  // 2026-11-02-1600); the daemon's own push is `pushDecision`.
  return "allow"
}

/** The policy a run applies: what the server sent, or the defaults. */
export function runPolicy(sent: RunPolicy | undefined): RunPolicy {
  return sent ?? defaultRunPolicy()
}

/** Project commands run inside the host-enforced sandbox. Publishing is a
 * separate daemon capability, never a prerequisite for building or testing.
 * Every run has a shell except a read-only check, which is file-only. */
export function rawCliShellAvailable(policy: RunPolicy): boolean {
  return !policy.readOnly
}

/**
 * Whether the daemon itself pushes a verified run branch, for a run whose agent
 * does not deliver it: the server sends `allow` for a run with a task branch.
 * The agent's own push is never withheld (decision 2026-11-02-1600).
 */
export function pushDecision(policy: RunPolicy): { push: boolean; note?: string } {
  // A read-only check (ADR 0046) never pushes: it exists to look at what the
  // implementation run already pushed, not to add to it.
  if (policy.readOnly)
    return { push: false, note: "A read-only check does not push" }
  const decision = policy.permissions.git_push
  if (decision === "allow") return { push: true }
  if (decision === "deny")
    return { push: false, note: "Push is turned off for this run" }
  return { push: false, note: "This run has no task branch to push" }
}

/** Shell commands that add or install dependencies (first word, verb), named
 * only in Claude Code's own CLI rules below. */
const INSTALL_COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["npm", ["install", "i", "add", "ci"]],
  ["pnpm", ["install", "i", "add"]],
  ["yarn", ["install", "add"]],
  ["bun", ["install", "i", "add"]],
  ["pip", ["install"]],
  ["pip3", ["install"]],
  ["uv", ["add", "pip"]],
  ["poetry", ["add", "install"]],
  ["cargo", ["add", "install"]],
  ["go", ["get", "install"]],
  ["gem", ["install"]],
  ["brew", ["install"]],
]

/**
 * Claude Code permission rules for the run (`--settings` `permissions`).
 * There are no ask rules: the run never waits for a person (ADR
 * 2026-11-27-1615), and only a read-only check is denied anything. `git
 * push` is the agent's own judgment, as with the person's own `gh auth
 * login` (decision 2026-11-02-1600): no rule withholds it.
 */
export function claudePermissionRules(policy: RunPolicy): {
  allow: string[]
  ask: string[]
  deny: string[]
} {
  // A read-only check never installs or writes; the sandbox is the authority
  // on writes, these rules just name the intent to the CLI itself.
  if (!policy.readOnly) return { allow: [], ask: [], deny: [] }
  const install = INSTALL_COMMANDS.flatMap(([tool, verbs]) =>
    verbs.map((verb) => `Bash(${tool} ${verb}:*)`)
  )
  return { allow: [], ask: [], deny: ["Bash", "PowerShell", "Monitor", ...READ_ONLY_TOOLS, ...install] }
}

/** Tools that change the worktree, denied to a read-only run (ADR 0046). */
const READ_ONLY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

/**
 * What the agent is told about this run's permissions: full access, except
 * in a read-only check. It is never told to wait for or ask about
 * permission (ADR 2026-11-27-1615).
 */
export function policyInstructions(policy: RunPolicy): string[] {
  if (policy.readOnly)
    return [
      "- This is a read-only check: you may read the worktree but not change it, and you have no shell. Report what you found through `submit`; do not fix anything yourself.",
      "- Network access is open.",
    ]
  return [
    "- You have full access: network access is open, and you may install or add dependencies when the task needs them.",
    "- Work inside that worktree; everything outside it is read-only in this sandbox.",
  ]
}

/**
 * Where a path really points: symlinks in the deepest existing part are
 * resolved, the not-yet-created rest is appended as is.
 */
function realTarget(path: string): string {
  const missing: string[] = []
  let current = path
  for (let hops = 0; ;) {
    try {
      return join(realpathSync(current), ...[...missing].reverse())
    } catch {
      // A dangling symlink: follow it to where the write would land.
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (++hops > 40) return path
        current = resolve(dirname(current), readlinkSync(current))
        continue
      }
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

function inside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Classifies a file write by whether it stays inside the run's worktree,
 * after following symlinks: a link in the worktree that points outside it
 * makes the write `write_outside_repo`.
 */
export function classifyWrite(
  worktree: string,
  target: string
): PermissionAction {
  const root = resolve(worktree)
  const lexical = resolve(root, target)
  const ok =
    inside(root, lexical) && inside(realTarget(root), realTarget(lexical))
  return ok ? "write_in_worktree" : "write_outside_repo"
}
