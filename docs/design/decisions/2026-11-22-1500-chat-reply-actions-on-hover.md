# Message actions on hover, and a two-step chat rhythm

- Date: 2026-11-22 15:00 UTC
- Status: accepted
- Amended by: [2026-11-22-1700-chat-edit-and-regenerate](2026-11-22-1700-chat-edit-and-regenerate.md) (Edit and Regenerate join the line as icons; still no More menu)
- Supersedes in part: [2026-11-10-2002-chat-reply-actions-and-waiting](2026-11-10-2002-chat-reply-actions-and-waiting.md) (A, "reply actions are always there"). Its part B (the waiting sentence) stands.

## Context

Alex finds the chat loose. On 2026-11-22 he asked to follow LobeHub's chat spec, whose study found that LobeHub is not tighter in raw spacing; it feels calmer because nothing sits between messages at rest. Every message's action bar is hidden until hover, with its space kept (LobeHub `features/Conversation/ChatItem/revealStyles.ts`), and the rhythm has two steps: 8px inside a message, 16px between messages (`ChatItem.tsx:131-132`).

Alex's approved Figma, file `zPe5LKycb2XuT1ivCLRw07`, page 1318:2, section 15 (「消息 · hover 操作 + More 菜单」, `1318:59`) also shows the message's time, Reply and Copy on hover. Mikka was the odd one out: since decision 2026-11-10-2002 A, a Bot or Agent reply kept its line on screen, while the person's own line and the thread panel's lines already waited for hover. That made two behaviours for one line, and a row of icons under every reply.

## Decision

1. **Every message's action line waits for hover or focus.** The person's and the reply's alike, in every chat drawn by `ThreadScreen` (Bot chat, thread, group chat, the narrow panel) and in the thread panel. `ReplyActions` always uses `HOVER_ACTIONS` (`components/chat/copy-action.tsx`); the `hover` prop and `REPLY_ACTIONS` are gone.
   - At rest the line is invisible (opacity 0) but keeps its space, so nothing shifts when it appears.
   - It appears while its message is hovered or holds keyboard focus, fading over `--motion-fast` (R-103: opacity is a state change); reduced motion turns the fade off.
   - On a touch screen (`pointer: coarse`) it is always visible, because there is no hover.
2. **Two-step rhythm.** A message's action line sits 8px under its body and 16px above the next message. The line is Mikka's own (`ReplyActions`), so its margins take up the difference to the affectUI thread's own gaps, which stay as shipped (`mikka-hosted-ui` `styles/globals.css`, the `--hth-*` gaps). The template's column, reply and bubble gaps are not changed.
3. **The read end adds no row.** The last unread reply's `VisibleReadEnd` rides at the end of its action line instead of an empty text part, which had added 13px (the reply's 12px gap and a 1px span) under it. A reply without a line (no words) still marks its end with a part of its own.

## Consequences

- R-83 and `components.md` now say the line under a reply waits for hover; `chat-tool-calls.md` follows.
- A message without an action line (an event line, a reply still streaming, a reply with no words) keeps the template's own gaps.
- Tests pin the hover classes on every line and the read end inside the line.

## Alternatives rejected

- Keeping A (always visible, muted): Figma section 15 and LobeHub both show the line on hover, and Alex asked for LobeHub's calm.
- Hiding the line with `display: none` or collapsing its height at rest: the messages below would jump as the pointer passes.
- Changing the affectUI thread's own gaps (`.ui-th-col`, `.ui-th-agent`): that restyles a paid block, which is used as shipped.
