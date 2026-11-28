import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  resolveAgentSettings,
  type RunPolicy,
} from "@mikka/protocol/agent-policy"

import { acpPermissionResponse } from "./adapters/cursor"
import { claudeSettings } from "./adapters/claude"
import { runInstructions } from "./agents/run-context"
import {
  PERMISSION_DEFAULTS,
  classifyWrite,
  claudePermissionRules,
  decide,
  policyInstructions,
  pushDecision,
  rawCliShellAvailable,
} from "./permissions"

describe("permission policy (ADR 0009, ADR 2026-11-27-1615)", () => {
  it.each([
    ["read_in_worktree", "allow"],
    ["write_in_worktree", "allow"],
    ["run_project_script", "allow"],
    ["run_setup_recipe", "allow"],
    ["install_dependency", "allow"],
    ["write_outside_repo", "allow"],
    ["git_push", "allow"],
    ["network", "allow"],
    ["computer_use", "allow"],
  ] as const)("%s -> %s", (action, expected) => {
    expect(decide(action)).toBe(expected)
  })

  it("never asks, and allows unknown actions except in a read-only check", () => {
    for (const action of ["format_disk", "__proto__", "run_setup_recipe", "computer_use"])
      expect(decide(action)).toBe("allow")
    expect(decide("format_disk", { policy: { ...policy({}), readOnly: true } })).toBe("deny")
    expect(decide("__proto__", { policy: { ...policy({}), readOnly: true } })).toBe("deny")
  })

  it("classifies writes by worktree boundary", () => {
    expect(classifyWrite("/wt/run-1", "src/a.ts")).toBe("write_in_worktree")
    expect(classifyWrite("/wt/run-1", "/wt/run-1/b.ts")).toBe(
      "write_in_worktree"
    )
    expect(classifyWrite("/wt/run-1", "../run-2/a.ts")).toBe(
      "write_outside_repo"
    )
    expect(classifyWrite("/wt/run-1", "/etc/hosts")).toBe("write_outside_repo")
  })

  it("follows symlinks: a link in the worktree to outside is outside", () => {
    const base = mkdtempSync(join(tmpdir(), "orvp-"))
    try {
      const worktree = join(base, "wt")
      const outside = join(base, "outside")
      mkdirSync(worktree)
      mkdirSync(outside)
      symlinkSync(outside, join(worktree, "linked-dir"))
      symlinkSync(join(outside, "f.txt"), join(worktree, "linked-file"))
      expect(classifyWrite(worktree, "linked-dir/new/a.txt")).toBe(
        "write_outside_repo"
      )
      expect(classifyWrite(worktree, "linked-file")).toBe("write_outside_repo")
      expect(classifyWrite(worktree, "real/new.txt")).toBe("write_in_worktree")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

/** A policy as a server sends it, with `permissions` overriding the defaults. */
function policy(permissions: Partial<RunPolicy["permissions"]>): RunPolicy {
  const base = resolveAgentSettings(null).policy
  return { ...base, permissions: { ...base.permissions, ...permissions } }
}

describe("applying a run's policy (ADR 0028, ADR 2026-11-27-1615)", () => {
  it("ignores an older server's deny for installs, writes and the network", () => {
    const sent: RunPolicy = { ...policy({}), permissions: { install_dependency: "deny", write_outside_repo: "deny", git_push: "deny", network: "deny", computer_use: "allow" }, networkAllow: ["only.example.invalid"], networkCeiling: ["only.example.invalid"] }
    for (const action of ["install_dependency", "write_outside_repo", "network", "write_in_worktree", "run_setup_recipe"])
      expect(decide(action, { policy: sent })).toBe("allow")
    expect(rawCliShellAvailable(sent)).toBe(true)
    expect(claudePermissionRules(sent)).toEqual({ allow: [], ask: [], deny: [] })
    expect(policyInstructions(sent).join("\n")).not.toMatch(/turned off|not allowed|Do not install|only your model API/)
  })

  it("uses only the run computer grant and makes read-only take precedence", () => {
    for (const decision of ["allow", "deny"] as const) {
      const p = { ...policy({}), permissions: { ...policy({}).permissions, computer_use: decision } }
      expect(decide("computer_use", { policy: p })).toBe(decision)
      expect(decide("computer_use", { policy: { ...p, readOnly: true } })).toBe("deny")
    }
    const legacy = policy({})
    delete legacy.permissions.computer_use
    expect(decide("computer_use", { policy: legacy })).toBe("allow")
    expect(decide("computer_use", { policy: { ...legacy, readOnly: true } })).toBe("deny")
  })

  it("pushes only on the host's allow", () => {
    // Only the server's allow (an admitted GitHub App grant) pushes; nothing local stands in for it.
    expect(pushDecision(policy({}))).toEqual({
      push: false,
      note: "Push is turned off for this run",
    })
    expect(pushDecision(policy({ git_push: "allow" }))).toEqual({ push: true })
    expect(pushDecision(policy({ git_push: "deny" }))).toEqual({
      push: false,
      note: "Push is turned off for this run",
    })
  })

  it("denies every write to a read-only check, whatever the workspace chose (ADR 0046)", () => {
    const p: RunPolicy = {
      ...policy({}),
      permissions: { ...policy({}).permissions, git_push: "allow" },
      readOnly: true,
    }
    expect(decide("write_in_worktree", { policy: p })).toBe("deny")
    expect(decide("write_outside_repo", { policy: p })).toBe("deny")
    expect(decide("run_project_script", { policy: p })).toBe("deny")
    expect(decide("install_dependency", { policy: p })).toBe("deny")
    // Read-only is task intent: the agent's own push is not withheld.
    expect(decide("git_push", { policy: p })).toBe("allow")
    // Reading is the whole point of the check.
    expect(decide("read_in_worktree", { policy: p })).toBe("allow")
    // A read-only check never pushes, even on an approved repo.
    expect(pushDecision(p)).toEqual({
      push: false,
      note: "A read-only check does not push",
    })
    // The CLI is told the same, and never offered an install.
    expect(claudePermissionRules(p)).toMatchObject({
      ask: [],
      deny: expect.arrayContaining([
        "Write",
        "Edit",
        "Bash(npm install:*)",
      ]),
    })
    expect(policyInstructions(p)[0]).toContain("read-only check")
    expect(claudePermissionRules(p).deny).not.toContain("Bash(git push:*)")
  })

  it("never withholds the agent's own git push: it works with the person's own credential", () => {
    for (const git_push of ["allow", "deny"] as const) {
      expect(claudePermissionRules(policy({ git_push })).deny).not.toContain("Bash(git push:*)")
      expect(claudePermissionRules({ ...policy({ git_push }), readOnly: true }).deny).not.toContain("Bash(git push:*)")
    }
  })

  it("gives Claude Code no ask rules, and deny rules only to a read-only check", () => {
    expect(claudePermissionRules(policy({}))).toEqual({ allow: [], ask: [], deny: [] })
    const readOnly = claudePermissionRules({ ...policy({}), readOnly: true })
    expect(readOnly.ask).toEqual([])
    expect(readOnly.deny).toEqual(expect.arrayContaining(["Bash", "Write", "Bash(pnpm add:*)"]))
    const settings = claudeSettings(policy({}))
    // Runs use no sandbox (decision 2026-11-01-2335): Claude Code's own stays off.
    expect(settings.sandbox).toEqual({ enabled: false })
    expect(settings.permissions?.deny).toEqual([])
  })

  it("lets every Cursor tool call go ahead, git push included", async () => {
    const request = (command: string) =>
      ({
        sessionId: "s",
        toolCall: { toolCallId: "t", title: command, rawInput: { command } },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      }) as Parameters<typeof acpPermissionResponse>[0]
    const chosen = async (command: string) => {
      const response = await acpPermissionResponse(request(command))
      return response.outcome.outcome === "selected" ? response.outcome.optionId : null
    }
    for (const command of ["npm install zod", "npm test", "touch NOTES.md", "git push", "env git push origin HEAD", "git push https://github.com/o/r.git HEAD:refs/heads/mikka/x"])
      expect(await chosen(command)).toBe("yes")
  })

  it("tells the agent it has the person's own GitHub credential, and how to deliver only when it has a task branch", () => {
    const github = { endpoint: "https://mikka.test/api/runs/github-token", repository: "o/r", runToken: "mkw_x", issueId: "i" }
    const credential = "Git and gh have the person's own GitHub credential"
    const plain = runInstructions("/wt", policy({}), github)
    expect(plain).toContain(credential)
    expect(plain).toContain("Never print, copy or store the credential")
    expect(plain).not.toContain("You own delivery")
    expect(plain).not.toContain("Do not commit, push")
    const delivering = runInstructions("/wt", policy({}), { ...github, branch: "mikka/t-1" }, "implement")
    expect(delivering).toContain(credential)
    expect(delivering).toContain("push HEAD to mikka/t-1")
    for (const other of [runInstructions("/wt", { ...policy({}), readOnly: true }, { ...github, branch: "mikka/t-1" }), runInstructions("/wt", policy({}), { ...github, branch: "mikka/t-1" }, "plan")]) {
      expect(other).toContain(credential)
      expect(other).not.toContain("You own delivery")
    }
    expect(runInstructions("/wt", policy({}))).toContain("Do not commit, push or switch branches")
    expect(delivering).not.toContain("mkw_x")
  })

  it("tells the agent it has full access, and never to ask for permission", () => {
    const full = runInstructions("/wt", policy({}))
    expect(full).toContain("You have full access")
    expect(full).toContain("network access is open")
    expect(full).toContain("Never ask anyone for permission or approval")
    expect(full).not.toMatch(/turned off|not allowed|missing permission|chat reply as approval|pre-authorized|Native shell execution/)
    const check = runInstructions("/wt", { ...policy({}), readOnly: true })
    expect(check).toContain("read-only check")
    expect(check).toContain("you have no shell")
  })
  it('keeps project shell execution independent of daemon publication permission', () => {
    for (const install of ['allow','deny'] as const) for (const push of ['allow','deny'] as const) {
      const value={...policy({}),permissions:{...policy({}).permissions,install_dependency:install,git_push:push}}
      // Every run has a shell; only a read-only check is file-only.
      expect(rawCliShellAvailable(value)).toBe(true)
      expect(rawCliShellAvailable({...value,readOnly:true})).toBe(false)
    }
  })
})
