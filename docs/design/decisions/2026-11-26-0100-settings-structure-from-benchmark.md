# Settings structure follows the benchmark of top agent products

- Date: 2026-11-26 01:00 UTC
- **Status:** Accepted
- Source: Alex, 2026-11-25: 「找得到的为什么要交给我」 — questions that top products already answer are decided from
  that evidence, not handed to Alex ([2026-11-25-2330](2026-11-25-2330-owner-decisions-chat-memory-views-projects.md)
  rule 9). Every open settings question from the page-by-page benchmark was checked against Capy, ChatGPT/Codex (one
  product), Claude (with Claude Code), Cursor, Devin and Perplexity; Linear, GitHub or Vercel were consulted only where
  none of the six has the surface. Rows the evidence settles are recorded here; Alex then answered the three it left
  open (R-S03, R-S10, R-S24; relayed by the coordinator), recorded as rules 25–27.
- Rule: [2026-11-25-1630](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md) 「benchmark first, not precedent」.
- Count: 「n/m」 is n of the m products that have the surface. Research IDs (R-S…) refer to the resolved-settings
  benchmark table.

## Decision

### Navigation and grouping

1. **One workspace 「常规」; 「组织」 leaves the everyday sidebar (R-S01).** The workspace group has one 常规 page.
   Organization settings appear only for a bound organization or an enterprise plan, entered from the workspace switcher
   or the enterprise console. The organization backend ([2026-11-20-1900](2026-11-20-1900-settings-organization-security.md))
   is unchanged; only navigation moves. Evidence 6/6 keep one organization/team level in everyday settings (Capy,
   Devin, Cursor; Claude, ChatGPT and Cursor add a parent level only for SSO / enterprise).
2. **No 「团队权限」 page; each policy lives on the page of the object it governs (R-S02).** Bot computer use → 设备;
   members sharing API keys → 模型 「成员」 section; allowed apps → 连接器与 MCP admin column; approval templates → Agent
   权限 (rule 25). Evidence 3 place policies in situ (Capy, Claude, Devin) vs 2 on one page (Cursor, ChatGPT Business);
   none calls it team permissions or hangs workspace policy on a team.
3. **Members and teams are two sidebar entries, not two tabs of one page (R-S04).** Keep the sidebar 「团队」 entry and
   remove the 「成员 | 团队」 tabs on the members page (the team layer stays, rule 25).
   Evidence 2/2 products with a teams surface (Linear Administration › Members / Teams; GitHub People / Teams).
4. **Two groups: 「Agent」 and an unnamed connections-and-compute group (R-S06).** Agent = 指令 · 技能 · 线程 · Git 与拉取请求
   · Agent 配置 · Agent 权限. The unnamed group (模型 · 云端环境 · 设备 · 密钥与凭证 · 集成 · 连接器与 MCP · API) is separated by
   a divider only; 「Agent 与计算」 is retired. Evidence: Capy names the group 「Agent」; 3/4 leave the connections group
   unnamed (Capy, Cursor, Devin; only Codex names it).
5. **New personal page 「数据与隐私」 (R-S05).** Order: 导出我的数据 · 共享链接 (manage / revoke) · 已归档线程 · 删除全部线程
   (destructive, confirmed). Export and share links move here from 个人资料; the page carries no data-use switch
   (rule 27). Evidence 5/6 (ChatGPT Data controls, Codex
   Data & Privacy, Claude Privacy, Cursor Privacy, Perplexity data retention; not Capy).

### 常规, 外观, 个人资料, 安全, 通知

6. **「重新播放引导」 leaves settings (R-S07)** for the help (?) menu and the command menu. Evidence 0/6 make it a
   setting (Codex's Replay is on the welcome page; Cursor uses the command palette).
7. **「桌面应用」 section in 常规, desktop only (R-S08):** link-open target · start at login · show in menu bar · prevent
   sleep while a task runs. Hidden on the web. Evidence 3/3 agent products with a desktop app (Capy, Codex, Claude
   Desktop).
8. **Switching to an already-open thread tab is default behaviour, not a setting (R-S09).** Evidence 1/6 (Capy only)
   has a toggle.
9. **Email is not changeable in settings (R-S11).** Show it as plain text with 「如需更换请联系支持」, not a disabled input.
   Evidence 4/6 do not allow a change (Claude, Cursor, Perplexity, Devin); 2/6 do (Capy, ChatGPT).
10. **No 「要求通行密钥登录」 or 「不是我」 lock-out mail for now (R-S12);** they go on the later security-hardening list and
    安全 keeps its four sections. Evidence 2/6 (Capy, ChatGPT).
11. **Notifications drop 「定时免打扰」 and 「推送时机」 (R-S13);** the OS focus mode covers quiet hours and each device's
    notifications are a per-device switch under 设备 (as Capy). Evidence 0/6 have either.
12. **No auto-subscribe to threads I wrote in (R-S14).** Evidence 1/6 (Capy).

### Models, devices, credentials, connections

13. **No separate 「默认 Harness」 row (R-S15).** The default-model picker groups models by Agent (Claude Code → Claude
    models, Codex → GPT models); picking a model picks the engine. The word 「Harness」 leaves the UI. Evidence 6/6 let the
    person choose only a model (Capy, Cursor, Codex, Claude, Devin, Perplexity).
14. **No global 「运行位置（云端/本地）」 preference on 设备 (R-S16).** The composer's machine picker chooses per thread and
    remembers the last choice. Evidence 4/4 products with local and cloud runs choose per thread (Codex, Capy, Cursor,
    Claude Code).
15. **E2B key and 「Mikka Cloud Worker」 leave 设备 (R-S17)** for the 「算力」 section of 云端环境: 「Mikka Cloud / 你的 E2B 账号」,
    the provider named only in the option. The key stays the person's and is not shared with the team. Evidence 0/6
    put a compute provider's key in the device list; Cursor keeps self-hosted workers beside environments.
16. **No 「云凭证」 (OIDC / workload identity) section for now (R-S18).** Evidence 1/6 (Capy).
17. **「插件」 splits into 「集成」 (GitHub, Linear, Slack, Telegram) and 「连接器与 MCP」 (R-S19),** sharing one catalogue
    dialog in which each app appears once. Evidence 3/6 split (Capy, Codex, Cursor) plus Devin's two sections on one
    page; Claude and Perplexity do not.

### Agent group

18. **「Agent 配置」 is its own entry in the Agent group (R-S20),** moved out of 指令 and not into Bot details, because tasks
    pick a profile too. Evidence 0/6 keep reusable profiles in one Bot's details (Capy Instructions, Devin Playbooks,
    Cursor modes, Codex Agent defaults).
