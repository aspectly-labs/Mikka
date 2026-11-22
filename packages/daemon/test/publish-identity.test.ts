import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"
import { publishRun, retainDeliverable, snapshotTree } from "../src/agents/publish"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

async function createRepoAndWorktree(runId: string) {
  const origin = tempDir("orvo-")
  await execa("git", ["init", "--bare", "-q", "-b", "main", origin])
  const repo = await makeRepo()
  await execa("git", ["remote", "add", "origin", origin], { cwd: repo })
  await execa("git", ["push", "-q", "origin", "main"], { cwd: repo })
  const worktree = tempDir("orvw-")
  await execa("git", ["worktree", "add", "-q", "-b", `mikka/run-${runId}`, worktree], { cwd: repo })
  return { repo, origin, worktree }
}

async function readCommitIdentity(repo: string, sha: string) {
  const { stdout } = await execa("git", ["show", "-s", "--format=%an|%ae|%cn|%ce", sha], { cwd: repo })
  const [authorName, authorEmail, committerName, committerEmail] = stdout.trim().split("|")
  return { authorName, authorEmail, committerName, committerEmail }
}

describe("publish git identity fallback order", () => {
  it("resolves (1) repo git config -> (2) resolved setting -> (3) FALLBACK_IDENTITY and ignores host global gitconfig", async () => {
    const fakeHome = tempDir("orvh-")
    writeFileSync(join(fakeHome, ".gitconfig"), "[user]\n\tname = Host Global\n\temail = host@global.invalid\n")
    const hostEnv = { ...process.env, HOME: fakeHome, GIT_CONFIG_GLOBAL: join(fakeHome, ".gitconfig") }

    // (3) Neither repo git config nor setting -> FALLBACK_IDENTITY (not Host Global!)
    {
      const { repo, worktree } = await createRepoAndWorktree("fallback")
      writeFileSync(join(worktree, "a.txt"), "fallback\n")
      const tree = await snapshotTree(repo, worktree, hostEnv)
      const published = await publishRun({
        runId: "fallback",
        repoPath: repo,
        worktree,
        tree,
        issueId: "issue-1",
        summary: "Fallback commit",
        env: hostEnv,
        push: { approved: false, remote: "origin" },
      })
      expect(published.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(await readCommitIdentity(repo, published.commit!)).toEqual({
        authorName: "Mikka Agent",
        authorEmail: "agent@mikka.invalid",
        committerName: "Mikka Agent",
        committerEmail: "agent@mikka.invalid",
      })
    }

    // (2) No repo git config + resolved setting -> setting wins (and partial setting mixes with FALLBACK_IDENTITY)
    {
      const { repo, worktree } = await createRepoAndWorktree("setting-full")
      writeFileSync(join(worktree, "b.txt"), "setting\n")
      const tree = await snapshotTree(repo, worktree, hostEnv)
      const published = await publishRun({
        runId: "setting-full",
        repoPath: repo,
        worktree,
        tree,
        issueId: "issue-1",
        summary: "Setting commit",
        env: hostEnv,
        gitIdentity: { name: "Alice Configured", email: "alice@configured.example" },
        push: { approved: false, remote: "origin" },
      })
      expect(await readCommitIdentity(repo, published.commit!)).toEqual({
        authorName: "Alice Configured",
        authorEmail: "alice@configured.example",
        committerName: "Alice Configured",
        committerEmail: "alice@configured.example",
      })
    }

    {
      const { repo, worktree } = await createRepoAndWorktree("setting-partial")
      writeFileSync(join(worktree, "c.txt"), "partial\n")
      const tree = await snapshotTree(repo, worktree, hostEnv)
      const published = await publishRun({
        runId: "setting-partial",
        repoPath: repo,
        worktree,
        tree,
        issueId: "issue-1",
        summary: "Partial setting commit",
        env: hostEnv,
        gitIdentity: { name: "Alice Only" },
        push: { approved: false, remote: "origin" },
      })
      expect(await readCommitIdentity(repo, published.commit!)).toEqual({
        authorName: "Alice Only",
        authorEmail: "agent@mikka.invalid",
        committerName: "Alice Only",
        committerEmail: "agent@mikka.invalid",
      })
    }

    // (1) Repo git config wins over resolved setting per-field
    {
      const { repo, worktree } = await createRepoAndWorktree("repo-config")
      await execa("git", ["config", "user.name", "Repo Specific Author"], { cwd: repo })
      await execa("git", ["config", "user.email", "repo@specific.example"], { cwd: repo })
      writeFileSync(join(worktree, "d.txt"), "repo\n")
      const tree = await snapshotTree(repo, worktree, hostEnv)
      const published = await publishRun({
        runId: "repo-config",
        repoPath: repo,
        worktree,
        tree,
        issueId: "issue-1",
        summary: "Repo config commit",
        env: hostEnv,
        gitIdentity: { name: "Alice Configured", email: "alice@configured.example" },
        push: { approved: false, remote: "origin" },
      })
      expect(await readCommitIdentity(repo, published.commit!)).toEqual({
        authorName: "Repo Specific Author",
        authorEmail: "repo@specific.example",
        committerName: "Repo Specific Author",
        committerEmail: "repo@specific.example",
      })
    }

    // Per-field mix: repo sets user.email only, setting sets gitAuthorName
    {
      const { repo, worktree } = await createRepoAndWorktree("repo-mixed")
      await execa("git", ["config", "user.email", "repo-only@specific.example"], { cwd: repo })
      writeFileSync(join(worktree, "e.txt"), "mixed\n")
      const tree = await snapshotTree(repo, worktree, hostEnv)
      const published = await publishRun({
        runId: "repo-mixed",
        repoPath: repo,
        worktree,
        tree,
        issueId: "issue-1",
        summary: "Mixed commit",
        env: hostEnv,
        gitIdentity: { name: "Alice Configured", email: "alice@configured.example" },
        push: { approved: false, remote: "origin" },
      })
      expect(await readCommitIdentity(repo, published.commit!)).toEqual({
        authorName: "Alice Configured",
        authorEmail: "repo-only@specific.example",
        committerName: "Alice Configured",
        committerEmail: "repo-only@specific.example",
      })
    }

    // retainDeliverable (line 208 commit-tree) follows the same fallback order
    {
      const { repo, worktree } = await createRepoAndWorktree("deliverable")
      writeFileSync(join(worktree, "deliverable.txt"), "snapshot\n")
      const commit = await retainDeliverable(repo, worktree, "deliverable", undefined, {
        name: "Deliverable Author",
        email: "deliverable@configured.example",
      })
      expect(await readCommitIdentity(repo, commit)).toEqual({
        authorName: "Deliverable Author",
        authorEmail: "deliverable@configured.example",
        committerName: "Deliverable Author",
        committerEmail: "deliverable@configured.example",
      })
    }
  })
})
