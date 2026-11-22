# 群聊和 Bot 聊天是同一个产品

UX 审查第 6 项（群聊像另一个产品），工作包 F。状态：群里的发送者按 Alex 2026-11-22 的要求照 LobeHub 群聊做，待他看截图确认。

## 决定

1. **版面和 Bot 聊天一样。** 群聊用面板本身的底色，不再铺一层灰；阅读列 680px 居中（左右各 24px，手机 12px），输入框在列下居中，宽度和列一样。框架自己有标题栏时（`FRAME_OWNS_HEADER`），群聊不再浮一个标题胶囊，和 Bot 聊天一样；名字在右栏「详情」和手机的标题按钮里。
   - 自己的消息是右侧的灰色气泡，最宽 80%，和 Bot 聊天的用户气泡一样（`presentation: 'group-sent'`）。这一列占满整行，短消息不再折成两行（「第 32 条消息。」曾在 107px 的气泡里折行）。
   - 每条消息下的时间、复制只在悬停或聚焦时出现，触屏上常显，和 Bot 聊天一样（`HOVER_ACTIONS`）。
2. **群里每段发言带发送者，照 LobeHub 的群聊。** #2922 让 Bot 和 Agent 的回复只剩正文（静默回复），群里有几个 Bot 时就分不清是谁答的。Alex（2026-11-22）：照 LobeHub 群聊的做法。LobeHub 群聊里每条 Agent 回复都以一行头部开始：头像（28px 方形）、名字（14px、500）和时间，头部和正文间隔 8px，消息上下各 8px（`src/features/Conversation/ChatItem/ChatItem.tsx:127-162`，`Messages/Assistant/index.tsx:145-146` 的 `showTitle`，`ChatItem/components/Avatar.tsx:25`，`ChatItem/components/Title.tsx:28-51`）。Mikka 群聊照此：别人（Bot、Agent、其他成员）的每一段发言以「头像 + 名字」一行开始，正文在下方，间隔 8px；Bot 的正文仍是不带气泡的文字，其他成员的是灰色气泡。头像用 Mikka 消息头像的 24px，名字 14px、500。和 LobeHub 不同的三处：
   - LobeHub 每条消息都画头部；Mikka 把同一作者连续的消息合成一段（R-13），一段只画一次。
   - LobeHub 的时间在头部，悬停时显示；Mikka 的时间仍在消息下的操作行里（Figma `1318:59`），同样悬停显示。
   - 自己的消息不带头部；LobeHub 在多人工作区里自己的消息也带头像和名字（`Messages/User/index.tsx:76-89,151-152`）。
   Bot 聊天和线程里的回复保持静默（#2922、2026-11-15 Capy 式回复）。
3. **发送置顶。** 群聊不走 AgentThreadScreen，所以照 Bot 聊天的 `agent-thread.send-pin.patch`（LobeHub `useConversationScroll`）在群聊自己的滚动区里做一遍（`components/slots/thread-transcript-scroll.ts`）：自己发出一条消息后，它滑到视图顶部，列下留一块空白；回复写在下面，空白随之变小，填满后恢复跟随最新。加载、重新挂载、别人的消息都不置顶；重试失败的消息也不置顶。用户往上滚就放开。系统设置减少动态效果时直接跳到位，不滑动。
4. **群头像一致。** 侧栏的群行和群页面画同一个头像：群聊列表接口（`GET /api/conversations`）给每个群带上前三个 Bot 的形象（`bots`：id、颜色、形状、是否 Coordinator，不带名字），侧栏没有读过成员时用它，不再先显示标题的首字。顺序和成员接口一致。

## 和付费组件的关系

- 群聊的版面、气泡、发送者头部和置顶都是 Mikka 自己的代码（`thread-transcript.tsx`、`group-chat-view.tsx`、`chat-message.tsx` 的群聊样式）。原来自己的消息走 BoardUI 多 Agent 模板的 `UserBubble`（白色气泡，需要灰底衬托）；现在群聊不用它，改成和 Bot 聊天一样的灰色气泡。`CHAT_SURFACE` 随之删掉。
- 输入框是 affectUI Chat Composer Clean，独立放置时最宽 560px。群聊里让它和 AgentThreadScreen 自己的输入栏一样占满列宽（`.ui-th-foot__col > .ui-ccc` 的同一条规则，写在 hosted `slots/thread.tsx`）。这是组件在 Bot 聊天里已有的样子，不是新的视觉改动。

## 未做

- Bot 改了颜色或形状不会推送群列表；侧栏在下次读列表或打开群时更新。
