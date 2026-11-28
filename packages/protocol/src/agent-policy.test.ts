import { describe, expect, it } from "vitest"

import {
  LEGACY_APPROVAL_MODES,
  defaultRunPolicy,
  isNoLooserThan,
  legacyApprovalModeSchema,
  modelForHarness,
  networkAllowSchema,
  PERMISSION_ACTIONS,
  PERMISSION_DEFAULTS,
  READ_ONLY_DENIED,
  readOnlyRunPolicy,
  resolveAgentSettings,
  resolveDefaultHarness,
  resolveInstructions,
  resolveModelByHarness,
  RUN_POLICY_ACTIONS,
  runPolicyDigestInput,
  runPolicySchema,
  storedPermissionsSchema,
} from "./agent-policy"
import { runAssignmentSchema } from "./device"

describe("run policy compatibility", () => {
  it("rejects unsupported policy fields and actions", () => {
    const policy = defaultRunPolicy()
    expect(runPolicySchema.safeParse(policy).success).toBe(true)
    expect(runPolicySchema.safeParse({ ...policy, schemaVersion: 999 }).success).toBe(false)
    expect(runPolicySchema.safeParse({ ...policy, permissions: { ...policy.permissions, new_restricted_action: "deny" } }).success).toBe(false)
  })
})

describe("full access (ADR 2026-11-27-1615)", () => {
  it("allows every action by default; only the daemon's own push waits for the host", () => {
    expect(PERMISSION_DEFAULTS).toEqual({
      read_in_worktree: "allow",
      write_in_worktree: "allow",
      run_project_script: "allow",
      run_setup_recipe: "allow",
      install_dependency: "allow",
      write_outside_repo: "allow",
      git_push: "deny",
      network: "allow",
      computer_use: "allow",
    })
    expect(RUN_POLICY_ACTIONS.every(action => PERMISSION_ACTIONS.includes(action))).toBe(true)
  })

  it("reads every stored choice and network list as no restriction", () => {
    const stored = { install_dependency: "deny", write_outside_repo: "deny", git_push: "deny", network: "deny" }
    // Old rows still parse, including a legacy ask.
    expect(storedPermissionsSchema.safeParse(stored).success).toBe(true)
    expect(storedPermissionsSchema.parse({ network: "ask" })).toEqual({ network: "allow" })
    for (const environment of ["local", "cloud"] as const) {
      const { policy } = resolveAgentSettings({ permissions: stored, networkAllow: ["only.example.com"] }, undefined, environment)
      expect(policy).toEqual({ permissions: { install_dependency: "allow", write_outside_repo: "allow", git_push: "deny", network: "allow", computer_use: "allow" }, networkAllow: [] })
    }
  })

  it("keeps only the workspace's computer choice, for the computer grant", () => {
    expect(resolveAgentSettings({ permissions: { computer_use: "deny" } }).policy.permissions.computer_use).toBe("deny")
    expect(resolveAgentSettings({ permissions: { computer_use: "ask" } }).policy.permissions.computer_use).toBe("allow")
    expect(resolveAgentSettings(null).policy.permissions.computer_use).toBe("allow")
  })

  it("reads an older server's ask as allow, and its push ask as no push", () => {
    const sent = runPolicySchema.parse({ permissions: { install_dependency: "ask", write_outside_repo: "ask", git_push: "ask", network: "ask", computer_use: "ask" }, networkAllow: [] })
    expect(sent.permissions).toEqual({ install_dependency: "allow", write_outside_repo: "allow", git_push: "deny", network: "allow", computer_use: "allow" })
  })

  it("still parses stored approval modes, which change nothing", () => {
    expect(LEGACY_APPROVAL_MODES).toEqual(["ask", "read_only"])
    expect(legacyApprovalModeSchema.parse("read_only")).toBe("read_only")
    expect(legacyApprovalModeSchema.safeParse("autonomous").success).toBe(false)
  })

  it("normalizes a legacy domain list and refuses a bare wildcard", () => {
    expect(
      networkAllowSchema.parse([" NPMJS.org ", "*.github.com", "npmjs.org"])
    ).toEqual(["npmjs.org", "*.github.com"])
    expect(networkAllowSchema.safeParse(["*"]).success).toBe(false)
  })
})

describe("resolveAgentSettings", () => {
  it("lets a team replace the workspace guidance, or clear it", () => {
    const workspace = { guidance: "Write tests.", networkAllow: [] }
    expect(resolveAgentSettings(null).guidance).toBeNull()
    expect(resolveAgentSettings(workspace).guidance).toBe("Write tests.")
    expect(resolveAgentSettings(workspace, { guidance: null })).toMatchObject({
      guidance: "Write tests.",
      guidanceFrom: "workspace",
    })
    expect(
      resolveAgentSettings(workspace, { guidance: "Use Rust." })
    ).toMatchObject({ guidance: "Use Rust.", guidanceFrom: "team" })
    expect(resolveAgentSettings(workspace, { guidance: "  " })).toMatchObject({
      guidance: null,
      guidanceFrom: null,
    })
  })

  it("travels in the run assignment, and an older assignment without computer_use grants nothing new", () => {
    const policy = resolveAgentSettings(null).policy
    const assignment = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "p1", baseBranch: "main", harness: "mock", prompt: "x" }
    expect(runAssignmentSchema.parse({ ...assignment, policy }).policy).toEqual(policy)
    const legacy = { ...policy, permissions: { ...policy.permissions } }
    delete legacy.permissions.computer_use
    expect(runAssignmentSchema.parse({ ...assignment, policy: legacy }).policy?.permissions.computer_use).toBeUndefined()
  })

  it("grants the local computer without asking anyone; an older server's ask reads as allow (ADR 2026-11-27-1720)", () => {
    const assignment = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "p1", baseBranch: "main", harness: "mock", prompt: "x" }
    const grant = { botId: "7d4f3f5e-8a3c-4a45-9a52-1a2b3c4d5e6f", ownerId: "owner", workspaceId: "2b1f3f5e-8a3c-4a45-9a52-1a2b3c4d5e6f" }
    for (const permission of ["allow", "ask"])
      expect(runAssignmentSchema.parse({ ...assignment, localComputer: { ...grant, permission } }).localComputer?.permission).toBe("allow")
    expect(runAssignmentSchema.safeParse({ ...assignment, localComputer: { ...grant, permission: "deny" } }).success).toBe(false)
  })
})

