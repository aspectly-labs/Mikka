import { withTaskEnv } from './task-env'
// One `git worktree` per run under the daemon's data dir (R4, R11, R12).
// Local callers pass daemon-owned clone caches, never user checkouts.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { execa } from "execa"
import { simpleGit } from "simple-git"

import { assertBranchName, worktreeGitDir } from "./agents/publish"
import { buildChildEnv } from "./env"
import { assertSafeId } from "./ids"
import type { SetupRecipe } from "./server-link"

/** Repo-root file listing gitignored local files to copy into fresh worktrees (Claude Code / Orca convention). */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude"
const WORKTREE_INCLUDE_MAX_BYTES = 64 * 1024
const WORKTREE_INCLUDE_MAX_ENTRIES = 200
const FORBIDDEN_COPY_PATH = /(^|\/)(\.git|\.codex\/auth\.json|\.claude\/\.credentials\.json)(\/|$)/

function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += "$"
  return new RegExp(out)
}

function collectSafeRepoFiles(repoPath: string, repoReal: string): string[] {
  const files: string[] = []
  const walk = (dir: string, relPrefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!isInside(repoReal, realpathSync(full))) continue
        walk(full, rel)
      } else if (entry.isFile()) {
        if (FORBIDDEN_COPY_PATH.test(rel)) continue
        if (!isInside(repoReal, realpathSync(full))) continue
        files.push(rel)
      }
    }
  }
  walk(repoPath, "")
  return files
}

/**
 * Reads repo-root `.worktreeinclude` (gitignore-style patterns/paths of local
 * ignored files such as `.env.local` or `.npmrc`) with strict repo-boundary,
 * non-symlink, and native-credential exclusion checks.
 */
export function readWorktreeInclude(manifestRoot: string, matchRoot = manifestRoot): string[] {
  const manifestReal = realpathSync(manifestRoot)
  const matchReal = matchRoot === manifestRoot ? manifestReal : realpathSync(matchRoot)
  const includePath = join(manifestRoot, WORKTREE_INCLUDE_FILE)
  const stat = lstatSync(includePath, { throwIfNoEntry: false })
  if (!stat) return []
  if (!stat.isFile() || !isInside(manifestReal, realpathSync(includePath))) {
    throw new Error(`${WORKTREE_INCLUDE_FILE} must be a regular file inside the repository`)
  }
  if (stat.size > WORKTREE_INCLUDE_MAX_BYTES) {
    throw new Error(`${WORKTREE_INCLUDE_FILE} exceeds ${WORKTREE_INCLUDE_MAX_BYTES} bytes`)
  }
  const lines = readFileSync(includePath, "utf8").split(/\r?\n/)
  const rules: Array<{ negate: boolean; pattern: string }> = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const negate = trimmed.startsWith("!")
    const line = negate ? trimmed.slice(1).trim() : trimmed
    if (!line) continue
    if (line.includes("\0")) throw new Error(`${WORKTREE_INCLUDE_FILE} contains invalid path`)
    const normalized = line.replace(/^\.\//, "").replace(/\\/g, "/")
    if (!normalized) continue
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`${WORKTREE_INCLUDE_FILE} references a path outside the repo: ${line}`)
    }
    if (!negate && FORBIDDEN_COPY_PATH.test(normalized)) {
      throw new Error(`${WORKTREE_INCLUDE_FILE} cannot copy forbidden path: ${line}`)
    }
    rules.push({ negate, pattern: normalized })
    if (rules.length > WORKTREE_INCLUDE_MAX_ENTRIES) {
      throw new Error(`${WORKTREE_INCLUDE_FILE} exceeds ${WORKTREE_INCLUDE_MAX_ENTRIES} entries`)
    }
  }
  if (!rules.length) return []
  const matched = new Set<string>()
  let allFiles: string[] | null = null
  for (const { negate, pattern } of rules) {
    const isGlob = /[*?]/.test(pattern)
    if (negate) {
      if (!isGlob) {
        matched.delete(pattern)
      } else {
        const re = globToRegExp(pattern)
        for (const file of [...matched]) {
          if (re.test(file)) matched.delete(file)
        }
      }
      continue
    }
    if (!isGlob) {
      matched.add(pattern)
      continue
    }
    if (!allFiles) allFiles = collectSafeRepoFiles(matchRoot, matchReal)
    const re = globToRegExp(pattern)
    for (const file of allFiles) {
      if (re.test(file)) {
        matched.add(file)
        if (matched.size > WORKTREE_INCLUDE_MAX_ENTRIES) {
          throw new Error(`${WORKTREE_INCLUDE_FILE} matched more than ${WORKTREE_INCLUDE_MAX_ENTRIES} files`)
        }
      }
    }
  }
  return [...matched]
}

