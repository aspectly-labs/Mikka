// A run's policy and guidance (ADR 0009, ADR 0028), shared by the server
// (which sends it with every run) and the daemon (which applies it in the
// sandbox, the CLIs' own permission rules and its own push).
//
// Agents run with full access and never ask a human for permission (ADR
// 2026-11-27-1615). No workspace, team, project or person restricts a run:
// there is no `ask`, no admin `deny`, no network list and no read-only mode.
// Stored choices from older builds still parse and restrict nothing. What
// remains is set by the host only: a read-only independent check (ADR 0046),
// whether the daemon itself pushes a task branch, and the computer grant.
// The run's worktree, the sandbox's read-only outside and the device's repo
// allow-list are boundaries, not choices.
import { z } from "zod"
export { intersectNetworkDomains, networkDomainsWithin } from "./network-bounds"

export const PERMISSION_ACTIONS = [
  "read_in_worktree",
  "write_in_worktree",
  "run_project_script",
  "run_setup_recipe",
  "install_dependency",
  "write_outside_repo",
  "git_push",
  "network",
  "computer_use",
] as const
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export const PERMISSION_DECISIONS = ["allow", "deny"] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** A decision as an older build may have stored or sent it: `ask` predates
 * ADR 2026-11-27-1615 and reads as `allow`. Nothing writes `ask` any more. */
const legacyDecision = z
  .enum(["allow", "ask", "deny"])
  .transform((value): PermissionDecision => value === "ask" ? "allow" : value)

/** The permission fields a run policy carries on the wire. Only the host
 * fills them; released daemons still require every field. */
export const RUN_POLICY_ACTIONS = [
  "install_dependency",
  "write_outside_repo",
  "git_push",
  "network",
  "computer_use",
] as const satisfies readonly PermissionAction[]
export type RunPolicyAction = (typeof RUN_POLICY_ACTIONS)[number]

/** What a run gets unless the host says otherwise. */
export const PERMISSION_DEFAULTS: Readonly<
  Record<PermissionAction, PermissionDecision>
> = {
  read_in_worktree: "allow",
  write_in_worktree: "allow",
  run_project_script: "allow",
  // A repo's setup recipe runs as configured; nobody approves it first.
  run_setup_recipe: "allow",
  install_dependency: "allow",
  write_outside_repo: "allow",
  // Whether the daemon itself pushes a run's verified task branch: the server
  // sends allow for a run with a task branch. The agent's own git push is never
  // withheld (decision 2026-11-02-1600).
  git_push: "deny",
  network: "allow",
  // The computer grant is the host's (workspace computer policy, the device's
  // own consent); a run without one gets none from this default.
  computer_use: "allow",
}

/**
 * A domain the sandbox proxy matches: `host`, `*.host`, optionally with a
 * `:port`. A bare `*` is not a domain; choosing "allow" for network access
 * is how a workspace opens everything.
 */
export const NETWORK_DOMAIN_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/

export const MAX_NETWORK_DOMAINS = 200
export const MAX_GUIDANCE_LENGTH = 10_000
export const MAX_MODEL_NAME_LENGTH = 120

export const networkDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(NETWORK_DOMAIN_RE)

/** Lower-cased, trimmed and de-duplicated, in the order given. */
export function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(
    Boolean
  )
}

export const networkAllowSchema = z
  .array(networkDomainSchema)
  .max(MAX_NETWORK_DOMAINS)
  .transform(normalizeDomains)

/** Permission choices an older build stored (`agent_settings.permissions`,
 * CLI policy layers), all optional. They still parse so old rows load, and
 * restrict nothing (ADR 2026-11-27-1615); a stored `ask` reads as allow. Only
 * a workspace `computer_use` choice still applies, through the computer
 * grant. */
export const storedPermissionsSchema = z
  .strictObject({
    install_dependency: legacyDecision,
    write_outside_repo: legacyDecision,
    git_push: legacyDecision,
    network: legacyDecision,
    computer_use: legacyDecision,
  })
  .partial()
export type StoredPermissions = z.infer<typeof storedPermissionsSchema>

export const guidanceSchema = z.string().max(MAX_GUIDANCE_LENGTH)

/**
 * Actions a read-only run (ADR 0046: an independent check) may never take.
 * Reading the worktree is all it does; it reports what it found through its
 * submit and changes nothing.
 */
export const READ_ONLY_DENIED: readonly PermissionAction[] = [
  "write_in_worktree",
  "write_outside_repo",
  "run_project_script",
  "run_setup_recipe",
  "install_dependency",
  "computer_use",
]

