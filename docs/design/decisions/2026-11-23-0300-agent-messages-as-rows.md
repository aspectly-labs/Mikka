# Agent messages as collapsed rows; author headers in group chat only

- Date: 2026-11-23 03:00 UTC
- **Status:** Accepted (Alex, 2026-11-23, corrections on the integrated batch's Agent thread and Bot chat captures)
- Amends: [2026-11-22-2000-chat-look-as-lobehub](2026-11-22-2000-chat-look-as-lobehub.md): author headers in group chat only.
- Amends: [2026-11-22-2300-tool-calls-as-claude-and-lobehub](2026-11-22-2300-tool-calls-as-claude-and-lobehub.md): an Agent's message takes the tool rows' look.
- Restores: 2026-11-15 (Capy's thread, hosted `agent-thread.reply-like-capy.patch`): a single chat's reply is quiet.

## Context

The integrated batch headed every reply with the author's mark and name. A single thread then read as a group chat: the brief that started it showed as a speaker 「Coordinator」, then 「Codex」 answered. The activity line carried a green 「已解决」 pill beside 「工作了 0 秒」, a status pill Alex had already rejected, and the 0 seconds came from a run with no real duration. Codex cloud tasks, Cursor background agents, Claude Code sub-agents and Capy show a task's brief as the start of the work, not as another speaker, and Claude Code's desktop app shows a message to or from a sub-agent as one collapsed row.

## Decision

1. **Author headers in group chat only.** A Bot chat, the Coordinator chat and an Agent thread show no Bot or Agent mark and no name line over a reply (`author.quiet`). A group chat keeps LobeHub's header, the 28px mark and same-author runs. An event line has no header. Another person in a thread is still named over their words.
2. **An Agent's message is one collapsed row** (`components/chat/agent-message-row.tsx`) in the tool rows' look: 13px, muted, no icon and no status glyph, collapsed by default. It opens, as a tool row does, to the whole message in the one panel an opened tool shows, with a link to where it came from.
   - The brief that started a dispatched thread: 「Coordinator 派发了任务 · 校验聊天结构 ›」 where the thread starts; the panel opens the sender's chat.
   - A thread's report, question or finished summary arriving in a Bot chat: 「收到 Codex 的回复 · CHAT-1 校验聊天结构 ›」 (「收到 … 的消息」, 「… 提了问题」), the words as Markdown; the panel opens the thread. With nothing of its own to say, the event line stays as it was.
   - Group chat is the exception: every member speaks with a header there by design, so Bot-to-Bot exchanges stay as they are.
3. **The activity line is words alone.** No status or outcome badge beside 「工作了 2 分 3 秒」 in any state. A thread's status badge (blocked, paused, an outcome to judge) stands in its header (the official header's ⋯ menu), and the sidebar and task page keep their status.
4. **A real duration or none.** The line counts from the run's `startedAt` (its `createdAt` when it has none) to its `finishedAt`, or to now while it works. An ended run with no finish time, a finish before its start, or under a second shows no time, never 「0 秒」.

## Consequences

- `coordinator-chat.tsx` and `issue-thread-panel.tsx` pass a quiet author; the hosted slot heads a reply only for a header author.
- The thread read carries the run's `startedAt` and its dispatching Bot's id (`detail.botId`).
- `lib/coordinator/event-line.ts` keeps an Agent's own words from a report or question event (`message`), never the model's wrapper.
- Not yet covered: a follow-up a Bot sends into a working thread is stored as the owner's message (`lib/thread-dispatch.ts` sends with the owner's origin), so it shows as the person's own bubble, not as a row; the 子 Agent Crew card keeps a returned run's status and summary as it shipped.
