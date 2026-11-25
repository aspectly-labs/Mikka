# Chat follows Codex; memory deferred; views, the old task frame and the projects page removed

- Date: 2026-11-25 23:30 UTC
- **Status:** Accepted
- Source: Alex, 2026-11-25, answering the open questions from the full UI benchmark (chat rebuilt from the Codex desktop
  source; dead sections found by the screenshot sweep).
- Rule: `AGENTS.md` (mikka-hosted-ui) Thread/Chat exceptions; [2026-11-25-1630](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md)
  「benchmark first, not precedent」.

## Decision

1. **Tool rows speak Chinese, as Codex does.** A tool row reads as a verb and its target in the user's language
   (「已编辑 styles.ts」「正在运行 …」), one row style for summaries and single steps. This replaces the English tool names
   approved on 2026-11-22.
2. **Feedback as Codex asks for it.** No feedback card in the transcript; thumbs up/down sit in the reply's action row and
   a comment box appears only after a click.
3. **Cost is not shown in the thread header.** A run's cost is shown under Settings › 用量 only.
4. **Memory is deferred.** The memory feature is not being developed for now. Its sidebar entry stays behind the `memory`
   feature flag, which is off by default; do not turn the flag on or treat the hidden page as a bug. The memory settings
   section and page code stay in place until the feature is picked up again.
5. **Task views are removed.** The `views` section had no entry and could not be opened (`TaskViews`,
   `countWorkspaceTaskViews`); its code is deleted.
6. **The old task frame is removed.** The task page (Capy layout) is the only task view; `_LegacyKanbanTaskFrame` and
   anything reachable only from it are deleted. What the task page needs is decided against top products, not by what the
   old frame had.
7. **No projects page.** Capy's "project" is a repository plus its environment, which Mikka calls 环境; Mikka has no
   separate projects page or projects navigation entry. How repositories relate to environments is settled by the
   benchmark of top products' environment models.
8. **Automations list as top products build it.** The list is built from Mikka's own components to match the benchmark
   (full-width list page, the shared list header); the paid Agent Schedules block is used only where it fits that layout.
9. **Open questions are answered from evidence.** Questions that top products' documentation, apps or source already
   answer are decided that way; only those with no such evidence go to Alex.
