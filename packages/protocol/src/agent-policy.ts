// Agent permissions and guidance (ADR 0009, ADR 0028). One table shared by
// the server (which stores the workspace's choices and sends them with every
// run), the desktop app (设置 › 功能 › Agents) and the daemon (which applies
// them in the sandbox, the CLIs' own permission rules and its own push).
//
// Agents never ask a human for permission (ADR 2026-11-27-1615): every action
// is `allow` unless a workspace owner or admin explicitly chose `deny`. There
// is no `ask`; a stored or sent `ask` from an older build reads as `allow`.
// Some actions are hard rules, never configurable: the run's worktree is the
// agent's to read and write, project scripts and setup recipes run there, and
// a repo has to be on the device's allow-list before anything starts.
import { z } from "zod"
import { networkDomainsWithin } from "./network-bounds"
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

/** Actions a workspace may set, each with the decisions it may pick. */
export const CONFIGURABLE_PERMISSIONS = {
  install_dependency: ["allow", "deny"],
  // Everything outside the worktree stays read-only in the sandbox either way
  // (ADR 0009, Stage 1 isolation); this choice only changes what the agent is told.
  write_outside_repo: ["allow", "deny"],
  // Stored for older rows; it never withholds the agent's own push with the
  // person's own GitHub credential (decision 2026-11-02-1600).
  git_push: ["allow", "deny"],
  network: ["allow", "deny"],
  computer_use: ["allow", "deny"],
} as const satisfies Partial<
  Record<PermissionAction, readonly PermissionDecision[]>
>
export type ConfigurableAction = keyof typeof CONFIGURABLE_PERMISSIONS
export const CONFIGURABLE_ACTIONS = Object.keys(
  CONFIGURABLE_PERMISSIONS
) as ConfigurableAction[]

/** Hard rules: shown read-only, never stored. */
export const FIXED_PERMISSIONS = {
  read_in_worktree: "allow",
  write_in_worktree: "allow",
  run_project_script: "allow",
  // A repo's setup recipe runs as configured; nobody approves it first.
  run_setup_recipe: "allow",
} as const satisfies Partial<Record<PermissionAction, PermissionDecision>>
export type FixedAction = keyof typeof FIXED_PERMISSIONS

export const PERMISSION_DEFAULTS: Readonly<
  Record<PermissionAction, PermissionDecision>
> = {
  ...FIXED_PERMISSIONS,
  install_dependency: "allow",
  write_outside_repo: "allow",
  // Whether the daemon itself pushes a run's verified task branch: the server
  // sends allow for a run with a task branch. The agent's own git push is never
  // withheld (decision 2026-11-02-1600).
  git_push: "deny",
  // Agents reach the open internet unless a person restricts it in settings
  // (decision 2026-11-01-1230-network-open-by-default).
  network: "allow",
  computer_use: "allow",
}

/**
 * A stored layer's `git_push`, read back as it was stored. Since decision
 * 2026-11-02-1600 it restricts nothing; unset or a legacy ask reads as allow.
 */
export function gitPushRestriction(permissions: unknown): "allow" | "deny" {
  return permissions !== null && typeof permissions === "object" &&
    (permissions as Record<string, unknown>).git_push === "deny" ? "deny" : "allow"
}

export function isConfigurableAction(
  action: string
): action is ConfigurableAction {
  return Object.hasOwn(CONFIGURABLE_PERMISSIONS, action)
}

/** Whether `decision` is one of the choices the action offers. */
export function permissionChoiceAllowed(
  action: ConfigurableAction,
  decision: string
): decision is PermissionDecision {
  return (CONFIGURABLE_PERMISSIONS[action] as readonly string[]).includes(
    decision
  )
}

/** A stored choice for `action`, a legacy `ask` read as `allow`; null when it
 * is not one of the action's choices. */
function storedChoice(action: ConfigurableAction, value: unknown): PermissionDecision | null {
  const decision = value === "ask" ? "allow" : value
  return typeof decision === "string" && permissionChoiceAllowed(action, decision) ? decision : null
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

/** Stored permission choices (`agent_settings.permissions`), all optional.
 * A stored `ask` predates ADR 2026-11-27-1615 (git_push: decision
 * 2026-11-01-1215) and reads as allow. */
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
 * The workspace's default network allow-list when it has set none (ADR
 * 0009: "workspace default, for example npm, GitHub"). Package registries
 * come with "install dependencies: allow", not with this list.
 */
