#!/usr/bin/env node
// Fake Claude Code CLI for #3333 scripted-model slash-command acceptance tests.
// Records every received user frame (including `client_composed`) to a log file,
// emits `system/init` with `slash_commands`, `terminal_slash_commands`, `skills`,
// responds to `initialize` with `commands`, and emits `local_command_output`,
// `status`, `compact_boundary`, and `commands_changed` without calling any live model.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const argv = process.argv.slice(2)
const flag = name => {
  const inline = argv.find(arg => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const idx = argv.indexOf(name)
  return idx >= 0 ? argv[idx + 1] : undefined
}
const sessionId = flag("--session-id") ?? flag("--resume") ?? "fake-session"
const logFile = process.env.FAKE_CLAUDE_LOG_FILE
const out = event => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...event })}\n`)
const record = entry => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

let initialized = false
const lines = createInterface({ input: process.stdin })
lines.on("line", line => {
  if (!line.trim()) return
  const frame = JSON.parse(line)
  if (frame.type === "control_request") {
    const req = frame.request ?? {}
    if (req.subtype === "initialize") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: {
            commands: [
              { name: "compact", description: "Compact context window", argumentHint: "[instructions]" },
              { name: "review", description: "Review repository changes", argumentHint: "[files]" },
              { name: "linear:triage", description: "Triage Linear issues (MCP)", argumentHint: "<team>" },
              { name: "login", description: "Sign in" },
              { name: "model", description: "Change model" },
              { name: "terminal-only", description: "Interactive TUI setup" },
            ],
            agents: [],
            output_style: "default",
          },
        },
      })
      return
    }
    out({
      type: "control_response",
      response: { subtype: "success", request_id: frame.request_id, response: {} },
    })
    return
  }

  if (frame.type === "user") {
    const text = Array.isArray(frame.message?.content)
      ? frame.message.content.map(c => (typeof c?.text === "string" ? c.text : "")).join("")
      : String(frame.message?.content ?? "")
    record({
      text,
      client_composed: frame.client_composed === true,
    })

    if (!initialized) {
      initialized = true
      out({
        type: "system",
        subtype: "init",
        uuid: "init-1",
        model: "claude-sonnet-4-5",
        slash_commands: ["compact", "review", "login", "logout", "config", "model", "permissions", "mcp", "resume", "terminal-only", "audit-ui", "mcp__github__summarize"],
        terminal_slash_commands: ["terminal-only", "vim"],
        skills: ["audit-ui"],
        mcp_servers: [{ name: "github", status: "connected" }],
        tools: [],
        cwd: process.cwd(),
        apiKeySource: "user",
        claude_code_version: "2.1.0",
        permissionMode: "bypassPermissions",
      })
    }

    if (text === "KEEP_OPEN") {
      out({ type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "Ready." }] } })
      return
    }

    if (!frame.client_composed && text.startsWith("/compact")) {
      out({ type: "system", subtype: "status", uuid: "st-1", status: "compacting" })
      out({
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb-1",
        compact_metadata: { trigger: "manual", pre_tokens: 42000, post_tokens: 8000, duration_ms: 1200 },
      })
      out({ type: "system", subtype: "local_command_output", uuid: "lco-1", content: `Compacted conversation (${text})` })
      out({ type: "system", subtype: "status", uuid: "st-2", status: null, compact_result: "success" })
      out({ type: "result", subtype: "success", is_error: false, result: "compacted", usage: { input_tokens: 10, output_tokens: 2 } })
      return
    }

    if (!frame.client_composed && text.startsWith("/review")) {
      out({ type: "system", subtype: "local_command_output", uuid: "lco-2", content: `Review output for: ${text}` })
      out({
        type: "system",
        subtype: "commands_changed",
        uuid: "cc-1",
        commands: [
          { name: "compact", description: "Compact context window", argumentHint: "[instructions]" },
          { name: "review", description: "Review repository changes", argumentHint: "[files]" },
          { name: "deploy-check", description: "Run deploy checks" },
          { name: "config", description: "Blocked config" },
        ],
      })
      out({ type: "result", subtype: "success", is_error: false, result: "reviewed", usage: { input_tokens: 12, output_tokens: 4 } })
      return
    }

    out({
      type: "assistant",
      message: {
        id: "msg-echo",
        content: [{ type: "text", text: `Echo(${frame.client_composed === true ? "literal" : "normal"}): ${text}` }],
      },
    })
    out({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 5, output_tokens: 3 } })
  }
})
