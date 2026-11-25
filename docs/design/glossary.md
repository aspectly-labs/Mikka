# Product and execution glossary

This file is the single definition of these words. Specs, designs, issues and
code comments use them in this sense. Follow the source order in [the design entry point](README.md) when a
newer accepted decision changes a definition here.

The thread and task definitions follow Alex’s [November 13 decision](https://github.com/alexj11324/Mikka/issues/2262) and [task detail decision](https://github.com/alexj11324/Mikka/issues/2271). The execution vocabulary dates to October 24. Thread (线程) and run (运行) are the only two words for an Agent's work (Alex, 2026-11-15).

## Threads, tasks and execution

| Word | 中文 | What it is | Where it shows | Its name |
| --- | --- | --- | --- | --- |
| **Bot** | Bot | Chats with people. Does web tasks itself through sub-agents (分身, R-72), each with its own browser, and dispatches real tasks such as coding to threads. The user creates it (Grok Bot style) and can add it, with other bots and people, to a thread (a group chat is a thread with members). The Coordinator is a bot too. Stored in its own `bots` table (name, colour, shape) and runs on Mikka's own AI SDK on Vercel; it is not a row in `agents`. | **Bot list** (left column), one row per bot. | The bot's own name, e.g. "Mikka Frontend". |
| **Thread** | 线程 | What a person opens, names and replies to: an Agent's root run in `agent_runs` and the continuations and retries that keep its `rootRunId` (`lib/run-chain.ts`). It has its own title, per-user read position, pin and archive state, and can exist without a task. Code says `thread`. | The 线程 directory, the Bot sidebar and a task's thread list. | Its stored title or the existing fallback. |
| **Bot chat** and **group chat** | Bot 线程 / 群聊 | A Bot chat is the message history addressed to the selected Bot or Coordinator. A group chat is a thread with members: people are added from new thread or the thread header's 「成员」 (「添加成员」), it is listed with threads with a multi-person mark, and there is no separate 群聊 section, object or 新建群聊 dialog ([2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rule 6). A Bot can take part in other chats. Existing chat storage is the `conversations` table family. | The selected chat or thread. | Its Bot name, or the thread's title. |
| **Task** | 任务 | A unit of work with its own ID, title, assignee and status. It can link to several threads and PRs. | Board, task list and task detail. | Its task title and issued identifier. |
| **Run** | 运行 | One execution: one row in `agent_runs`. A thread's runs are its root run and its continuations and retries; there is no third word for the chain. | A thread opens through its root run ID, and its transcript keeps the run order. Existing run or thread deep links resolve through their original access checks. Run result (运行结果) and 重试 name one run. | The thread's title for the product entry; the run identity when inspecting execution. |

How they connect: a person chats with a bot (center). The bot dispatches
real tasks such as coding to threads, which do the work (right). A web task
stays with the bot: one of its sub-agents (分身) does it in its own browser,
it shows only as a card in the chat, outside the task lists, and the bot
reports the result itself (R-72). A thread is run by an Agent (Claude Code,
Codex). A bot never runs, owns or does a thread; it only dispatches it, and
the UI says 「<Bot> 派出的线程」 or 「<Bot> 派出」, never 「<Bot> 的线程」 or
「所属 Bot」. A thread is never drawn with the bot's avatar. Task rows show the task's own
state icon, and attempts show their result icon. The Agent's mark identifies
the coding Agent where it is named (R-52, R-74, R-78). A bot does no coding
work itself: an Agent (Claude Code, Codex) runs every thread. A cloud thread runs on its own thread machine,
not on the dispatching bot's machine (`cloud-computer-backend.md` § 2).

## Workspaces

| Word | 中文 | What it is |
| --- | --- | --- |
| **Account** | 账号 | The person: 账户, security, 偏好, 通知, profile memory (个人资料类记忆), 密钥与登录, 设备 and 「模型与订阅」. The same in every workspace. |
| **Personal workspace** | 个人工作区 | One per person. Only that person's bots, chats, tasks, threads and their memory; personal 计费 and 用量; no team settings. |
| **Shared workspace** | 共享工作区 | Members, 身份与访问, 密钥与环境, 审计日志, team 用量 and 计费. Workspace policies live on the page of the object they govern; there is no 团队权限 page ([2026-11-26-0100](decisions/2026-11-26-0100-settings-structure-from-benchmark.md)). Nothing moves between it and a personal workspace. |
| **Organization** | 组织 | Manages membership, organization connections, policies and billing across attached Workspaces. Each Workspace remains an independent tenant; an Organization role does not confer private content access. |
| **Resource owner** | 所有者 | Manages a Task, Thread, Bot or Artifact's access and controlled ownership transfer. Ownership does not bypass a private ancestor or a revoked Workspace membership. |
| **Actor** | 操作者 | The authenticated person or service principal responsible for a message or operation. Kept separately from the Thread Owner, execution identity, credential owner and payer. |

Decision: [2026-11-01-2310](decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md).
Collaboration and financial authority: [2026-11-10-0017](decisions/2026-11-10-0017-collaboration-governance.md).

## Rules for designs

- The left column is the **bot list**. In the hosted shell a Bot expands
  its dispatched tasks and Agent work below its own row, like Capy's Captains
  ([2026-11-10](decisions/2026-11-10-1317-capy-sidebar-and-task-layout.md)).
  Bot and group rows keep their own avatars. A child is named for its work;
  a task carries its own state, and the Agent's mark identifies its executor.
  This navigation does not change the distinction between dispatching Bot,
  task and executing Agent.
- Task lists show one row per task. The workspace 线程 directory opens threads directly, including those without a task. A task’s thread list opens the same thread with the same access checks.
- The right column opens on **概览** (Overview), the first tab of one flat
  tab level: a thread's 待办, 子 Agent, 分支与 PR, 产出, 自动化 and 端口, or a Bot
  thread's 需要你, 进行中, 线程, 子 Agent and PR. The other tabs are the kinds the
  ＋ picker opens and the `task:` / `thread:` tabs the chat opens; a subagent
  opens as a read-only `thread:` tab. Phones have no tab strip ([2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rules
  10, 11, 20; `rules.md` R-02, R-50).
- Where work starts (new thread, task, Bot, automation) one picker bar reads
  **环境 · 仓库/分支 · 运行位置** ([2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rule 3).
- There is no projects page and no 收件箱 page. What needs the person shows on
  the Bot's 概览, at the top of 与我相关, as unread dots on thread rows and in
  the **notification bell** (通知) beside the avatar
  ([2026-11-25-2330](decisions/2026-11-25-2330-owner-decisions-chat-memory-views-projects.md) rule 7, [2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rule 7).
- Choosing another bot on the left changes the center chat and the right
  column's dispatched tasks and computer together.
- Inside one thread, read its runs oldest first and address the latest eligible run when replying. A task can link to several distinct roots. Activity shows human-level changes and comments. Its Work section presents the linked threads, PRs and expandable run progress.
- **Attempt** is an internal data term only (`factory_attempts`, a thread's
  runs). User-facing copy never says 「尝试」 or "attempt".

## Task status (状态) and Agent mark

A task has one status, its status field: 待整理, 待办, 进行中, 评审中, 已完成,
已取消 or 重复. Every surface that shows a task shows that status, with the
same icon and word
([decision](decisions/2026-11-13-1405-one-task-status.md)). It advances with
the work (Agent starts → 进行中, submitted or PR delivered → 评审中, PR merged
or accepted → 已完成) and the person can always set it.

The **Agent mark** is one small glyph that says what a thread's Agent is
doing: working, waiting for the person, or error. It belongs to the
thread (after its title, on its dispatch card, on the board card's
line), never beside a task's status icon: a task chip has exactly one icon.
It is not a status and has no group, column or status word. What needs the person is
in the notification bell and on the Bot's 概览 (no 收件箱 page).

受阻 is a board column for a task the person flagged or one blocked by an open
task. It is not a status either.

A **thread** (线程: a run and the runs that continue it) is named by
its own bounded short title, the same wherever it is named; a task keeps the
title it was given, at any length.

_Avoid_: 运行中 / 排队中 / 等待你 / 失败 as a task's status, a list grouped by
them, 「任务状态」 for the Agent mark.

## Run result (运行结果)

How one run came out, in one set of words on every surface that shows it: the
task page's 活动 rows, the right column's 活动 rows and the task's thread
(`hooks/use-run-result.ts`), and iOS (`MobileCore.attempts`). A 活动 row shows
the result of its Agent stretch's latest run. It is the run's own result, never
the task's status: task status, Factory stage and run result are different
things (#1687).

| Result | 中文 | English | When |
| --- | --- | --- | --- |
| running | 运行中 | Running | The run is working. |
| queued | 排队中 | Queued | The run waits for a machine. |
| waiting | 等你回复 | Needs your reply | The run waits on the person; its reason may say more (等你确认, 待审阅). |
| done | 完成 | Done | The run finished its work. |
| failed | 失败 | Failed | The run failed. |
| blocked | 受阻 | Blocked | The run stopped on something it cannot fix itself, such as 额度用完. |
| idle | 暂不处理 | On hold | The run decided there is nothing to do now. |
| ended | 已结束 | Ended | An earlier run left waiting while the thread went on. |

_Avoid_: 「换 Codex」 or 「换 Codex 继续」 (a row or a change of Agent is labelled by the
Agent's own mark and name), 已解决 for a run (a thread group word, R-52), 已替换, 进行中 for a run
(进行中 is the board column), 尝试.

## Other words

Decided by Alex, 2026-10-28.

| Word | 中文 | What it is |
| --- | --- | --- |
| **Artifact** | Artifact | Something a thread produces for the person to look at or accept, such as an acceptance (验收), a PR, a document or a web page. The word is never translated (not 产物, 工件 or 成果). Lives on the Artifact rail page (R-56). An open thread's header always has an Artifact button, and the message that finishes a thread carries its Artifact card (Alex, 2026-11-06). |
| **Agent** | Agent | The coding agent that runs a thread: Claude Code, Codex, Cursor (`agents` table, a harness). It does the coding work; a bot never does. Every dispatch names its Agent (none named: `agentRequired`), and a thread keeps that one Agent for life: retries and continuations never switch to another ([2026-11-17-1800](decisions/2026-11-17-1800-one-agent-per-thread.md)). Each Agent has its own 优先使用的模型 list; the other Agent's list is never a fallback. Shown by its own brand mark wherever a thread or run has an icon (R-78). Never called harness or 执行器 in the UI (R-43). |
| **Agent Profile** | Agent 配置 | A reusable logical coding role owned by a person in a workspace: responsibilities, capabilities, Agent/model policy, effort, private instructions and controlled Skills. Several Profiles may use the same physical Agent/model. Managed in Settings › Agent 配置 (Agent group, [2026-11-26-0100](decisions/2026-11-26-0100-settings-structure-from-benchmark.md)); frozen into each selected run. Has its own mark (a glyph and colour), the main mark of its Agent stretches (R-78). It never becomes a Bot or a left-column row. [Spec](factory-agent-profiles.md). |
| **Library** | 资料库 | A bot's files, listed in its 「Bot 资料」 sheet; the person can delete their own (R-51). Files are added with the composer's 「+」. |
| **Browser** | 浏览器 | The person's own local browser, one for the whole app, opened from the globe in the top bar (R-57). |
| **Computer** | 电脑 | A bot's cloud computer: its own desktop (X display) on its owner's bot machine, which is one per person per workspace (`cloud_machines` keyed by `workspaceId`, `ownerId`; `bot_desktops` keyed by `botId`). Used by that bot only; a thread that needs a desktop gets its own machine ([0251](decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md)). Shown in the right column's 电脑 tab (R-50). Never called 浏览器. |
| **Bot machine** | Bot 机器 | The E2B sandbox that hosts one person's bot desktops in a workspace. One per person per workspace, not one per bot. |
| **Thread machine** | thread 机器 | The E2B sandbox one cloud thread runs on, from the verified official-derived template. Separate from the bot machine. |
| **Workspace policy** | 工作区策略 | Target contract (Capy parity): the only authorization surface — MCP servers (allow / read-only / disabled), devices (allow), computer use (allow / deny). Never per Bot. Current builds still carry per-Bot rows until the workspace rule lands. |

## Words to avoid

- Use **Bot list** for the Bot navigation. The 线程 directory lists threads, Bot chats and group chats, so its English name stays **Conversations**.
- Use **Thread / 线程 / `thread`** for what a person opens, names and replies to, **Run / 运行 / `run`** for one execution, and **Task / 任务** for the linked work item.
- 对话 anywhere in the Chinese UI (Alex, 2026-11-15): a thread, a Bot chat, the directory and its create actions are all 线程; a group chat named as one is 群聊; only 对话框 (a dialog box) keeps the characters. `pnpm i18n:check` fails on any other 对话.
- For a thread: 会话, 执行线程, 运行链 in Chinese; "Conversation", "session" or "run chain" in English UI; `conversation` or `session` in code. Code keeps `conversation` for the `conversations` table family (`conversations`, `conversation_members`, `conversation_messages`, `conversation_reads`, `conversation_links`, `telegram_conversations`) and the code about it. `session` stays for sign-in sessions and the harness's own `agent_runs.sessionId`. 会话 stays only for a sign-in session.
- A Chinese word for Artifact. Keep **Artifact**.
- "浏览器" for a bot's cloud computer, or "电脑" for the local browser.
- "Agent" when you mean the thing on the left. Say **bot**. **Agent** is the
  right-side worker that runs threads (`agents` table, Claude Code, Codex).
- "harness" or 「执行器」 in the UI for that worker. Say **Agent** (R-43).
- 「E2B」 as the cloud machine's name. It is **Mikka Cloud** in both languages,
  never translated; E2B names only the provider and its API key.
  Code identifiers may keep `harness`.
- 「Bot 的线程」, 「所属 Bot」, "bot's threads", "a bot's thread" or "the thread
  belongs to a bot". A bot only dispatches threads; an Agent runs them. Say
  「<Bot> 派出的线程」 / 「<Bot> 派出」, "threads a bot dispatched".
- 项目 for a task's environment or a run's repositories: say **环境**. 收件箱 for
  the notification list: say **通知**. 新建群聊 as an entry: a group chat is a
  thread with members, made with 「添加成员」.
- 「Mikka Cloud」 for the hosted model, or 「Mikka 默认」 for the cloud machine.
  Mikka 默认 is a model, Mikka Cloud is a machine ([orchestration](orchestration.md) § 1).

## Domain terms: tenancy and ownership

Who owns what, in the format of the domain-modeling skill's glossary
(`mattpocock_skills` `GLOSSARY-FORMAT.md`). Each term names the aggregate it
belongs to (DDD: the consistency boundary that owns it). Where a line below
and the Workspaces table above differ about 密钥与环境, the line below follows
[2026-11-02-0231](decisions/2026-11-02-0231-workspace-is-the-tenant.md), which
records the workspace tenancy rules. Bounded contexts, aggregates and the code that
stores them: [information-architecture.md](information-architecture.md) § 1.

### People and tenants

**Account (账号)**:
The person. Not a tenant: what is bound to the person follows them into every
workspace they belong to.
_Owner_: itself (Account aggregate).
_Avoid_: 账户 for the whole level (账户 is one settings page), user, profile.

**Workspace (工作区)**:
The tenant. Every bot, chat, task, thread, secret, credit and invoice belongs
to exactly one workspace, and nothing crosses between workspaces.
_Owner_: its owner account; administered by its admins (Workspace aggregate).
_Avoid_: 工作空间, organization, space, team (for the workspace itself).

**Personal workspace (个人工作区)**:
A workspace with exactly one member, created with the account and kept as long
as the account exists. It has everything a workspace has except what is
between people.
_Owner_: the account (Workspace aggregate).
_Avoid_: 个人空间, "my account", the personal level.

**Shared workspace (共享工作区)**:
A workspace with more than one possible member. Only it has what is between
people: members, teams, roles and team permissions, member audit, shared
credits and seats, transfer.
_Owner_: its owner account; administered by its admins (Workspace aggregate).
_Avoid_: 团队工作区 and 团队 on its own (a 团队 is only a group inside a workspace), organization.
_Note_: target term (decision D11 of the coordinating session, 2026-11-02). The UI
now says 共享工作区 / shared workspace (2026-11-08); code still says `team` for it until the rename in Known naming debt.

**Team (团队)**:
A named group of members inside a shared workspace, with its own task prefix
and tasks (as a Linear team). Teams are managed on one 团队 settings page; the
settings sidebar does not list teams one by one ([2026-11-26-0100](decisions/2026-11-26-0100-settings-structure-from-benchmark.md) rule 25).
_Owner_: the shared workspace (Team aggregate).
_Avoid_: 团队 for the workspace, group, squad.

**Member (成员)**:
An account's place in one workspace, with a role (管理员 or 成员) and a state
(active or suspended).
_Owner_: the workspace (inside the Workspace aggregate).
_Avoid_: user, seat (a seat is a billing count), collaborator.

### Work

**Bot**:
As defined above. It lives in one workspace and has one owner account; a
person's Coordinator is their bot in that workspace.
_Owner_: the workspace, held by the owner account (Bot aggregate).
_Avoid_: Agent, assistant, 机器人.

**Agent**:
As defined above: the coding worker (Claude Code, Codex) that runs a thread.
Which Agent a person's bots use is the person's choice per workspace
(模型与订阅).
_Owner_: the account (Agent aggregate).
_Avoid_: harness, 执行器, bot.

**Thread (线程)**:
As defined above: one piece of work a bot dispatched, run by an Agent. The
bot only dispatches it; it does not own or run it.
_Owner_: the workspace where it was dispatched (Thread aggregate).
_Avoid_: 对话, 会话, 执行线程, 运行链, conversation, session, 任务, run (a run is one turn of a thread).

**Task (任务)**:
A unit of work with an immutable UUID and issued Mikka identifier, a status,
and an optional human assignee who is an active member of its Workspace.
A thread works on it; it is not a thread. Its **环境** property names the
environment its runs use (default: the assigned Bot's environment); it replaced
the former 项目 property, and lists group 按环境. The repository and branch a
run checks out stay run state. A Team is an optional group inside that
Workspace and does not own the task or change its issued identifier ([2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rules 4–5).
_Owner_: the workspace (Task aggregate).
_Avoid_: issue in the UI, ticket, 工单, thread.
_Note_: 受阻 (Blocked) is a board column a task falls into while its newest
thread, a task it is blocked by or the person's flag stops it; it is not one of
the task's statuses ([2026-11-06-1600](decisions/2026-11-06-1600-blocked-board-column.md)).

**Task identifier (任务编号)**:
The immutable human reference issued to a Task. Historical Team, personal and
Linear spellings are scoped aliases, not access grants. New shared tasks use a
Workspace prefix/counter; existing publication identifiers and branches stay
frozen. See [stable identity](decisions/2026-11-07-2301-stable-task-identity.md).
_Owner_: the Task; the issuing counter belongs to its Workspace.
_Avoid_: deriving identity from the current Team, owner prefix or a Run number.

**Human assignee (人类负责人)** and **Agent Delegate**:
The assignee is the active person responsible for the work, or nobody. Delegate
is an independent Bot, Agent or Agent Profile reference for execution. Neither
is the reviewer/approver, and changing either does not rewrite an existing Run.
“Assigned to me” uses the human relation; following is explicit subscription.
See [compatibility contract](task-responsibility-contract.md).
_Owner_: the Task, within its Workspace.
_Avoid_: treating the owner of the executing Bot/Agent as the human assignee.

### Resources

**Environment (环境)**:
The workspace-level container a run starts from: 1..n repositories (cloned at
boot, or on demand) with their base branch, setup and start scripts, variables,
secrets, network access, machine size, instructions and MCP. It is the only
container: there is no board Project → repository → environment layer, and no
projects page (Capy's "project" is Mikka's 环境). The default environment needs
no repository. A repository outside the environment is admitted by workspace
policy and cloned on demand for that run. A member can keep an environment 「仅我」
or share it with the workspace; personal variables override shared ones of the
same name ([2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md) rules 1–5a;
[2026-11-19-2100](decisions/2026-11-19-2100-environment-not-project.md)).
_Owner_: the workspace (Environment aggregate).
_Avoid_: 项目 / Project for it.

**Device (设备)**:
A computer or server of the person's that runs their Agents through the
desktop app or the daemon. Not a bot's cloud computer (电脑).
_Owner_: the account (Device aggregate).
_Avoid_: 电脑 (a bot's cloud computer), machine in the UI, runner.

**Daemon (daemon)**:
The background service on a device that connects it to Mikka and runs its
Agents. The UI calls it daemon in both languages, with no 「Mikka」 in front:
「重启 daemon」, "Update daemon". Not the Mikka desktop app.
_Avoid_: Mikka 客户端, Mikka client, 客户端 (reads as the desktop app).

**Connection (连接)**:
An authorized link to an outside provider. Personal app connections (Gmail,
GitHub, Linear, Telegram…) and Claude Code/Codex subscriptions belong to the
account. Organization model connections are API keys, gateways or custom
endpoints owned by the organization. Sharing content never shares a connection.
_Owner_: the account or organization (Connection aggregate); a Subscription
connection is always account-owned and never a public member resource pool.
_Avoid_: integration, plugin (a 插件 is the store item, the connection is
what linking it creates), binding.

**Secret (密钥)**:
A named value authorized for work in one workspace, or one repository in it.
Sensitive third-party API values follow the scoped capability boundary in
[decision 2026-11-08-0240](decisions/2026-11-08-0240-credential-exposure-boundary.md).
`lib/secrets/runtime.ts` separates ordinary env and explicit direct delivery
from protected HTTP capabilities, which the claim route seals for the run.
Deployed protection requires the decision's runtime canaries and evidence.
_Owner_: the account for Personal secrets, or the Workspace/Project for Shared
secrets. Thread scope narrows delivery to authorized work; it does not change
ownership or authorize delivery of someone else's Personal secret.
_Avoid_: credential (a model credential is the account's), token, 环境变量 as
a separate thing (an environment variable is a kind of secret).

**Credits (点数) and free allowance (免费额度)**:
Credits are what a workspace spends on Mikka 默认 and pays for; the free
allowance is the credits a new workspace starts with once its owner is
verified. A model subscription's quota (订阅额度) is the subscription owner's,
never the workspace's.
_Owner_: the workspace (Billing aggregate); 订阅额度 belongs to the account.
An Organization can explicitly designate an attached Workspace's existing
billing account for its platform resources. Existing balances keep their
owner and ledger history. External API keys, subscriptions and E2B bills remain
external; an unavailable provider amount is **Unknown**, never zero.
_Avoid_: bare 额度 (say 免费额度 or 订阅额度), balance, quota for credits.
## Known naming debt

Code names that disagree with this file. They stay for now (no large rename,
2026-11-02). Whoever next changes the related code renames it in that PR,
with a migration for database names, and deletes the row here. Until then
read the code name in the sense given below.

| Term in code | Current meaning(s) (where) | Target | Note |
| --- | --- | --- | --- |
| `coordinator` (tables, `lib/coordinator/*`, `CoordinatorChat`) | Any bot's chat, not only the Coordinator bot: `coordinator_sessions`, `coordinator_messages`, `coordinator_events` (`lib/db/schema.ts`), `lib/coordinator/*`, `components/coordinator/coordinator-chat.tsx`. | **Bot chat**: `bot_chat_*` tables, `lib/bot-chat/*`. | Tables need a migration. Keep `coordinator` only for the Coordinator bot itself. |
| `agent` | Three things: an `agents` row is a harness configuration and subscription-consumer identity registered against a device (`lib/db/schema.ts`, `lib/device-agents.ts`); the Agent brand (Claude Code, Codex), stored as `harness`; and a group-chat member/author type `'agent'` plus `conversations.leadAgentId` (`lib/db/schema.ts`, `lib/group-conversations-store.ts`). A cloud task's actual execution device is `agent_runs.deviceId`, proved by that run's owner-bound `computer_run_bindings` and `thread_machines`; host placement can differ from the configuration's registered device. | Agent configuration identity for the row; the run and its machine binding for execution placement; `harness` for the brand; **bot** for the group-chat member, author and lead. | Local execution retains the registered-device check. Cloud placement retains the exact owner, workspace, bot, issue, device and repository checks. The UI word **Agent** above is unchanged: the coding Agent runs on the thread machine, and the bot only dispatches. |
| 团队 / `teams` | Both a team workspace (`workspaces.kind = 'team'`, `lib/db/workspace-schema.ts`) and a sub-team inside a workspace (`mikka_teams`, `lib/db/team-schema.ts`). | **Team** (团队, `mikka_teams`) is only the sub-team inside a workspace, matching Linear's Team, since tasks sync to Linear. The team workspace becomes **shared workspace** (共享工作区) in code and copy, opposite **personal workspace**. | Copy renamed 2026-11-08 (UI audit gap-12); code names (`workspaces.kind = 'team'`) still to rename. |
| `issues.scope` `'personal'` / `'workspace'` | Linear-sync visibility of an issue (`lib/db/schema.ts`), not the personal workspace. | `'unsynced'` (not synced to Linear) for `'personal'`. | Collides with **Personal workspace**. Renaming needs a migration. |
| `factory_tasks` | A factory job, not a task (`lib/db/schema.ts`). | `factory_jobs`. | "Task" means only an issue (`MIK-xx`); `TaskDetail` (`components/workspace/task-detail.tsx`) loads a task and keeps its name. |
| Chat key | One chat, three encodings: `conversation_reads` id `'coordinator'` or `'bot:<uuid>'` (`lib/conversation-reads-store.ts`); `chat_preferences.chatKey` = raw bot id; `bot_model_choices.botKey` = bot id or `'coordinator'` (`lib/model-api-keys.ts`). | One `chatKey(botId)` format. | Remove the `'coordinator'` sentinel with a migration. |
| `agentName` on a run | The name of the bot that dispatched the run, not an Agent's (`lib/agent-runs.ts:59`, from `runBotName` in `lib/run-bot-name.ts`). | `botName`. | Code unchanged for now (2026-11-02). Read it as the dispatching bot. |
| `conversation` for the 线程 directory | The directory and its per-person state cover threads as well as Bot and group chats: `lib/conversation-directory.ts`, `lib/conversation-organization.ts`, `lib/conversation-workspace.ts` (`withConversationWorkspace`), the mobile `apps/mobile/lib/conversation-journal.ts` and `conversation-submission.ts` (one outbox for chats and threads), the `task-runs` actions `listConversations`, `listConversationSidebar`, `readConversationOrganization`, `setConversationOrganization`, the inbox entry type `'conversation'`, the `agent_runs` columns `conversationPinnedAt`, `conversationArchivedAt` and `conversationRestoredAt`, and the `task-conversation` slot (a task's threads). | `thread` where only threads are meant; `conversation` where the `conversations` table family is. | Left on the thread rename (2026-11-15) because each mixes threads and chats or is a slot contract; split when that code next changes. |
| `session` | Six things: `coordinator_sessions` (bot chat state); `agent_sessions` (old chat archive); `agent_runs.sessionId` and `factory_attempts.sessionId` (the harness CLI session); `session_mailboxes` (`lib/session-mailbox.ts`); `browser_sessions` (`lib/credentials/store.ts`); and sign-in in `lib/session.ts`. | `harnessSessionId` for the CLI session field; bot chat for `coordinator_sessions` (row 1). Others keep their names. | UI never says 会话 for any of them (see above). |