19. **Skills have no default approval flow (R-S21).** Personal skills need no review. An admin policy 「发布到工作区的技能：开放 /
    需管理员审核 / 关闭」 (team default 开放) and per-skill disable remain. Evidence 6/6 no default review; 2/6 admin policy
    (Claude, Codex).
20. **Git 与拉取请求 gains (R-S22):** Git — branch prefix · commit attribution (with Mikka co-author) · commit email · commit
    message instructions; Pull requests — open as draft by default · merge method · wake on review comments · wake on CI
    failure · review-bot list. Signed commits wait (1/6). Evidence 4/6 have a Git/PR settings page (Codex, Capy, Cursor,
    Devin).
21. **「Agent 权限」 keeps approval templates (R-S25):** default approval policy, network access, preset templates (applying
    one confirms and states its effect). It replaces the removed 团队权限 page (rule 2). Evidence 4/6 have Agent
    permission / approval settings (Codex, Claude Code, Cursor, Capy).

### Workspace

22. **Workspace sharing is two rows (R-S23):** default visibility of new work and 「允许私有工作」. The personal default moves
    to personal settings; thread and artifact share scope is set in each object's share dialog. Evidence 0/6 set
    per-object-type default sharing in workspace settings (Capy has one Sharing row; ChatGPT and Claude scope sharing in
    the share dialog).
23. **「活动」 shows outcomes, not operations (R-S26):** contribution share, merged PRs, feedback loops and Agent hours with
    period-over-period change. Queues, storage and channel bindings move to the self-hosted 服务器 / 诊断 page. Evidence
    0/6 put an operations panel on activity (Capy, Cursor, Codex, Devin show outcomes).
24. **New admin-only 「身份与访问」 page (R-S27):** domain verification, SSO and required two-step verification, on the
    existing backend ([2026-11-20-1900](2026-11-20-1900-settings-organization-security.md)). Evidence 6/6 business plans
    have SSO and domain verification.

### Alex's answers to the open rows

25. **Teams: one 「团队」 page, no per-team list in the settings sidebar (R-S03, option B, as GitHub).** The sidebar's
    dynamic 「你的团队」 group and its 「创建团队」 row go; a team's settings open from the 团队 list. Navigation no longer
    grows with the number of teams.
26. **外观 gains a chat-font row, Alex's 「对话字体」 (R-S10):** 默认 / 无衬线 / 系统 / 易读字体. Its Chinese label follows C-09
    and never says 对话 (`pnpm i18n:check` rejects 「对话字体」); name it for threads, e.g. 「线程字体」. Evidence 3/6 (Codex,
    Claude, Perplexity).
27. **No data-use switch (R-S24, option A).** Mikka does not use user content for training. Neither 数据与隐私 nor workspace
    常规 has a 「帮助改进 Mikka」 / 数据使用 switch; 数据与隐私 carries one line (「Mikka 不使用你的内容训练模型」) and a link to
    the privacy policy.

## Supersedes

- [2026-11-23-2000](2026-11-23-2000-settings-models-capy-boardui.md) in part: decision 3's 「默认 Harness」 segmented row
  (rule 13), and decision 7's moves of the run-location section (rule 14) and of Agent profiles into 指令 (rule 18).
- [2026-11-02-1610](2026-11-02-1610-model-settings-r1-r5.md) in part: R1's 运行位置 row and its E2B-key actions (rules 14–15).
- [2026-11-02-0203](2026-11-02-0203-personal-workspace-keeps-bots.md) and
  [2026-11-02-0216](2026-11-02-0216-personal-workspace-has-workspace-settings.md) in part: 重新播放引导 under 偏好设置 (rule 6).
