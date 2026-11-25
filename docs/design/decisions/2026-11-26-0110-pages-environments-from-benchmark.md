# Environments, navigation, the right column and mobile follow the benchmark of top agent products

- Date: 2026-11-26 01:10 UTC
- **Status:** Accepted
- Source: Alex, 2026-11-25: 「找得到的为什么要交给我」 — questions that top products already answer are decided from
  that evidence, not handed to Alex ([2026-11-25-2330](2026-11-25-2330-owner-decisions-chat-memory-views-projects.md)
  rule 9). The workspace-page, chat/desktop and mobile benchmarks were checked against Capy, ChatGPT/Codex, Claude (with
  Claude Code), Cursor, Devin and Perplexity, plus GitHub Copilot coding agent and Google Jules for the environment
  model, and GitHub / Linear only where no agent product has the surface. Only the rows the evidence settles are
  recorded here.
- Rule: [2026-11-25-1630](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md) 「benchmark first, not precedent」.
- Count: 「n/m」 is n of the m products that have the surface. Research IDs (E…, W…, C…, M…) refer to the resolved-pages
  benchmark table.

## Decision

### Environments and repositories

1. **An environment is workspace-level and holds 1..n repositories (E1)** (the existing `repositoryKeys[]`). Evidence
   4/7 multi-repository (Capy, Codex, Cursor, Devin); 2/7 one per repository (Copilot, Jules); Claude keeps repositories
   on the session but its Project is still 「repositories + one environment」.
2. **What an environment holds (E2):** repositories first (cloned at boot, plus on-demand repositories) with their base
   branch, then setup script, start script, variables, secrets, network access, machine size, instructions and MCP.
   Evidence: Capy's project page order (Repositories → Setup & snapshot → Machine → Variables → MCP → Skills and
   instructions); Codex and Cursor list the same contents.