describe("the read-only check role (ADR 0046)", () => {
  const workspace = resolveAgentSettings(null).policy

  it("takes the changing actions away and keeps network open", () => {
    const readOnly = readOnlyRunPolicy(workspace)
    expect(readOnly.permissions).toEqual({
      install_dependency: "deny",
      write_outside_repo: "deny",
      git_push: "deny",
      network: "allow",
      computer_use: "deny",
    })
    expect(readOnly.readOnly).toBe(true)
  })

  it("does not take the push with the person's own credential away", () => {
    const allowed = { ...workspace, permissions: { ...workspace.permissions, git_push: "allow" as const } }
    expect(READ_ONLY_DENIED).not.toContain("git_push")
    expect(readOnlyRunPolicy(allowed).permissions.git_push).toBe("allow")
  })

  it("is never looser than the policy it narrows", () => {
    for (const policy of [workspace, { ...workspace, permissions: { ...workspace.permissions, git_push: "allow" as const } }]) {
      expect(isNoLooserThan(policy, readOnlyRunPolicy(policy))).toBe(true)
      expect(isNoLooserThan(policy, policy)).toBe(true)
    }
  })

  it("catches a policy that does loosen one, so the check above means something", () => {
    const looser = { ...workspace, permissions: { ...workspace.permissions, git_push: "allow" as const } }
    expect(isNoLooserThan({ ...workspace, permissions: { ...workspace.permissions, git_push: "deny" } }, looser)).toBe(false)
    expect(isNoLooserThan({ ...workspace, readOnly: true }, workspace)).toBe(false)
  })
})

describe("a person's model per harness (ADR 0060)", () => {
  it("keeps the harnesses the person set and drops the rest", () => {
    expect(
      resolveModelByHarness({ claude_code: "sonnet", codex: "  " })
    ).toEqual({ claude_code: "sonnet" })
  })

  it("ignores a harness the protocol has no model for, and a name that is not one", () => {
    expect(resolveModelByHarness({ mock: "whatever" })).toEqual({})
    expect(resolveModelByHarness({ claude_code: 7 })).toEqual({})
    expect(resolveModelByHarness("sonnet")).toEqual({})
    expect(resolveModelByHarness(null)).toEqual({})
  })

  it("answers with the model of the harness the run is on, or nothing", () => {
    const stored = { claude_code: "sonnet", cursor: "gpt-5" }
    expect(modelForHarness(stored, "claude_code")).toBe("sonnet")
    expect(modelForHarness(stored, "codex")).toBeNull()
    // The mock has no model, so it never gets one from a preference.
    expect(modelForHarness(stored, "mock")).toBeNull()
  })

  it("travels in the run assignment, and is absent when unset", () => {
    const base = {
      runId: "r1",
      issueId: "i1",
      deviceId: "d1",
      repoId: "p1",
      baseBranch: "main",
      harness: "claude_code" as const,
      prompt: "x",
    }
    expect(runAssignmentSchema.parse({ ...base, model: "sonnet" }).model).toBe(
      "sonnet"
    )
    expect(runAssignmentSchema.parse(base).model).toBeUndefined()
    // A blank model is not a model.
    expect(
      runAssignmentSchema.safeParse({ ...base, model: "  " }).success
    ).toBe(false)
  })
})

describe("a person's own instructions (ADR 0060)", () => {
  it("trims what is there and answers null for a blank or a non-string", () => {
    expect(resolveInstructions("  Read docs/CONTRIBUTING.md. ")).toBe(
      "Read docs/CONTRIBUTING.md."
    )
    expect(resolveInstructions("   ")).toBeNull()
    expect(resolveInstructions(null)).toBeNull()
    expect(resolveInstructions(7)).toBeNull()
  })

  it("reads back only a harness that can be a default", () => {
    expect(resolveDefaultHarness("codex")).toBe("codex")
    expect(resolveDefaultHarness("mock")).toBeNull()
    expect(resolveDefaultHarness("")).toBeNull()
    expect(resolveDefaultHarness(undefined)).toBeNull()
  })
})

it("canonicalizes resolved execution policy independent of object key order", () => {
  const policy = defaultRunPolicy()
  expect(runPolicyDigestInput()).toBe(runPolicyDigestInput(policy))
  const reordered = { networkAllow: policy.networkAllow, permissions: {
    network: policy.permissions.network, git_push: policy.permissions.git_push, computer_use: policy.permissions.computer_use,
    write_outside_repo: policy.permissions.write_outside_repo, install_dependency: policy.permissions.install_dependency,
  } }
  expect(runPolicyDigestInput(reordered)).toBe(runPolicyDigestInput(policy))
  expect(runPolicyDigestInput({ ...policy, readOnly: true })).not.toBe(runPolicyDigestInput(policy))
})
