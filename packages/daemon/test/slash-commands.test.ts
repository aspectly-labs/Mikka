import { chmodSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ClaudeAdapter, claudeChunks } from "../src/adapters/claude"
import { CodexAdapter, codexItemChunks } from "../src/adapters/codex"
import { NoSandbox } from "../src/agents/sandbox"
import { ToolApprovalGate } from "../src/agents/tool-approval"
import type { AgentEvent } from "../src/adapters/types"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

describe("Issue #3333: runtime slash commands, blocklist, real /compact, system events, and skills", () => {
  it("streams Claude system events (local_command_output, status, compact_boundary) in claudeChunks", () => {
    expect(
      claudeChunks({ type: "system", subtype: "local_command_output", content: "Compacted ok", uuid: "u1", session_id: "s1" } as never),
    ).toEqual([{ type: "data-system-event", data: { kind: "local_command_output", text: "Compacted ok" } }])

    expect(
      claudeChunks({ type: "system", subtype: "status", status: "compacting", uuid: "u2", session_id: "s1" } as never),
    ).toEqual([{ type: "data-system-event", data: { kind: "status", status: "compacting" } }])

    expect(
      claudeChunks({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 12000, post_tokens: 3000, duration_ms: 800 },
        uuid: "u3",
        session_id: "s1",
      } as never),
    ).toEqual([
      {
        type: "data-system-event",
        data: { kind: "compact_boundary", harness: "claude_code", trigger: "manual", preTokens: 12000, postTokens: 3000, durationMs: 800 },
      },
    ])
  })

  it("streams Codex contextCompaction and exitedReviewMode items in codexItemChunks", () => {
    const streamed = new Set<string>()
    expect(codexItemChunks("started", { type: "contextCompaction", id: "c1" }, streamed, "/repo")).toEqual([
      { type: "data-system-event", data: { kind: "status", status: "compacting" } },
    ])
    expect(codexItemChunks("completed", { type: "contextCompaction", id: "c1" }, streamed, "/repo")).toEqual([
      { type: "data-system-event", data: { kind: "compact_boundary", harness: "codex", trigger: "manual" } },
    ])
    expect(codexItemChunks("completed", { type: "exitedReviewMode", id: "r1", review: "LGTM" }, streamed, "/repo")).toEqual([
      { type: "data-system-event", data: { kind: "local_command_output", command: "review", text: "LGTM" } },
    ])
  })

  it("ClaudeAdapter: discovers init + supportedCommands + commands_changed, blocks dangerous commands, supports client_composed, real /compact, and skill resolution", async () => {
    const binary = resolve(import.meta.dirname, "fakes/fake-claude-commands.mjs")
    chmodSync(binary, 0o755)
    const stateDir = tempDir("mikka-claude-cmd-state-")
    const logFile = join(stateDir, "received.jsonl")
    const cwd = await makeRepo()
    const adapter = new ClaudeAdapter({ stateDir, binary })

    const session = await adapter.start({
      runId: "claude-cmd-run-1",
      cwd,
      prompt: "KEEP_OPEN",
      env: { ...buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }), FAKE_CLAUDE_LOG_FILE: logFile },
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("claude-cmd-run-1", { isLive: () => true }),
    })

    const collected: AgentEvent[] = []
    const reader = (async () => {
      for await (const event of session.events()) {
        collected.push(event)
      }
    })()

    // Wait until init available-commands chunk arrives
    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(r => setTimeout(r, 25))
      }
      throw new Error(`Timed out waiting for ${label}; collected=${JSON.stringify(collected)}`)
    }

    await waitFor(
      () => collected.some(e => e.type === "chunk" && e.chunk.type === "data-available-commands"),
      "data-available-commands",
    )

    const initCmdChunk = collected.find(e => e.type === "chunk" && e.chunk.type === "data-available-commands")
    expect(initCmdChunk?.type === "chunk" && initCmdChunk.chunk.type === "data-available-commands").toBe(true)
    if (initCmdChunk?.type === "chunk" && initCmdChunk.chunk.type === "data-available-commands") {
      const names = initCmdChunk.chunk.data.commands.map(c => c.name)
      expect(names).toContain("compact")
      expect(names).toContain("review")
      expect(names).toContain("audit-ui")
      expect(names).toContain("mcp:github:summarize")
      // Dangerous pass-through + terminal_slash_commands MUST be stripped
      for (const blocked of ["login", "logout", "config", "model", "permissions", "mcp", "resume", "terminal-only"]) {
        expect(names).not.toContain(blocked)
      }
    }

    // Bug 1: blocked commands MUST NEVER reach the fake CLI stdin and emit command_blocked
    await session.send("/login")
    await session.send("/terminal-only", { slashCommand: { name: "terminal-only" } })
    await waitFor(
      () =>
        collected.filter(
          e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "command_blocked",
        ).length >= 2,
      "command_blocked notices",
    )

    // "Send as text" delivers /login WITH client_composed: true
    await session.send("/login", { clientComposed: true })
    await waitFor(
      () => collected.some(e => e.type === "chunk" && e.chunk.type === "text-delta" && e.chunk.delta.includes("Echo(literal): /login")),
      "client_composed echo",
    )

    // Bug 4: $audit-ui resolves for Claude Code without mangling $HOME
    await session.send("Run $audit-ui and check $HOME")
    await waitFor(
      () => collected.some(e => e.type === "chunk" && e.chunk.type === "text-delta" && e.chunk.delta.includes("/audit-ui") && e.chunk.delta.includes("$HOME")),
      "resolved skill echo",
    )

    // Allowed slash command `/review` triggers local_command_output + commands_changed
    await session.send("/review src/", { slashCommand: { name: "review", args: "src/" } })
    await waitFor(
      () => collected.some(e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "local_command_output" && e.chunk.data.text.includes("Review output")),
      "review local_command_output",
    )
    await waitFor(
      () =>
        collected.some(
          e =>
            e.type === "chunk" &&
            e.chunk.type === "data-available-commands" &&
            e.chunk.data.commands.some(c => c.name === "deploy-check"),
        ),
      "commands_changed update",
    )

    // Bug 2: real /compact sends raw `/compact focus auth` without JSON wrapper and without client_composed
    await session.compact!("focus auth")
    await waitFor(
      () => collected.some(e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "compact_boundary"),
      "compact_boundary",
    )

    await session.cancel()
    await reader

    const received = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { text: string; client_composed: boolean })

    // Blocked `/login` (non-literal) and `/terminal-only` NEVER reached the CLI
    expect(received.some(r => r.text === "/login" && !r.client_composed)).toBe(false)
    expect(received.some(r => r.text.includes("terminal-only"))).toBe(false)
    // Literal "Send as text" `/login` reached the CLI WITH client_composed: true
    expect(received.some(r => r.text === "/login" && r.client_composed === true)).toBe(true)
    // Real `/compact focus auth` reached the CLI RAW without JSON wrapper and without client_composed
    expect(received.some(r => r.text === "/compact focus auth" && r.client_composed === false)).toBe(true)
  })

  it("CodexAdapter: discovers skills/list + curated commands, runs real thread/compact/start and review/start, and preserves isolated CODEX_HOME", async () => {
    const binary = resolve(import.meta.dirname, "fakes/fake-codex-commands.mjs")
    chmodSync(binary, 0o755)
    const stateDir = tempDir("mikka-codex-cmd-state-")
    const logFile = join(stateDir, "codex-rpc.jsonl")
    const cwd = await makeRepo()
    const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), binary })

    const session = await adapter.start({
      runId: "codex-cmd-run-1",
      cwd,
      prompt: "KEEP_OPEN",
      env: { ...buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }), FAKE_CODEX_LOG_FILE: logFile },
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-cmd-run-1", { isLive: () => true }),
    })

    const collected: AgentEvent[] = []
    const reader = (async () => {
      for await (const event of session.events()) collected.push(event)
    })()

    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(r => setTimeout(r, 25))
      }
      throw new Error(`Timed out waiting for ${label}; collected=${JSON.stringify(collected)}`)
    }

    // Wait for skills/list enriched commands chunk
    await waitFor(
      () =>
        collected.some(
          e =>
            e.type === "chunk" &&
            e.chunk.type === "data-available-commands" &&
            e.chunk.data.commands.some(c => c.name === "deploy-check" && c._meta.source === "skill"),
        ),
      "codex skills/list available-commands",
    )

    const cmdChunks = collected.filter(e => e.type === "chunk" && e.chunk.type === "data-available-commands")
    const latest = cmdChunks.at(-1)!
    if (latest.type === "chunk" && latest.chunk.type === "data-available-commands") {
      expect(latest.chunk.data.commands.map(c => c.name)).toEqual(["review", "compact", "init", "deploy-check"])
    }

    // Real Codex /review -> review/start
    await session.send("/review check auth", { slashCommand: { name: "review", args: "check auth" } })
    await waitFor(
      () =>
        collected.some(
          e =>
            e.type === "chunk" &&
            e.chunk.type === "data-system-event" &&
            e.chunk.data.kind === "local_command_output" &&
            e.chunk.data.text.includes("check auth"),
        ),
      "codex review output",
    )
    await reader

    // Real Codex live /compact -> thread/compact/start
    const session2 = await adapter.start({
      runId: "codex-cmd-run-2",
      cwd,
      prompt: "KEEP_OPEN",
      env: { ...buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }), FAKE_CODEX_LOG_FILE: logFile },
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-cmd-run-2", { isLive: () => true }),
    })
    const collected2: AgentEvent[] = []
    const reader2 = (async () => {
      for await (const event of session2.events()) collected2.push(event)
    })()
    await session2.compact!()
    const waitFor2 = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(r => setTimeout(r, 25))
      }
      throw new Error(`Timed out waiting for ${label}; collected2=${JSON.stringify(collected2)}`)
    }
    await waitFor2(
      () =>
        collected2.some(
          e =>
            e.type === "chunk" &&
            e.chunk.type === "data-system-event" &&
            e.chunk.data.kind === "compact_boundary" &&
            e.chunk.data.harness === "codex",
        ),
      "codex compact_boundary",
    )
    await reader2

    // Ended-thread continuation with followUpControl: { kind: 'compact' } -> thread/resume + thread/compact/start
    const session3 = await adapter.start({
      runId: "codex-cmd-run-3",
      cwd,
      prompt: "Full brief",
      continueSession: {
        sessionId: session2.sessionId,
        runId: "codex-cmd-run-2",
        message: "/compact",
        followUpControl: { kind: "compact" },
      },
      env: { ...buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }), FAKE_CODEX_LOG_FILE: logFile },
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-cmd-run-3", { isLive: () => true }),
    })
    const collected3: AgentEvent[] = []
    for await (const event of session3.events()) collected3.push(event)
    expect(
      collected3.some(
        e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "compact_boundary",
      ),
    ).toBe(true)

    const calls = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown>; codexHome: string })

    expect(calls.some(c => c.method === "skills/list")).toBe(true)
    expect(calls.some(c => c.method === "review/start")).toBe(true)
    expect(calls.filter(c => c.method === "thread/compact/start").length).toBeGreaterThanOrEqual(2)
    expect(calls.some(c => c.method === "thread/resume")).toBe(true)
    // Verify CODEX_HOME stayed isolated inside run stateDir (never user's real ~/.codex)
    for (const call of calls) {
      expect(call.codexHome.startsWith(stateDir)).toBe(true)
    }
  })

  it("CodexAdapter with mailbox enabled settles compact() and /review turns cleanly", async () => {
    const binary = resolve(import.meta.dirname, "fakes/fake-codex-commands.mjs")
    chmodSync(binary, 0o755)
    const stateDir = tempDir("mikka-codex-mailbox-cmd-")
    const cwd = await makeRepo()
    const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), binary })
    const mailbox = {
      tools: [{ name: "ping", description: "Ping test tool", inputSchema: { type: "object" as const, properties: {} } }],
      request: async () => ({ content: [{ type: "text" as const, text: "pong" }], isError: false }),
      close: async () => {},
    }

    const session = await adapter.start({
      runId: "codex-mb-compact-1",
      cwd,
      prompt: "KEEP_OPEN",
      mailbox,
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }),
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-mb-compact-1", { isLive: () => true }),
    })
    const events: AgentEvent[] = []
    const done = (async () => {
      for await (const event of session.events()) events.push(event)
    })()

    await session.compact!()
    await done

    expect(events.some(e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "compact_boundary")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })

    // Resumed continuation with mailbox enabled and followUpControl: { kind: 'compact' } as the very first turn
    const resumedCompact = await adapter.start({
      runId: "codex-mb-compact-resumed",
      cwd,
      prompt: "Full brief",
      mailbox,
      continueSession: {
        sessionId: session.sessionId,
        runId: "codex-mb-compact-1",
        message: "/compact",
        followUpControl: { kind: "compact" },
      },
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }),
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-mb-compact-resumed", { isLive: () => true }),
    })
    const resumedEvents: AgentEvent[] = []
    for await (const event of resumedCompact.events()) resumedEvents.push(event)
    expect(resumedEvents.some(e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "compact_boundary")).toBe(true)
    expect(resumedEvents.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })

    const reviewSession = await adapter.start({
      runId: "codex-mb-review-1",
      cwd,
      prompt: "KEEP_OPEN",
      mailbox,
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: stateDir } }),
      log: createLogger({ level: "silent" }),
      toolApproval: new ToolApprovalGate("codex-mb-review-1", { isLive: () => true }),
    })
    const reviewEvents: AgentEvent[] = []
    const reviewDone = (async () => {
      for await (const event of reviewSession.events()) reviewEvents.push(event)
    })()

    await reviewSession.send("/review mailbox check", { slashCommand: { name: "review", args: "mailbox check" } })
    await reviewDone

    expect(reviewEvents.some(e => e.type === "chunk" && e.chunk.type === "data-system-event" && e.chunk.data.kind === "local_command_output")).toBe(true)
    expect(reviewEvents.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
  })
})
