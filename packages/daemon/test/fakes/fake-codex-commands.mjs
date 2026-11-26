#!/usr/bin/env node
// Fake Codex app-server fixture for #3333 scripted-model slash-command acceptance tests.
// Records received JSON-RPC calls (skills/list, thread/compact/start, review/start, turn/start)
// and emits contextCompaction & exitedReviewMode items without contacting any live model.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const logFile = process.env.FAKE_CODEX_LOG_FILE
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`)
const record = entry => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

let turn = 0
const threadId = "codex-cmd-thread-1"
const lines = createInterface({ input: process.stdin })
lines.on("line", line => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (!method) return
  record({ method, params, codexHome: process.env.CODEX_HOME })
  if (id === undefined) return

  if (method === "initialize") {
    return send({ id, result: { userAgent: "codex_cli_rs/0.163.0 fake-commands" } })
  }
  if (method === "thread/start" || method === "thread/resume") {
    return send({ id, result: { thread: { id: params?.threadId ?? threadId }, model: "gpt-5.3-codex" } })
  }
  if (method === "skills/list") {
    return send({
      id,
      result: {
        data: [
          {
            cwd: process.cwd(),
            skills: [
              { name: "deploy-check", shortDescription: "Verify deployment readiness", enabled: true },
              { name: "disabled-skill", shortDescription: "Should be skipped", enabled: false },
            ],
          },
        ],
      },
    })
  }
  if (method === "thread/compact/start") {
    const turnId = `compact-turn-${++turn}`
    send({ id, result: {} })
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null } } })
    send({ method: "item/started", params: { threadId, turnId, item: { type: "contextCompaction", id: `cmp-${turn}` } } })
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "contextCompaction", id: `cmp-${turn}` } } })
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } })
    return
  }
  if (method === "review/start") {
    const turnId = `review-turn-${++turn}`
    send({ id, result: { turn: { id: turnId }, reviewThreadId: threadId } })
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null } } })
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "exitedReviewMode", id: `rev-${turn}`, review: `Reviewed target: ${JSON.stringify(params?.target)}` },
      },
    })
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } })
    return
  }
  if (method === "turn/start") {
    const turnId = `turn-${++turn}`
    const prompt = params?.input?.[0]?.text ?? ""
    send({ id, result: { turn: { id: turnId } } })
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null } } })
    if (prompt === "KEEP_OPEN") return
    send({
      method: "item/completed",
      params: { threadId, turnId, item: { type: "agentMessage", id: `msg-${turn}`, text: `Codex received: ${prompt}` } },
    })
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } })
    return
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
})
