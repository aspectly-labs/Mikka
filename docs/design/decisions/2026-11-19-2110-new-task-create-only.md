# 新建任务只登记；指派给 Bot 会唤醒它

- **Status:** Accepted

2026-11-19。Alex 指出新建任务逻辑和 Capy 不一致，要求按 Capy 的做法做。

## Capy 怎么做

- 新建 issue 只登记一条记录，不开线程、不派发。
- 把 issue 指派给 Captain 会通知该 Captain 并唤醒它；Captain 自己决定要不要开工。
- 证据：mikka-hosted-ui `docs/research/2026-11-27-public-evidence.md`（§ new-task-create-only）。

## 决定

- 新建任务弹窗只登记：标题、描述（@ 提及）、Status、Priority、Assignee（人或 Bot）、Due date、Labels、Access、附件、语音、Create more。
- 指派、评论、@ 提及一个 Bot 时，往该 Bot 的线程投一条通知并触发一轮，由 Bot 决定是否派发。
- 原来弹窗里的 Bot / Machine / Agent / Profile 与「创建并派发」移到任务详情的「Start work」。
