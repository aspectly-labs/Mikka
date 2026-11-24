# iOS: a 试用侧边栏 switch to try the bot sidebar on TestFlight

- Date: 2026-11-24
- **Status:** Accepted
- Source: Alex, relayed by the coordinator on 2026-11-24. After comparing Tembo's and Claude Duet's iOS apps he asked how other apps make a sidebar feel smooth, and chose to try one on his phone: 「你直接更新我们的TestFlight不行吗, 这样我能实测」, 「Expo是可以推送的呀」, then, offered a default-off switch shipped by OTA to everyone or a separate build, 「没事，你直接发就行了」.
- Rule: —
- Builds on: [2026-11-06-1200](2026-11-06-1200-ios-drop-drawer-comma-redesign.md) (no drawer) and [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) (the tabs), which stay in force while the switch is off.

- 设置 has a 试用侧边栏 switch (iOS only), off by default and kept on the phone. Off, the app is exactly as before. This flag is Alex's explicit decision (AGENTS.md, 「Ship features on」).
- On, Gesture Handler's own `ReanimatedDrawerLayout` (already in the app, so no new dependency and no native change) wraps the tabs, set up as Bluesky's app sets its drawer on the same React Native, Gesture Handler and Reanimated versions: on iOS the content slides right with the drawer and only a transform moves; a swipe to the right anywhere on a tab root opens it after 5 points; pushed pages keep the system back swipe because the drawer is locked there.
- Structure (Alex, 2026-11-24: 「直接侧边栏怎么做，bot，然后折叠thread，主页放chat，issues」): the sidebar lists the bots with the Coordinator first; a bot's row opens its chat and its chevron folds its threads in and out (the Bot info page's `botChildren` read, only while unfolded). Group chats and 新建 Bot / 新建群聊 follow. The tab bar becomes 聊天 · 任务 (Chat and Issues): 聊天 is the picked bot's chat (the Coordinator's until one is picked) and 任务 is the existing task list. 建议, 搜索 and 设置 are hidden; 设置 opens from the person's own row at the foot of the sidebar, so the switch can still be turned off. A bot's folded threads show the first page with 查看全部 for the rest.
- This is a trial of the feel, not the accepted navigation. Whether the sidebar replaces the tab structure is decided after Alex has tried it.