/** How long a disk usage figure is reused before the tree is walked again. */
export const DISK_USAGE_TTL_MS = 5 * 60_000

/** How long fetching an issue branch may take before the run starts from base. */
export const FETCH_TIMEOUT_MS = 60_000

/** Git config for fetching into the main repo: no hooks, no `ext::`. */
export const FETCH_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.ext.allow=never",
]

export function runBranch(runId: string) {
  return `mikka/run-${assertSafeId("run id", runId)}`
}

/** `child` is `parent` or below it (both already resolved). */
export function isInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const configWriters = new Map<string, Promise<unknown>>()

/**
 * Runs `work` alone among this process's writers of `repoPath`'s git
 * config. Concurrent runs share one clone cache, and `remote set-url`,
 * `worktree add` (it records the new branch's upstream) and `branch -D` all
 * take `.git/config.lock`; git fails rather than waits when another holds it.
 */
export function withRepoConfig<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(repoPath)
  const result = (configWriters.get(key) ?? Promise.resolve()).then(work, work)
  const settled = result.then(() => undefined, () => undefined)
  configWriters.set(key, settled)
  void settled.then(() => {
    if (configWriters.get(key) === settled) configWriters.delete(key)
  })
  return result
}

export class WorktreeManager {
  private usage = 0
  private usageAt = 0
  private usageRefresh: Promise<number> | null = null

  constructor(private readonly root: string, private readonly retainResources = false) {}

  /** The run's worktree dir; never outside the worktree root. */
  pathFor(runId: string) {
    const root = resolve(this.root)
    const path = resolve(root, assertSafeId("run id", runId))
    if (dirname(path) !== root) {
      throw new Error(`worktree path escapes ${root}: ${runId}`)
    }
    return path
  }

  /**
   * Creates (or reuses, after a restart) the run's worktree from
   * `baseBranch` (a branch name or a commit id).
   */
  async create(
    runId: string,
    repoPath: string,
    baseBranch: string
  ): Promise<string> {
    await excludeVerifyArtifacts(repoPath)
    const path = this.pathFor(runId)
    if (existsSync(join(path, ".git"))) return path
    mkdirSync(this.root, { recursive: true })
    await withRepoConfig(repoPath, () =>
      simpleGit(repoPath).raw([
        "worktree",
        "add",
        "-B",
        runBranch(runId),
        path,
        // The base branch comes from the server: never let it read as an option.
        "--end-of-options",
        baseBranch,
      ])
    )
    return path
  }

