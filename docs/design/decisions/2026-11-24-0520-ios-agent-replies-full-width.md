# iOS: a bot's and an Agent's replies are full-width text, without the grey bubble

- Date: 2026-11-24 05:20 UTC
- Source: Alex, a comment on the iOS usability audit (Nielsen 10 heuristics), on the question 「助手回复去掉气泡？」: 「确认去掉气泡」. The coordinator relayed that every chat screen on the phone follows, not only the thread screen.
- Rule: R-14 (amended for iOS)
- Replaces: 2026-10-25 「One-to-one chats keep the grey bubble for a bot's text」 and the 2026-10-27 line 「Bot text stays in its grey bubble」 in [decisions.md](../decisions.md), on iOS.

## Context

The audit compared the coding-agent and chat apps on Mobbin: ChatGPT (and Codex inside it), Claude, Cursor and GitHub Copilot draw an assistant's reply as full-width body text with no bubble; only the person's own message sits in a bubble. Long answers, lists and code read better across the whole line than inside an 86% grey bubble.

## Decision

- On iOS, a bot's or Agent's words (thread screen, task conversation, Bot chat, Coordinator chat, OpenUI text replies, group chat) are full-width text in the list's gutter, with no background (`BotText` in `apps/mobile/components/chat.tsx`).
- The person's own words keep the blue bubble (R-14).
- Group chat keeps its author header (mark and name) over each run, so speakers stay apart without a bubble.
- Cards (approvals, OpenUI cards, thread cards, documents) are unchanged.

## Consequences

- The web is unchanged by this record.