/** What a run is sent (`RunAssignment.policy`): every choice filled in. An
 * older server's `ask` reads as `allow` (ADR 2026-11-27-1615), except for the
 * daemon's own push below. */
export const runPolicySchema = z.strictObject({
  permissions: z.strictObject({
    install_dependency: legacyDecision,
    write_outside_repo: legacyDecision,
    // Whether the daemon pushes: allow (admitted) or deny; an older server's
    // ask carries no push authority. Never a question to a person.
    git_push: z.enum(["allow", "ask", "deny"]).transform((value): PermissionDecision => value === "ask" ? "deny" : value),
    network: legacyDecision,
    // Older servers omit this field: the host sent no computer for the run.
    computer_use: legacyDecision.optional(),
  }),
  /** Legacy domain allow-list: sent empty, ignored (network is open). */
  networkAllow: z.array(z.string().min(1).max(253)).max(MAX_NETWORK_DOMAINS),
  /** Legacy domain ceiling from stored CLI layers: no longer sent, ignored. */
  networkCeiling: z.array(networkDomainSchema).max(MAX_NETWORK_DOMAINS).optional(),
  /**
   * The run only reads: the worktree is not writable (ADR 0046). It keeps the
   * owner's GitHub credential like any run. Absent from an older server means
   * a normal, writable run.
   */
  readOnly: z.boolean().optional(),
})
export type RunPolicy = z.infer<typeof runPolicySchema>
export type RunPermissions = RunPolicy["permissions"]

/**
 * The harnesses a person may pick a model for. The mock has none: it replays
 * a fixture and never calls a model API.
 */
export const MODEL_HARNESSES = ["claude_code", "codex", "cursor"] as const
export type ModelHarness = (typeof MODEL_HARNESSES)[number]

export const modelHarnessSchema = z.enum(MODEL_HARNESSES)

export function isModelHarness(harness: string): harness is ModelHarness {
  return (MODEL_HARNESSES as readonly string[]).includes(harness)
}

/**
 * One model name as the harness's own CLI takes it (`sonnet`,
 * `claude-sonnet-4-5`, `gpt-5-codex`). It reaches the CLI as a single argv
 * entry, never through a shell, so the only rule is that it is short and not
 * blank; Mikka keeps no list of what each vendor ships.
 */
export const modelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MODEL_NAME_LENGTH)

/** A person's model per harness; a harness left out uses the CLI's default. */
export const modelByHarnessSchema = z
  .strictObject({
    claude_code: modelNameSchema,
    codex: modelNameSchema,
    cursor: modelNameSchema,
  })
  .partial()
export type ModelByHarness = z.infer<typeof modelByHarnessSchema>

/**
 * The stored `model_by_harness` jsonb narrowed to what the schema accepts: a
 * row written by an older build may hold anything, so each entry is checked
 * on its own and a bad one is dropped rather than taking the good ones with
 * it. Unknown harnesses are never read back.
 */
export function resolveModelByHarness(stored: unknown): ModelByHarness {
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {}
  const out: ModelByHarness = {}
  for (const harness of MODEL_HARNESSES) {
    const parsed = modelNameSchema.safeParse(record[harness])
    if (parsed.success) out[harness] = parsed.data
  }
  return out
}

/** The model a run on `harness` was asked to use; null means the CLI's own. */
export function modelForHarness(
  stored: unknown,
  harness: string
): string | null {
  if (!isModelHarness(harness)) return null
  return resolveModelByHarness(stored)[harness] ?? null
}

/**
 * A per-person or per-scope "approval mode" (`ask` / `read_only`) an older
 * build stored. Old rows still parse; the value restricts nothing (ADR
 * 2026-11-27-1615). Read-only is a run role — independent checks, ADR 0046 —
 * not a workspace, team, project or personal setting.
 */
export const LEGACY_APPROVAL_MODES = ["ask", "read_only"] as const
export type LegacyApprovalMode = (typeof LEGACY_APPROVAL_MODES)[number]
export const legacyApprovalModeSchema = z.enum(LEGACY_APPROVAL_MODES)

/** Most permissive first: a stricter decision has the lower number. */
const DECISION_RANK: Record<PermissionDecision, number> = {
  allow: 1,
  deny: 0,
}

/**
 * The policy of a read-only run (ADR 0046: independent checks). It can only
 * take actions away: it denies the configurable actions that change
 * something and marks the policy read-only. Network stays as the workspace
 * set it — a read-only run still has to reach its model's API.
 */
