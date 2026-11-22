# Chat look as LobeHub (except avatars and composer tools)

- Date: 2026-11-22 20:00 UTC
- Status: accepted (Alex, 2026-11-22: an explicit approval for the paid-block changes it needs)
- Supersedes: [2026-11-22-1500-chat-reply-actions-on-hover](2026-11-22-1500-chat-reply-actions-on-hover.md), part 2 (the two-step rhythm). Its parts 1 (every action line waits for hover, keeping its space) and 3 (the read end adds no row) stand.
- Amends: [2026-11-22-1510-group-chat-as-bot-chat](2026-11-22-1510-group-chat-as-bot-chat.md), part 2: every chat's replies now have a header, not only a group's; the 680px reading column and the time dividers of part 1 are gone.
- Amends: 2026-11-15 (Capy's thread, hosted `agent-thread.reply-like-capy.patch`): a reply is no longer quiet in the Bot chat or an Agent thread.

## Context

Alex compared Mikka's chat with LobeHub's side by side (measured values in the batch's `lobe/metrics.json` and `lobe/diff.md`; LobeHub `src/features/Conversation/ChatItem`). The biggest differences: Mikka's column was 728px centred where LobeHub's fills the pane up to 960px; Mikka's rows stood 40-45px apart where LobeHub's stand about 60px because each keeps its action bar's row; the reply body sat 35px in from its avatar; the time stood beside the name and in centred dividers. Alex's rule: the chat looks the same as LobeHub's in every chat (Bot chat, Agent threads, group chat), with three exceptions.

## Decision

Every chat drawn by `ThreadScreen` (hosted affectUI Agent / Thread, `mikka.look: "lobehub"`, `patches/agent-thread.lobehub-look.patch`, `styles/globals.css`) looks as LobeHub's:

1. **Column.** It fills the conversation pane up to 960px with 16px gutters: 928px of reading width at 1440 with no side panel, the pane less 32px on a phone. The composer takes the same width.
2. **Rows.** Messages touch; each has 8px above and below and keeps its action bar's row (8px plus 28px) whether the bar shows or not, so messages stand about 60px ink to ink.
3. **Header.** A reply opens with the author's mark at 28px and the name at 14px/500 (LobeHub `Title.tsx`), 8px over the words; the words start at the mark's left edge. No time beside the name.
4. **No centred time.** LobeHub's conversation has no time or day divider (only its separate Channels view has a day divider), so Mikka draws none. The time is in each message's action bar, on hover.
5. **Action bar.** LobeHub's pill: 8px under the message, radius 8, 24px buttons, 2px inside, the faint fill (`--color-background-secondary-default`); on the left under a reply and on the right under the person's bubble (no fill there, as LobeHub). Mikka's own actions only: the time, Reply, Copy, the cited pages, reactions, and Edit and Regenerate where a thread has them. No More menu.
6. **The person's bubble.** 8px 12px plus LobeHub's 4px Markdown line inset (12px all round), radius 12, the faint fill; one line is 46px tall.
7. **Type.** The body stays 14px on 22.4px.
8. **Every block spans the words' width** (Alex, 2026-11-22): a tool group, its rows' right edges and an expanded result, a code block, a Markdown table (scrolling inside when wider), the 子 Agent Crew cards (one card fills the row), an artifact card, the choice card and the model notice are as wide as the message column. `tests/e2e/chat-block-widths.spec.ts` checks it on desktop and phone.

Exceptions, kept as Mikka's:

- **Avatars**: Mikka's marks (BotAvatar, LetterAvatar, HarnessMark), drawn at LobeHub's 28px.
- **Composer tools**: Mikka's + and Send; LobeHub's row of six tool icons and its second row are not added.
- **Same-author runs merge as Slack's** (2026-11-22-1510): one header, the run's messages 4px apart, the earlier messages' bars float at the row's end on hover; only the run's last keeps its bar's row.

## Consequences

- `MessageTimeStamp` and the 15-minute grouping (`stampStarts`) are removed; `lib/chat-time-stamps.ts` keeps the words for the bar's time.
- `coordinator-chat.tsx` and `issue-thread-panel.tsx` give their replies a header author; the hosted slot heads every reply and no longer passes `quiet`.
- The template's `mikka.before` slot stays, unused.
- Remaining differences from LobeHub besides the exceptions: LobeHub reserves a 19px row above the person's bubble for the time on hover (Mikka keeps the time in the bar); a tool's row and result sit one tree step in from the group's head (they end where the words end).