export const DEFAULT_NETWORK_ALLOW: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
]

/** Reachable when installing dependencies is allowed. */
export const PACKAGE_REGISTRY_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
]

/**
 * Actions a read-only run (ADR 0046: the acceptance check) may never take,
 * whatever the workspace chose. Reading the worktree is all it does; it
 * reports what it found through its submit and changes nothing.
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
  /** The workspace layer of the domain allow-list (ADR 0009). */
  networkAllow: z.array(z.string().min(1).max(253)).max(MAX_NETWORK_DOMAINS),
  /** Host-derived worker/workspace ceiling; even network=allow cannot widen it. */
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
 * A per-person or per-scope mode (设置 › Agent personalization):
 *
 * - `read_only`: the run reads and reports but changes nothing — the policy
 *   the read-only acceptance check already gets (ADR 0046), applied to every
 *   run this person's or scope's work goes through.
 * - `ask`: the legacy spelling of "no mode" (the scope's policy, unchanged).
 *   It never asked anyone, and there are no approvals (ADR 2026-11-27-1615);
 *   it is still accepted so stored rows parse and a settings write can clear
 *   `read_only`.
 */
export const APPROVAL_MODES = ["ask", "read_only"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
export const approvalModeSchema = z.enum(APPROVAL_MODES)

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
  for (const action of CONFIGURABLE_ACTIONS) {
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
  if (base.networkCeiling && (!next.networkCeiling || !networkDomainsWithin(next.networkCeiling, base.networkCeiling))) return false
  if (base.readOnly === true && next.readOnly !== true) return false
  return CONFIGURABLE_ACTIONS.every(
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
  permissions?: unknown
  networkAllow?: unknown
  guidance?: string | null
}

/** Only the authenticated host selects the execution environment. */
export type ExecutionEnvironment = 'local' | 'cloud'

/** Permissions with defaults; an invalid stored choice falls back, a legacy
 * `ask` reads as allow. */
export function resolvePermissions(stored: unknown, _environment: ExecutionEnvironment = 'local'): RunPermissions {
  const out = {} as Record<ConfigurableAction, PermissionDecision>
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {}
  for (const action of CONFIGURABLE_ACTIONS)
    out[action] = storedChoice(action, record[action]) ?? PERMISSION_DEFAULTS[action]
  return out as RunPermissions
}

export function resolveNetworkAllow(stored: unknown): string[] {
  if (stored === null || stored === undefined) return [...DEFAULT_NETWORK_ALLOW]
  const parsed = networkAllowSchema.safeParse(stored)
  return parsed.success ? parsed.data : [...DEFAULT_NETWORK_ALLOW]
}

export interface ResolvedAgentSettings {
  policy: RunPolicy
  /** Guidance appended to every assignment; null when there is none. */
  guidance: string | null
  /** Where the guidance came from. */
  guidanceFrom: "team" | "workspace" | null
}

/**
 * The settings a run gets: the workspace row (or defaults), with the team's
 * guidance in place of the workspace's when the team set its own. A team's
 * empty guidance means "none for this team"; null inherits.
 */
export function resolveAgentSettings(
  workspace: StoredAgentSettings | null | undefined,
  team?: StoredAgentSettings | null,
  environment: ExecutionEnvironment = 'local'
): ResolvedAgentSettings {
  // A workspace network allow-list no longer narrows a cloud run to that list
  // (that was network `ask`); host and scope ceilings still bound it.
  const permissions = resolvePermissions(workspace?.permissions, environment)
  const teamGuidance = team?.guidance
  const workspaceGuidance = workspace?.guidance ?? null
  const fromTeam = teamGuidance !== null && teamGuidance !== undefined
  const text = (fromTeam ? teamGuidance : workspaceGuidance)?.trim() ?? ""
  return {
    policy: {
      permissions,
      networkAllow: resolveNetworkAllow(workspace?.networkAllow),
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
