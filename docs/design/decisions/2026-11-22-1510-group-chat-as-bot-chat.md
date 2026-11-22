# 群聊就是 Bot 聊天的那一个线程

UX 审查第 6 项（群聊像另一个产品），工作包 F。状态：Alex（2026-11-22）要求群聊和 Bot 聊天、Agent 线程用同一个聊天，群里的发送者照 LobeHub 群聊做；待他看截图确认。

## 决定

1. **同一个聊天。** 群聊不再有自己的消息列表（原来的 `ThreadTranscript`、群聊专用的消息样式和 `CHAT_SURFACE` 都删了），和 Bot 聊天一样交给 `ThreadScreen`，在官方版里就是 affectUI 的 AgentThreadScreen：同一个底色、680px 阅读列、输入框、时间分隔、悬停操作、发送置顶，以后的虚拟列表也一样。框架自己有标题栏时（`FRAME_OWNS_HEADER`）不再浮标题胶囊，和 Bot 聊天一样。
2. **群里每段发言带发送者，照 LobeHub 群聊。** 自己的消息是线程里「我」的消息。其他成员、Bot、Agent 的消息都是线程里的 agent 消息，各带自己的 `author`（头像和名字），由线程按它的规则显示：一段的第一条、作者变化处、自己的消息之后。群里的回复不是静默回复；Bot 聊天和线程里的回复仍静默（#2922、2026-11-15 Capy 式回复）。
   - LobeHub 群聊里每条 Agent 回复都以一行头部开始：28px 方形头像、14px/500 的名字和时间，头部和正文间隔 8px，每条消息上下各 8px（lobe-chat `src/features/Conversation/ChatItem/ChatItem.tsx:127-162`，`Messages/Assistant/index.tsx:145-146` 的 `showTitle`，`ChatItem/components/Avatar.tsx:25`，`ChatItem/components/Title.tsx:28-51`）。
   - 和 LobeHub 不同：LobeHub 每条消息都画头部，这里按线程的规则一段一次；时间在消息下的操作行，不在头部（Figma `1318:59`）；其他人的消息在左侧，而 LobeHub 在多人工作区里把每个人的消息都放右侧并带头像和名字（`Messages/User/index.tsx:76-89,151-152`）。要做到后者，需要给 AgentThreadScreen 加补丁，让「我」以外的人的用户消息也有作者行，这次没有做。
3. **群特有的东西是数据。** @提及在发送时解析；线程引用选择器在输入框上方的提示区；退出群聊的按钮在右上角；群头像是线程的标记；Bot 之间的对话标记是一行事件（没有作者）。自己发出的消息存好后保留发送时的行 id，不会重新挂载。
4. **群头像一致。** 群聊列表接口（`GET /api/conversations`）给每个群带上前三个 Bot 的形象（`bots`：id、颜色、形状、是否 Coordinator，不带名字），侧栏没读过成员时用它，不再先显示标题的首字。

## 补充（Alex，2026-11-22：群聊不好看，照成熟的聊天应用做）

5. **详情进线程的工作区。** 框架自己管右栏时（`FRAME_OWNS_PANEL`），群的「详情」和 Bot 的「概览」一样成为线程工作区里的一个标签，默认收起；聊天列在整页里居中，和 Bot 聊天同宽、同位置。打开后两者都占满剩下的宽度。手机上点标题按钮打开它。
6. **发言者的头部照 LobeHub。** 群里每段别人的发言以一行头部开始：28px 头像、14px/500 的名字、悬停时显示时间；正文、工具和操作行都对齐在名字下方（缩进 36px），头部和正文间隔 8px；群的行距 16px（LobeHub 每条上下各 8px），Bot 聊天仍是 24px。这是 AgentThreadScreen 的补丁 `patches/agent-thread.group-authors.patch`（Alex，2026-11-22：group authors, as LobeHub）。
7. **群的开头。** 加载到第一条消息时，历史的开头是群的头像、名字和成员，像 LobeHub 群聊的欢迎页和 Slack 频道的开头。
8. **谁在回复。** 正在回复的每个 Bot 各有一行：它的头部和等待，几个同时回复就按开始的顺序列出；还没被 Bot 接手时是群自己的等待。
9. **Bot 换形象会推送。** Bot 改名、换颜色或形状时，推送它所在的群的列表和成员（`group_list`、`group_chat`），侧栏的群头像跟着变。

10. **同一人的连续消息紧挨着（照 Slack、Discord、Teams）。** 群里同一作者连续的几条消息（中间没有时间线）相隔 4px；只有这一段的最后一条保留操作行的空间，前面几条的回复、复制和时间在悬停时浮在消息的末端，不占位置，也不挪动别的内容。Bot 聊天不变。补丁同上（`data-run-continues`）。
11. **群的开头、Bot 之间的对话和「没人接」「已停止」都是事件行**（`data-event-line`），线程不在它们上面画作者行。

## 未做

