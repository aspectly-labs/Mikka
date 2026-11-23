# 派出去的子 Agent 用 Agent Crew 的卡片

#2932、#2939，Figma「Chat+右栏」页 1318:2 第 21、22 节（1345:5028、1356:5024）。

## 决定

- 子 Agent 是父 run 的子 run：`agent_runs."parentRunId"` 指向派它的 run，`brief` 是派它时写的一句话。父子同一个所有者、同一个 Workspace，只设一次，不成环，由数据库触发器保证。名字、标记和模型不另存，取 run 冻结的 Agent 配置和它的模型，和其它线程读法一样。多 Agent 冲突仲裁仍归 #1729。
- 线程或聊天里出现派出去的 run 时，画成一块「子 Agent」：块标题和计数，下面两张一行，最多 4 张，其余折叠成「还有 N 个子 Agent」，可以展开。点卡片打开那个子 Agent 的线程。Bot 聊天里派出的线程、线程里由某个 run 派出的子 run，以及任务对话里的评审和验证子对话，都用这块。
- 卡片取自 affectUI Agent Crew，只取卡片，不要树、连线、交接光、上下文条、工具、详情和项目切换。这是 Agent Crew 的新使用位置，卡片原样使用、只换数据：Crew 自己的 `logo` 槽放 ProfileMark（第 21 节，带状态），名字、模型、状态文字和第二行换成子 Agent 的数据。
- 卡片状态只有五种：运行中、等你、完成、失败、排队。标签和 ProfileMark 的状态用同一个映射（`runMarkStatusOf`）：排队和完成静止，暂停和停在提问上算等你。
- 块标题、计数和折叠行是 Mikka 自己的界面，用 BoardUI 的 token 和字体。

## 和设计稿不一样的地方（原样使用优先）

- 第二行按 Crew 原样只显示一行，超出省略，悬停看全文；设计稿写最多两行。
- 等你时 Crew 把状态胶囊和第二行换成 warning 色，不改边框；设计稿写只把边框换成 warning 色。
- 状态胶囊保留 Crew 自带的小图标；设计稿的胶囊只有文字。
- 设计稿块标题右边的「在右栏看全部」没有做：右栏还没有子 Agent 页（#2930 之后再接）。

## 数据缺口

- Mikka 现在没有「一个 run 派出另一个 run」的入口（worker MCP 没有派发工具），`parentRunId` 目前只能由 `linkSubagentRun` 写入，等 #1729 接上。Bot 聊天里的派发没有父 run，卡片照样显示，`brief` 由 Bot 的 `dispatch_run`、`dispatch_bot_computer` 新增的可选参数写入；没有 brief 时第二行显示线程标题。
