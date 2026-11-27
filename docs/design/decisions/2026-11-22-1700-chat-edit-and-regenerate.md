# Edit and Regenerate on the message line

- Date: 2026-11-22 17:00 UTC
- **Status:** Accepted (Alex, 2026-11-22)
- Amends: [2026-11-22-1500-chat-reply-actions-on-hover](https://github.com/aspectly-labs/mikka-hosted-ui/blob/main/docs/design/decisions/2026-11-22-1500-chat-reply-actions-on-hover.md) (the line's contents) and the "no More menu" note in `components/chat/reply-actions.tsx`.

## Context

Claude and ChatGPT let a person edit what they sent and ask for a reply again, from icons on the line under the message. Mikka had neither in a Bot chat, and an Agent thread hid both behind text buttons that opened a dialog. Alex decided on 2026-11-22 to add them as icons on the hover line, next to Reply and Copy, still with no More menu.

An action must do what it says, durably. What it can honestly do depends on the chat:

- **Bot chat.** Mikka stores the chat (`coordinator_messages`); eve holds the Bot's model history in its session. eve has no rewind or truncate, but it can `clear()` a session's model history in place and take prior history with the next message (`history` from the channel's `onMessage`).
- **Agent thread.** The daemon's Claude Code or Codex session has changed files, made commits and maybe a pull request. None of it can be rewound from the chat. Mikka already starts a new run from a chosen message, keeping existing work, as a stored version (`lib/thread-reply-versions.ts`, `thread_reply_versions`).
- **Group chat.** Being moved onto the same thread block; not changed here.

## Decision

1. **The line.** The person's message: time, Reply where offered, Copy, **Edit** (pencil). A reply: Reply, Copy, **Regenerate** (refresh), then its sources and reactions. A turn with earlier versions shows **‹ n / N ›** before Reply on the person's message. All are icons with the shared tooltip; the line still waits for hover or focus and is always shown on touch (decision 2026-11-22-1500). There is still no More menu.
2. **Bot chat: only the latest turn, and only a turn of words.** Edit is on the person's last message, Regenerate on the reply to it. Neither shows when that turn ran a tool, dispatched a thread, showed an artifact, came from a task request or schedule, or carries photos, an artifact quote, browser notes or a 建议 card; nor while the Bot works or a message waits. Those turns changed something outside the chat that a rewrite would not undo, or hold something an edit box cannot keep. The server checks the same rules (`lib/coordinator/turn-revisions.ts`).
3. **Bot chat: what a rewrite does.** In order (`lib/eve/revise.ts`):
   1. the turn's rows are marked `mikkaSuperseded` with a revision id (`bot_chat_revisions`), so they leave the chat, the Bot's history import and the prompt history, and stay stored;
   2. eve clears the session's model history;
   3. the same or the edited words go as a new message, and the channel gives the chat's remaining history back with it, once.
   If eve refuses the clear, the turn comes back. If its outcome is unknown, the same request retried finishes it.
4. **Bot chat: versions.** Edits and regenerations of one turn share a slot. ‹ n / N › pages through the earlier versions' words (the person's message and the reply's text). Only the newest version is live: the Bot remembers it, and the chat continues from it. An earlier version only reads back.
5. **Agent thread.** Edit (on the person's own message) and Regenerate (on an Agent reply) are icons that open the existing version dialog. It says that a new run starts at that message and that existing commits, pull requests and replies stay; its version list is unchanged. Nothing is rewound.

## Consequences

- The Bot's history after a rewrite is text only, as when a session starts from prior history: earlier tool calls survive only as the words of the replies around them.
- Earlier turns cannot be edited. Allowing them would rewind every turn after them, and their tool effects would remain.
- Group chat needs the same per-message `onEdit` / `onRegenerate` and a revision store for its own transcript before it can offer either.

## Alternatives rejected

- A More menu holding Edit and Regenerate: Alex chose icons on the line, as Claude and ChatGPT do.
- Ending the eve session and starting a new one from prior history: it replaces the session the chat is bound to; `clear()` keeps the same session and address and only empties its model history.
- Deleting the replaced rows: the earlier version would be lost and positions would move under readers that cite them.
- Rewinding an Agent thread's files: the machine's changes, commits and pull requests are not the chat's to undo.
