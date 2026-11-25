# Chat look as LobeHub (except avatars and composer tools)

- Date: 2026-11-22 20:00 UTC
- **Status:** Superseded in part by [2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md](2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md) (§1 bordered action-bar pill and §5 960px column overrides retired)
- Supersedes: [2026-11-22-1500-chat-reply-actions-on-hover](2026-11-22-1500-chat-reply-actions-on-hover.md), part 2 (the two-step rhythm). Its parts 1 (every action line waits for hover, keeping its space) and 3 (the read end adds no row) stand.
- Amends: [2026-11-22-1510-group-chat-as-bot-chat](2026-11-22-1510-group-chat-as-bot-chat.md), part 1: the 680px reading column and the time dividers are gone. Its part 2 stands: only a group's replies have a header.
- Amended 2026-11-23 (Alex; [2026-11-23-0300-agent-messages-as-rows](2026-11-23-0300-agent-messages-as-rows.md)): **author headers in group chat only.** A single chat (a Bot chat, the Coordinator chat, an Agent thread) keeps the quiet reply of 2026-11-15 (Capy's thread, hosted `agent-thread.reply-like-capy.patch`, `author.quiet`): no Bot or Agent mark and no name line over a reply. Everything else here applies to every chat.

## Context

Alex compared Mikka's chat with LobeHub's side by side (measured values in the batch's `lobe/metrics.json` and `lobe/diff.md`; LobeHub `src/features/Conversation/ChatItem`). The biggest differences: Mikka's column was 728px centred where LobeHub's fills the pane up to 960px; Mikka's rows stood 40-45px apart where LobeHub's stand about 60px because each keeps its action bar's row; the reply body sat 35px in from its avatar; the time stood beside the name and in centred dividers. Alex's rule: the chat looks the same as LobeHub's in every chat (Bot chat, Agent threads, group chat), with three exceptions.

## Decision

Every chat drawn by `ThreadScreen` (hosted affectUI Agent / Thread, `mikka.look: "lobehub"`, `patches/thread-lobehub-look.patch`, `styles/globals.css`) looks as LobeHub's:

1. **Column.** It fills the conversation pane up to 960px with 16px gutters: 928px of reading width at 1440 with no side panel, the pane less 32px on a phone. The composer takes the same width.
2. **Rows.** Messages touch; each has 8px above and below and keeps its action bar's row (8px plus 28px) whether the bar shows or not, so messages stand about 60px ink to ink.
3. **Header, group chat only** (Alex, 2026-11-23). In a group, a reply opens with the author's mark at 28px and the name at 14px/500 (LobeHub `Title.tsx`), 8px over the words; the words start at the mark's left edge. No time beside the name. A single chat's reply has no header: its words alone, as Capy's (decision 2026-11-15); an event line has none either.
4. **No centred time.** LobeHub's conversation has no time or day divider (only its separate Channels view has a day divider), so Mikka draws none. The time is in each message's action bar, on hover.
5. **Action bar.** LobeHub's pill: 8px under the message, radius 8, 24px buttons, 2px inside, the faint fill (`--color-background-secondary-default`); on the left under a reply and on the right under the person's bubble (no fill there, as LobeHub). Mikka's own actions only: the time, Reply, Copy, the cited pages, reactions, and Edit and Regenerate where a thread has them. No More menu.
6. **The person's bubble.** 8px 12px plus LobeHub's 4px Markdown line inset (12px all round), radius 12, the faint fill; one line is 46px tall.
7. **Type.** The body stays 14px on 22.4px.
8. **Every block spans the words' width** (Alex, 2026-11-22): a tool group, its folded summary (a full-width 32px row box), its rows (no tree indent; 32px tall, 8px apart, as LobeHub's) and an expanded result, a code block, a Markdown table (scrolling inside when wider), the 子 Agent Crew cards (one card fills the row), an artifact card, the choice card and the model notice are as wide as the message column. `tests/e2e/chat-block-widths.spec.ts` checks it on desktop and phone.

Exceptions, kept as Mikka's:

- **Avatars**: Mikka's marks (BotAvatar, LetterAvatar), drawn at LobeHub's 28px, and only in group chat (Alex, 2026-11-23).
- **Composer tools**: Mikka's + and Send; LobeHub's row of six tool icons and its second row are not added.
- **Same-author runs merge as Slack's** (2026-11-22-1510): in a group one header, the run's messages 4px apart, the earlier messages' bars float at the row's end on hover; only the run's last keeps its bar's row.

## Consequences

- `MessageTimeStamp` and the 15-minute grouping (`stampStarts`) are removed; `lib/chat-time-stamps.ts` keeps the words for the bar's time.
- `coordinator-chat.tsx` and `issue-thread-panel.tsx` give their replies a quiet author (author headers in group chat only, Alex, 2026-11-23); `group-chat-view.tsx` gives each speaker a header author. The hosted slot heads a reply only for a header author and keeps every other reply quiet.
- The template's `mikka.before` slot stays, unused.
- The code block (beUI's, `components/agents/code-block.tsx`, used as shipped elsewhere) takes LobeHub's 8px corners and 32px header in the chat, by the hosted thread's CSS; its copy button and line numbers stay.
- Remaining differences from LobeHub besides the exceptions: LobeHub reserves a 19px row above the person's bubble for the time on hover (Mikka keeps the time in the bar); Mikka's folding of tools stays its own; the code block keeps its 420px max height, line numbers and copy button.
