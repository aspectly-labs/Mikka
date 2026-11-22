# Stop is the composer's send button, in every chat; Esc stops

- Date: 2026-11-22 16:00 UTC
- Source: Alex, 2026-11-22, on a screenshot of an Agent thread while a run worked: a yellow 「进行中」 badge beside 「正在工作 · 18 分」, and a separate 停止 pill above the composer. His standing rule: behave like mature agent apps without asking.
- Status: accepted
- Supersedes: [2026-11-02-0301](2026-11-02-0301-esc-in-a-thread-composer.md) (Esc in a thread composer does not stop the thread). [2026-11-01-1155](2026-11-01-1155-stop-a-bot-reply.md) stands and now holds for every chat.

## What the references do

- **Capy 0.9.2** (renderer, `shared/composer/composer.tsx`): one button. With an empty composer while a run works it is 「Stop run」 (an accent icon button, tooltip with ⌘.); once something is typed it is Send, and Enter mid-run steers, interrupts or queues by a setting (Steer by default). Stop run stays on ⌘. while the composer has focus, words or not.
- **LobeHub** (`src/features/ChatInput/SendArea/SendButton.tsx`, `Conversation/ChatInput/utils.ts`): Stop for the whole run; once a follow-up is typed, Send appears beside Stop and Enter queues it. "The run is indicated once": a running turn shows a static Stop, never a second spinner. No Esc shortcut.
- **ChatGPT, Claude (web and desktop)**: the send button turns into a filled square Stop while the answer streams, in the same place.
- **Claude Code, Codex**: Esc interrupts the running turn; messages typed meanwhile queue or steer.
- **Cursor**: the Agent composer's Send turns into Stop while it works; a follow-up typed meanwhile is queued.

None of them puts Stop anywhere else while the composer is on screen, and none shows a second status beside its working indicator.

## Decision

1. **One Stop, the composer's send button.** In a Bot chat, an Agent thread and a group chat alike: while it works and the composer is empty, the send button is Stop (a filled square). Typed words turn it back into Send; the message queues or steers as the chat's delivery mode says. This is Capy's pattern, and the one decision 1155 set for a Bot chat; the hosted thread screen's own 停止 pill above the composer is gone (`mikka-hosted-ui` `patches/agent-thread.stop-in-send.patch`).
2. **Esc stops, in every chat, also with words typed**, as Claude Code and Codex. Esc in the composer of a thread no longer only leaves the field while the run works. An open `/` or reference menu takes Esc first, and a composing input method keeps it. When nothing runs, Esc leaves the field and then goes back, as before.
3. **The thread header's stop stands in only where the composer cannot**: a run waiting for an answer (its composer sends, usability review N1), a reader without a composer, and the thread's other views (改动, 验收, Artifact). While the composer shows Stop, the header has none.
4. **The queue / steer choice waits for a draft.** While it works, the choice of how a message goes (排到下一轮, 插话到当前轮) stands beside the composer only once something is typed, in a Bot chat and a thread alike (`turnChoiceShown`); an empty composer is the Stop button alone.
5. **Stop from the moment a send is accepted, and the sidebar spins from then too**, as ChatGPT and Claude. One state feeds both: `coordinatorTurnStoppable` (a running turn, input eve accepted, and accepted input still waiting for its turn). Stop shows with no delay: it is the send button's own face, so nothing moves. Accepted input no turn has taken yet is ended on the server under the chat's lock (`lib/coordinator/stop-before-turn.ts`): it stays as the person's message with a stopped reply under it (「已停止」), and no turn ever starts for it. Input already on its way to eve (claimed by the outbox, or accepted by eve the same moment) is marked, and its acceptance stops the turn it starts. Owner-only, by the person's own bot.
6. **The activity line is the run's one indicator.** 「正在工作 · 18 分」 and 「在等你回复」 stand alone; the status badge beside them only shows what the line does not say (a run that ended blocked, paused, or with an outcome to judge).

## Why Esc may now stop a long run

Decision 0301 kept Esc from stopping a thread because Esc dismisses things and a thread may have worked for an hour. The coding agents Mikka runs, Claude Code and Codex, are themselves stopped with Esc, and their users expect the same key here. Esc reaches the composer's stop only while the composer has focus, after any menu in it took its own Esc, and a stopped thread continues with the next message.