3. **One picker bar where work starts: 「环境 · 仓库/分支 · 运行位置」 (E3).** It is the same on new thread, task, Bot and
   automation. Choosing an environment lists only its repositories (plus 「其他仓库…」); choosing a repository first
   brings in an environment that contains it (mine before the workspace's). The default environment needs no
   repository. A repository outside the environment is no longer refused: it is admitted by the workspace repository
   policy, cloned on demand and recorded on that run. An environment that is not ready says so in place (「让 Agent 配置 /
   构建快照」). Evidence: explicit choice 3/7 (Capy ProjectSelect + RepoBranchSelect, Codex 「Cloud · 环境」, Claude's
   environment picker); auto-match by repository 3/7 (Cursor, Copilot, Jules); on-demand repositories 4/7 (Capy lazy
   repositories, Claude, Cursor `repositoryDependencies`, Devin).
4. **A task's 「项目」 property becomes 「环境」 (E4),** defaulting to the assigned Bot's environment. The checked-out
   repository and branch stay run state. Lists and the sidebar group 「按环境」 instead of 「按项目」. Evidence: Capy's New
   issue picks a project (= Mikka's environment); Claude Project threads use the project's environment; Cursor and Codex
   group by project.
5. **No board-Project → repository → environment layer (E5).** The environment is the only container; a repository's
   base branch and 「主仓库」 mark move onto the environment's repository row. Evidence: Capy has one container; Claude's
   Project is repositories + one environment; Alex removed the projects page on 2026-11-25.

### Navigation

6. **Group chats merge into threads (W1).** A group chat is a thread people were added to: the thread row shows a
   multi-person mark, the thread header has 「成员」 (list, add, invite link, transfer ownership), new thread can 「邀请成员」,
   and the separate 群聊 sidebar section and 「新建群聊」 row go (on phones too: 新建线程 → 添加成员). Evidence 5/6 have no
   separate group-chat object (Capy, Codex, Claude, Devin, Cursor); only ChatGPT has a Group chats section.
7. **No 收件箱 page; a notification bell instead (W2).** 「需要你」 lives on the Bot overview, at the top of the task list's
   「与我相关」 and as unread dots on thread rows; a bell beside the avatar opens one list (`…` for filter / show read / mark
   all read); phones use the same bell. Evidence 6/6 agent products have no inbox page (Capy, Codex, ChatGPT, Claude,
   Devin, Cursor; Perplexity's 「Inbox」 is history plus a bell).
8. **Artifacts stay visible in the sidebar (W6),** and the sidebar becomes customisable (hide / pin any page); the
   Artifacts list is a flat thumbnail grid with 全部 / 我创建的 / 与我共享. Evidence: top-level 3/5 (Claude, Perplexity,
   ChatGPT Library) vs under More 2/5 (Capy, Codex); customisable sidebar in Capy and Codex.
9. **Plugins is browse + detail, not a management page (W7).** The detail page shows description, permissions, who
   signed in, where it runs, try it in a thread, connect; each plugin appears once. Connected and custom MCP management
   lives in settings (see [2026-11-26-0100](2026-11-26-0100-settings-structure-from-benchmark.md) rule 17). Not in the
   main navigation by default, pinnable. Evidence 4/5 do not make it a top-level page (Capy, Codex, Claude, Perplexity;
   ChatGPT Apps is the exception).

### The thread's right column and chat

10. **The right column opens on an 「概览」 tab (W3).** Sections: 待办, 子 Agent, 分支与 PR, 产出, 自动化, 端口; a Bot thread's
    overview shows 需要你 / 进行中 / 线程 / 子 Agent / PR. The flat strip of kind tabs, ＋ picker and launcher stay. Evidence
    3/4 (Capy `pane/overview`, Codex summary panel, Claude's changes panel / Project overview; Devin has tabs only).
11. **Subagents open in the right column (C3)** as a read-only `thread:` tab that reuses the SubagentView header and
    status bar; the transcript keeps its event rows; with several running, the turn ends with one line 「3 个子 Agent
    工作中 · 1 个在等你」. The main conversation is never replaced. Evidence 3/3 (Codex subagents panel, Capy right-column
    Subagents, Devin separate sessions).
12. **Branch and PR on desktop live in 概览 and the composer's status row, not in a bar above the composer (C2).** The
    status row carries 「分支 ▾」 and a turn that changed files ends with 「N 个文件改动 +a −b」. On phones a thread with a PR
    shows a PR chip above the composer (「查看 PR #318 +a −b」, 「合并」 when mergeable); it belongs to the composer and is not
    a second bottom slot. Evidence desktop 2/3 side panel (Codex, Capy) vs 1/3 above the composer (Claude Code web);
    phones 2/3 above the composer (Cursor, Claude) vs 1/3 in the transcript (Codex).
13. **`@` results are grouped (C4)** (文件 / 文件夹 / 线程 / 任务 / PR / 成员 / 插件); **no keyboard-hint footer** in the `/`
    and `@` menus (PopMenu's look is unchanged). Evidence: grouping 2/2 (Codex, Capy); hint footer 1/2 (Capy only).
14. **The plan is a 「第 2 / 3 步」 chip, not a bar over the composer (C5);** the full list is 概览's 待办 section. Evidence 2/2
    (Codex `todoPlan.pillProgress` and summary Progress, Capy Overview Todos).
15. **Tool rows speak Chinese (C1)** — already decided by Alex in
    [2026-11-25-2330](2026-11-25-2330-owner-decisions-chat-memory-views-projects.md) rule 1; listed so the set is complete.

### Desktop

16. **A tray / menu-bar icon (C6):** recent threads, new thread, waiting count, open the main window. Evidence 2/2 by
    source (Capy, Codex).
17. **No cold-start update gate on desktop (C7):** download in the background and offer 「重启以更新」; block only when the
    server declares a minimum version (UpdateRequired names 「当前 vX，需要 vY」); failures name their cause. Evidence 2/2
    (Capy, Codex; Codex forces only under a managed relaunch policy). The web counterpart is in
    [2026-11-26-0120](2026-11-26-0120-auth-and-overlays-from-benchmark.md) rule 18.
18. **This computer asks once before running dispatched threads (C8):** 「允许在这台电脑上运行线程？」 before the first run,
    revocable under 设置 › 设备. Evidence 3/3 (Capy 「Allow Captain」, Claude 「Allow once」, Codex approval of the attachment).

### Mobile

19. **The left drawer is the only global navigation (M1).** It mirrors the desktop sidebar; 任务 and 产出 are global pages
    in the drawer (with a Bot filter chip); 电脑 moves to the thread header's subtitle / `…`. Mobile 2.0's per-Bot bottom
    tabs (聊天 · 任务 · 产出 + 电脑 button) and the drawer's bottom icon strip are removed. Evidence 5/5 agent apps use no
    bottom tabs (ChatGPT, Claude, Perplexity drawers; Cursor drill-down; Capy's sidebar overlay); bottom tabs appear only
    in GitHub and Linear and are global.
20. **No right-column tab strip below 768px or on touch (M2).** The thread `…` menu lists 变更 / PR / 任务 / 文件 / 电脑 / 浏览器 /
    分享, each opening a pushed page or two-detent sheet (「‹ 返回线程 · 名称」); change cards and the PR chip in the
    transcript are the main entry. Evidence 3/3 (Codex, Cursor, Capy's strip is desktop-only).
21. **Phone settings (M3):** keyboard shortcuts hidden on touch; 审计日志, API, 任务状态与标签 and organization pages are not
    listed on the phone settings home and deep links show a read-only summary with 「在电脑上编辑」; the home is a grouped
    list with push navigation. Evidence 3/3 phone settings have no workspace admin pages (ChatGPT, Claude, Perplexity);
    Capy hides key hints on coarse pointers.

## Not decided here (still with Alex)

- E6 personal environments (「仅我 / 工作区」) — a feature to build; 4/4 have it.
- E7 environment snapshots (prebuilds) — infrastructure cost; 5/7 have it.
- W4 the task's 「验收」 section — no comparable product; independent checks depend on it.

## Supersedes

- [2026-11-23-2200](2026-11-23-2200-right-column-as-tembo.md) in part: rule 2 「No Overview」 and rule 6's first-open order
  (rule 10), and the strip on phones (rule 20). The flat kind tabs, ＋ popover, launcher and menus stay.
- [2026-11-19-2100](2026-11-19-2100-environment-not-project.md) in part: 「任务看板的 Project（任务归属）不改名、不改语义」
  (rules 4–5).
- [2026-11-07-2300](2026-11-07-2300-work-domain-model.md) in part: Projects as task containers with their own repository
  and environment bindings (rules 4–5).
- [2026-11-22-1510](2026-11-22-1510-group-chat-as-bot-chat.md) in part: the group chat as its own object, list and
  sidebar section (rule 6); one shared chat surface and group author headers stay.
- [2026-11-10-1317](2026-11-10-1317-capy-sidebar-and-task-layout.md) in part: group-chat rows and the new-group route in
  the sidebar (rule 6).
- [2026-11-13-1405](2026-11-13-1405-one-task-status.md) in part: 「What needs the person stays in 收件箱」 (rule 7).
- [2026-11-22-1400](2026-11-22-1400-subagent-cards.md) in part: how a subagent opens (rule 11).
- [2026-11-02-1723](2026-11-02-1723-desktop-adds-this-computer.md) in part: 「shows no dialog」 — the first dispatched run now
  asks once (rule 18).