  /** Move the prebuilt checkout, including ignored dependency files, into the
   * task. If its setup outputs conflict with the requested commit, a normal
   * worktree and full setup can still run from the clean repository cache. */
  async createFromEnvironmentSnapshot(runId: string, repoPath: string, baseBranch: string, canRefreshSetup = false): Promise<string | null> {
    const prepared = repoPath + ".environment-setup"
    const path = this.pathFor(runId)
    if (!lstatSync(prepared, { throwIfNoEntry: false })?.isDirectory() || existsSync(path)) return null
    await excludeVerifyArtifacts(repoPath)
    return withRepoConfig(repoPath, async () => {
      const gitDir = await worktreeGitDir(repoPath, prepared)
      const commit = (await simpleGit(repoPath).raw(["rev-parse", "--verify", "--end-of-options", baseBranch + "^{commit}"])).trim()
      // A changed commit may alter any input consumed by the setup command.
      // Without maintenance only the exact built commit is safe to reuse.
      const built = (await execa("git", ["rev-parse", "HEAD"], { cwd: prepared })).stdout.trim()
      if (built !== commit && !canRefreshSetup) return null
      const switched = await execa("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--no-overwrite-ignore", "--detach", commit], {
        cwd: prepared, env: { GIT_DIR: gitDir, GIT_WORK_TREE: prepared }, stdin: "ignore", reject: false,
      })
      if (switched.exitCode !== 0) return null
      mkdirSync(this.root, { recursive: true })
      const moved = await execa("git", [...FETCH_GIT, "worktree", "move", "--", prepared, path], {
        cwd: repoPath, stdin: "ignore", reject: false,
      })
      if (moved.exitCode !== 0) return null
      await execa("git", [...FETCH_GIT, "checkout", "-B", runBranch(runId), commit], { cwd: path, stdin: "ignore" })
      return path
    })
  }

  /**
   * The commit `branch` points at on `remote`, fetched into the repo, for a
   * fresh worktree of an issue that already has a branch (ADR 0024): the
   * run builds on it, so a person's commits there stay and the run's push
   * is a fast-forward. Throws when the fetch fails or the branch is not
   * there; the caller then starts from the base branch. The fetch goes
   * through a ref of the run's own (FETCH_HEAD is shared by concurrent
   * runs), dropped again once read.
   */
  async fetchBranch(
    repoPath: string,
    remote: string,
    branch: string,
    runId: string,
    env: Record<string, string> = {}
  ): Promise<string> {
    await assertBranchName(branch)
    const ref = `refs/mikka/fetch/${assertSafeId("run id", runId)}`
    const git = (args: string[], timeout?: number) =>
      execa("git", [...FETCH_GIT, ...args], {
        cwd: repoPath,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        timeout,
      })
    try {
      await git(
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--end-of-options",
          remote,
          `+refs/heads/${branch}:${ref}`,
        ],
        FETCH_TIMEOUT_MS
      )
      return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout
        .toString()
        .trim()
    } finally {
      await git(["update-ref", "-d", ref]).catch(() => undefined)
    }
  }

  /**
   * A follow-up run works on in the worktree of the run it continues (a
   * chain of continuations shares the first run's worktree): the
   * worktree switches to this run's branch at the same commit, keeping
   * whatever the earlier run left uncommitted. Null when that worktree is
   * gone (pruned) or belongs to another repo; the caller then starts a
   * fresh one. Git runs pinned to the git dir `repoPath` lists for the
   * worktree, with hooks off: the agent wrote in that tree.
   */
  async continueFrom(
    repoPath: string,
    previousWorktree: string,
    runId: string
  ): Promise<string | null> {
    await excludeVerifyArtifacts(repoPath)
    const root = resolve(this.root)
    const path = resolve(previousWorktree)
    if (dirname(path) !== root) return null
    if (!existsSync(join(path, ".git"))) return null
    let gitDir: string
    try {
      gitDir = await worktreeGitDir(repoPath, path)
    } catch {
      return null
    }
    const git = (args: string[]) =>
      execa("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: realpathSync(path),
        env: { GIT_DIR: gitDir, GIT_WORK_TREE: realpathSync(path) },
        stdin: "ignore",
      })
    const branch = `refs/heads/${runBranch(runId)}`
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim()
    await git(["update-ref", branch, head])
    await git(["symbolic-ref", "HEAD", branch])
    return path
  }

  /** Include commits made by the CLI as well as still-uncommitted task changes. */
  async changedFiles(worktree: string, baseCommit?: string): Promise<string[]> {
    const status = await simpleGit(worktree).status()
    const committed = baseCommit ? (await simpleGit(worktree).raw(['diff', '--name-only', '-z', baseCommit, 'HEAD', '--'])).split('\0').filter(Boolean) : []
    return [...new Set([...committed, ...status.files.map((file) => file.path)])].filter(path => path !== '.verify' && !path.startsWith('.verify/'))
  }

  /**
   * Runs the repo's approved setup recipe in a fresh worktree: copy
   * git-ignored files from `.worktreeinclude` and `recipe.copyFiles` in the
   * main checkout, then the setup command with a clean env. An explicitly
   * unapproved recipe is skipped (it would need asking).
   */
  async bootstrap(
    worktree: string,
    repoPath: string,
    recipe: SetupRecipe | undefined,
    taskEnv?: Record<string, string>,
    options?: { includeWorktreeFile?: boolean; copySource?: string }
  ): Promise<"skipped" | "done"> {
    if (recipe && !recipe.approved) return "skipped"
    const sourceRoot = options?.copySource ?? repoPath
    const includeFiles = options?.includeWorktreeFile === false
      ? []
      : existsSync(join(sourceRoot, WORKTREE_INCLUDE_FILE))
        ? readWorktreeInclude(sourceRoot, sourceRoot)
        : existsSync(join(worktree, WORKTREE_INCLUDE_FILE))
          ? readWorktreeInclude(worktree, sourceRoot)
          : []
    if (!recipe && includeFiles.length === 0) return "skipped"
    const sourceReal = realpathSync(sourceRoot)
    const worktreeReal = realpathSync(worktree)
    const filesToCopy = [...new Set([...includeFiles, ...(recipe?.copyFiles ?? [])])]
    if (sourceReal !== worktreeReal) {
      for (const file of filesToCopy) {
        const normalized = file.replace(/\\/g, "/")
        if (FORBIDDEN_COPY_PATH.test(normalized)) {
          throw new Error(`setup recipe cannot copy forbidden path: ${file}`)
        }
        const rel = relative(sourceRoot, resolve(sourceRoot, file))
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(`setup recipe copies a file outside the repo: ${file}`)
        }
        const from = join(sourceRoot, rel)
        const fromStat = lstatSync(from, { throwIfNoEntry: false })
        if (!fromStat) continue
        // Symlinks (the file itself or a parent dir) could pull in or overwrite
        // files outside the repo and the worktree; both ends must stay inside.
        if (!fromStat.isFile() || !isInside(sourceReal, realpathSync(from))) {
          throw new Error(
            `setup recipe copies a symlink or non-file, or leaves the repo: ${file}`
          )
        }
        const to = join(worktree, rel)
        // Verify every existing parent directory inside the worktree before mkdirSync
        // so a committed symlink directory cannot cause mkdirSync to write outside worktreeReal.
        let probe = dirname(to)
        while (probe !== worktree && probe !== dirname(probe)) {
          const probeStat = lstatSync(probe, { throwIfNoEntry: false })
          if (probeStat) {
            if (!probeStat.isDirectory() || !isInside(worktreeReal, realpathSync(probe))) {
              throw new Error(
                `setup recipe would write through a symlink or outside the worktree: ${file}`
              )
            }
            break
          }
          probe = dirname(probe)
        }
        mkdirSync(dirname(to), { recursive: true })
        const toStat = lstatSync(to, { throwIfNoEntry: false })
        if (
          !isInside(worktreeReal, realpathSync(dirname(to))) ||
          (toStat && !toStat.isFile())
        ) {
          throw new Error(
            `setup recipe would write through a symlink or outside the worktree: ${file}`
          )
        }
        copyFileSync(from, to)
      }
    }
    if (recipe?.command) {
      await execa(recipe.command, {
        shell: true,
        cwd: worktree,
        env: withTaskEnv(buildChildEnv(), taskEnv).env,
        extendEnv: false,
        stdio: "ignore",
      })
    }
    return "done"
  }

  async remove(runId: string, repoPath: string) {
    await this.removePath(this.pathFor(runId), repoPath)
  }

  private async removePath(path: string, repoPath: string) {
    if (this.retainResources) return
    // In the same queue as `worktree add`: git reads every worktree's admin
    // files while adding one, and fails ("failed to read
    // .git/worktrees/<id>/commondir") if a removal deletes them meanwhile.
    await withRepoConfig(repoPath, async () => {
      try {
        await simpleGit(repoPath).raw(["worktree", "remove", "--force", path])
      } catch {
        rmSync(path, { recursive: true, force: true })
        await simpleGit(repoPath)
          .raw(["worktree", "prune"])
          .catch(() => undefined)
      }
    })
  }

  /**
   * Drops a worktree and the branches of the runs that worked in it (a
   * follow-up run shares the worktree of the run it continues) when they left
   * nothing behind: no new commit on any of the branches (commits already on
   * another branch or a remote do not count, nor do other runs' branches)
   * and nothing uncommitted. Anything else is kept for a person to look at.
   * Returns whether it was removed.
   */
  async discardIfEmpty(
    runIds: readonly string[],
    worktree: string | null,
    repoPath: string
  ): Promise<boolean> {
    if (this.retainResources) return false
    const root = resolve(this.root)
    const path = worktree ? resolve(worktree) : null
    if (path && dirname(path) !== root) return false
    const git = simpleGit(repoPath)
    if (path && existsSync(join(path, ".git"))) {
      if ((await this.changedFiles(path)).length > 0) return false
    }
    const branches: string[] = []
    for (const runId of runIds) {
      const branch = runBranch(runId)
      // simple-git resolves a silent non-zero exit (`--quiet`), so the
      // answer is the printed sha, not whether the call threw.
      const exists = await git
        .raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
        .then((out) => out.trim().length > 0)
        .catch(() => false)
      if (!exists) continue
      const ahead = await git.raw([
        "rev-list",
        "--count",
        `refs/heads/${branch}`,
        "--not",
        "--exclude=mikka/run-*",
        "--branches",
        "--remotes",
      ])
      if (Number(ahead.trim()) > 0) return false
      branches.push(branch)
    }
    if (path) await this.removePath(path, repoPath)
    await withRepoConfig(repoPath, async () => {
      for (const branch of branches)
        await git.raw(["branch", "-D", "--", branch]).catch(() => undefined)
    })
    return true
  }

  /**
   * The repo's local `mikka/run-*` branches with the worktree each is
   * checked out in (null: none). A branch checked out in the repo itself or
   * outside the daemon's worktree root is left out.
   */
  async runBranches(
    repoPath: string
  ): Promise<{ runId: string; worktree: string | null }[]> {
    const out = await simpleGit(repoPath).raw([
      "branch",
      "--list",
      "mikka/run-*",
      "--format=%(refname:short)\t%(worktreepath)",
    ])
    const root = resolve(this.root)
    const repo = resolve(repoPath)
    const branches: { runId: string; worktree: string | null }[] = []
    for (const line of out.split("\n")) {
      const [name, where = ""] = line.split("\t")
      const runId = name?.startsWith("mikka/run-")
        ? name.slice("mikka/run-".length)
        : ""
      if (!runId) continue
      const worktree = where.trim() ? resolve(where.trim()) : null
      if (worktree && (worktree === repo || dirname(worktree) !== root))
        continue
      branches.push({ runId, worktree })
    }
    return branches
  }

  /** Run ids of worktrees on disk. */
  list(): string[] {
    try {
      return readdirSync(this.root)
    } catch {
      return []
    }
  }

  /** Last measured bytes used by all run worktrees (R12); never blocks. */
  cachedDiskUsage(): number {
    return this.usage
  }

  /**
   * Bytes used by all run worktrees, re-measured (asynchronously) only when
   * the last figure is older than `maxAgeMs`; concurrent calls share a walk.
   */
  async diskUsage(maxAgeMs = DISK_USAGE_TTL_MS, now = Date.now()) {
    if (this.usageAt > 0 && now - this.usageAt < maxAgeMs) return this.usage
    this.usageRefresh ??= du(this.root)
      .then((bytes) => {
        this.usage = bytes
        this.usageAt = Date.now()
        return bytes
      })
      .finally(() => {
        this.usageRefresh = null
      })
    return this.usageRefresh
  }

  /**
   * Removes worktrees of finished runs older than `retentionMs`. Removal
   * after PR merge is the same call, triggered once the server reports it.
   */
  async prune(
    finished: { runId: string; repoPath: string; finishedAt: string }[],
    retentionMs: number,
    now = Date.now()
  ): Promise<string[]> {
    if (this.retainResources) return []
    const removed: string[] = []
    for (const run of finished) {
      if (now - Date.parse(run.finishedAt) < retentionMs) continue
      if (!existsSync(this.pathFor(run.runId))) continue
      await this.remove(run.runId, run.repoPath)
      removed.push(run.runId)
    }
    return removed
  }
}

/** Daemon-owned clone metadata applies to every worktree, including resumed runs. */
async function excludeVerifyArtifacts(repoPath: string): Promise<void> {
  await withRepoConfig(repoPath, async () => {
    const common = (await simpleGit(repoPath).raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const info = join(common, 'info')
    mkdirSync(info, { recursive: true })
    const file = join(info, 'exclude')
    if (existsSync(file) && !lstatSync(file).isFile()) throw new Error('Invalid repository exclude file')
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const missing = ['/.verify/', '/.mikka-repositories-*/'].filter(pattern => !existing.split(/\r?\n/).includes(pattern))
    if (missing.length) appendFileSync(file, '\n' + missing.join('\n') + '\n')
  })
}

async function du(path: string): Promise<number> {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) total += await du(join(path, entry))
  return total
}