export function readOnlyRunPolicy(policy: RunPolicy): RunPolicy {
  const permissions = { ...policy.permissions }
  for (const action of RUN_POLICY_ACTIONS) {
    if (READ_ONLY_DENIED.includes(action)) permissions[action] = "deny"
  }
  return { ...policy, permissions, readOnly: true }
}

/**
 * Whether `next` is no more permissive than `base`, action by action, and
 * keeps a read-only flag. This is the guarantee `readOnlyRunPolicy` makes,
 * spelled out so a test can hold it against every policy. An action left
 * out (an older server's `computer_use`) counts as allow.
 */
export function isNoLooserThan(base: RunPolicy, next: RunPolicy): boolean {
  if (base.readOnly === true && next.readOnly !== true) return false
  return RUN_POLICY_ACTIONS.every(
    (action) =>
      DECISION_RANK[next.permissions[action] ?? "allow"] <=
      DECISION_RANK[base.permissions[action] ?? "allow"]
  )
}

/**
 * One person's `user_agent_preference` row as stored (ADR 0060). Personal
 * where `StoredAgentSettings` is shared; every field may be missing, and the
 * resolvers below narrow the raw columns rather than trusting them.
 */
export interface StoredUserAgentPreference {
  instructions?: string | null
  defaultHarness?: string | null
  modelByHarness?: unknown
  /** Legacy (`LEGACY_APPROVAL_MODES`): read and ignored. */
  approvalMode?: string | null
}

/** The instructions to append to a brief, trimmed; null when there are none. */
export function resolveInstructions(stored: unknown): string | null {
  const text = typeof stored === "string" ? stored.trim() : ""
  return text.length > 0 ? text : null
}

/** The harness a new issue is delegated to by default, or null for none. */
export function resolveDefaultHarness(stored: unknown): ModelHarness | null {
  return typeof stored === "string" && isModelHarness(stored) ? stored : null
}

/** A settings row as stored; null fields inherit (team rows) or default. */
export interface StoredAgentSettings {
  /** Legacy (`storedPermissionsSchema`): only `computer_use` still applies. */
  permissions?: unknown
  /** Legacy: ignored. */
  networkAllow?: unknown
  guidance?: string | null
}

/** Only the authenticated host selects the execution environment. */
export type ExecutionEnvironment = 'local' | 'cloud'

export interface ResolvedAgentSettings {
  policy: RunPolicy
  /** Guidance appended to every assignment; null when there is none. */
  guidance: string | null
  /** Where the guidance came from. */
  guidanceFrom: "team" | "workspace" | null
}

/** A stored `computer_use` choice: the computer grant's workspace side. */
function storedComputerUse(stored: unknown): PermissionDecision {
  const value = stored && typeof stored === "object" ? (stored as Record<string, unknown>).computer_use : undefined
  return value === "deny" ? "deny" : "allow"
}

/**
 * The settings a run gets: full access (ADR 2026-11-27-1615), with the
 * team's guidance in place of the workspace's when the team set its own. A
 * team's empty guidance means "none for this team"; null inherits. Stored
 * permissions and network lists restrict nothing; only the workspace's
 * `computer_use` choice is kept for the computer grant.
 */
export function resolveAgentSettings(
  workspace: StoredAgentSettings | null | undefined,
  team?: StoredAgentSettings | null,
  _environment: ExecutionEnvironment = 'local'
): ResolvedAgentSettings {
  const teamGuidance = team?.guidance
  const workspaceGuidance = workspace?.guidance ?? null
  const fromTeam = teamGuidance !== null && teamGuidance !== undefined
  const text = (fromTeam ? teamGuidance : workspaceGuidance)?.trim() ?? ""
  return {
    policy: {
      permissions: {
        install_dependency: PERMISSION_DEFAULTS.install_dependency,
        write_outside_repo: PERMISSION_DEFAULTS.write_outside_repo,
        git_push: PERMISSION_DEFAULTS.git_push,
        network: PERMISSION_DEFAULTS.network,
        computer_use: storedComputerUse(workspace?.permissions),
      },
      networkAllow: [],
    },
    guidance: text ? text : null,
    guidanceFrom: text ? (fromTeam ? "team" : "workspace") : null,
  }
}

/** Defaults for a daemon whose server sent no policy (an older server). */
export function defaultRunPolicy(): RunPolicy {
  return resolveAgentSettings(null).policy
}

/** Stable policy input shared by server and daemon execution-evidence hashing. */
export function runPolicyDigestInput(policy?: RunPolicy): string {
  const resolved = runPolicySchema.parse(policy ?? defaultRunPolicy())
  return JSON.stringify(resolved, [...Object.keys(resolved), ...Object.keys(resolved.permissions)].sort())
}
