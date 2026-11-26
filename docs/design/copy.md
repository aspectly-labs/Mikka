# UI 文案规范

这份文件约束 Mikka 界面上出现的每一句可见文字。规则编号 `C-nn`，审查时可以引用
（「breaks C-03」）。与 `rules.md` 的 R-40（不写废话）配套使用：R-40 管「要不要写」，
这里管「怎么写」。

## 总原则

- **C-01 状态行，不是句子。** 界面文字描述当前状态或结果，不描述过程、不解释原因。
  Linear 产品内文案的标准是「quiet, status-line, almost wordless」；我们照这个标准。
- **C-02 不口语化。** 不用「了」「吧」「呢」「哦」「啊」「咱」这类语气词，不用
  「没做成」「打不开了」「还在」这类口语结构。用「失败」「无法打开」「已保留」。
- **C-03 不道歉、不卖萌、不幽默。** 不用「抱歉」「请稍等」「Oops」「哎哟」。
  错误发生时，用户要的是状态和下一步，不是情绪。
- **C-04 「请」按场景用。** 中文的「请」主要用来标出「这是要用户做的事」，不是客套，
  不能一刀切删除。先看组件里这句文字旁边渲染了什么，再归类：
  1. **旁边有重试或对应操作按钮**（同一组件里渲染了按钮）→ 不写「请重试」「请稍后重试」，
     按钮承担动作，文字只留状态和影响。例：`自动保存失败，修改已保留。` +「重试保存」按钮。
  2. **需要用户在界面外做的事**（允许弹窗或第三方 Cookie、检查邮箱、先用别的方式登录再去设置关联、
     联系管理员、查看日志、刷新页面）→ 保留「请」，写完整句。
     例：`浏览器阻止了新标签页，请允许弹出窗口后重试。`
  3. **没有按钮，也没有其他下一步**（toast、服务端返回的错误、Bot 消息）→ 保留「请稍后重试」
     之类的下一步，不能只剩状态。例：`属性保存失败，请稍后重试。`
  4. **标签、按钮文字、占位符、标题** → 不加「请」。占位符可以直接写 `输入网址，例如 example.com`。

  拿不准属于哪一类时按第 3 类处理：多一句下一步，比让用户卡住好。
  删掉「请」后只剩光秃秃的祈使句（`重新获取。`、`使用邮箱继续。`）是错误写法：要么保留「请」，
  要么改成陈述句（`任务标题不能为空`）。
- **C-05 不指责用户。** 不用「你忘了」「输入有误」。用「标题不能为空」这类陈述。
- **C-06 用界面上同一个词。** 触发按钮叫「分享」,反馈里就用「分享」，不换成「共享」。
- **C-07 现在时描述仍然成立的状态，过去时描述已经发生的事件。**
- **C-08 具体。** 能写数字、日期、对象就写，不用「出错」「异常」「失败」兜底。
  兜底只用于确实无法归因的情况。
- **C-09 线程，不写对话。** 中文界面里线程、Bot 的聊天、目录和新建入口一律叫「线程」，不写「对话」
  （Alex，2026-11-15）；群聊是加了成员的线程，只在指出多人时叫「群聊」，入口写「添加成员」，不写「新建群聊」
  （[2026-11-26-0110](decisions/2026-11-26-0110-pages-environments-from-benchmark.md)）。只有「对话框」（dialog box）保留这两个字；
  「会话」只指登录会话。英文照 `glossary.md`。
- **C-10 状态条与信息密度预算（Design System v2）。** 照 ChatGPT / Codex 与 Claude Code 标准（[`design-system.md`](design-system.md) §5，[2026-11-24-1518](decisions/2026-11-24-1518-design-system-v2-chatgpt-cc-standard.md)）：
  - 额度、限流、模型不可用、离线等非阻塞提示用**单行状态条**（40–44px）：2–5 字状态标题 + 同行简短元信息（如重置时间）+ **最多 1 个主操作按钮** + 可选关闭或 `…` 次级菜单；不放段落、不放开关、不堆 4–6 个按钮。
  - 输入框的模型胶囊只显示模型名（受限时可加小圆点），不把整句额度提示拼进胶囊里。
  - 审批或提问卡片底部最多 2–3 个控件；原始错误堆栈、参数和 ID 一律折叠在 `详情` 内，界面绝不泄露原始 UUID、枚举 key 或错位语言分隔符（英文禁用中文顿号 `、`）。
- **C-11 标签只放标签，值只放值。** 标签写名称或动作，值写数据，各自不加别的（Alex，2026-11-25；
  来源见「来源」表，[2026-11-26-0200](decisions/2026-11-26-0200-best-practice-review-copy.md)）：
  - **标签是 1–3 个词**（中文一般 2–6 字）的名词或动词短语，不写句子，不带句号、冒号，不加「一个」「的」这类虚词；
    不写「将会」「用于」「可以」这类说明。
  - **不加括号注释**：写 `模型`，不写 `模型（用于新线程）`；写 `Claude Sonnet`，不写 `Claude Sonnet（推荐）`。
    只有两种例外：可选字段末尾的 `（选填）` / `(optional)`；第一次出现的缩写或术语的全称。单位放进输入框后缀，
    「推荐」「默认」用徽章或次级文字，复数用 ICU `plural`，不写 `(s)`。
  - **不复述旁边已经显示的信息**：标题、分组名、同一行已显示的对象，不在标签、值、帮助文字或 tooltip 里再说一遍
    （行里已有仓库名，值就不再写「仓库：」或再写一遍仓库）；tooltip 不重复按钮文字。
  - **解释分三档**：完成操作**必需**的（格式、限制、后果、去哪里找）常显，放在字段下一句帮助文字（不带句号）或错误
    文字里，不放 tooltip、不放占位符；少数人需要的补充放 tooltip；其余不写。需要解释界面怎么用，先改界面。
  - **先看对标**：写一处文案前，先看 Capy / Codex（再 ChatGPT、Claude、Cursor、Devin、Perplexity）同一处怎么写；
    它们那里没有这段字，就不加。

## 错误状态

结构：**发生了什么 + 影响 + 下一步**。三者能省则省，但「影响」不能省。

| 场景 | 写 | 不写 |
|---|---|---|
| 请求失败 | 创建失败 | 创建失败了 / 没能创建 / 创建时出错了 |
| 加载失败 | 线程加载失败 | 线程没加载出来 |
| 页面打不开 | 链接已失效 | 这个链接已经失效了 |
| 崩溃 | 任务内容无法加载 | 任务的这一部分出错了 |

「下一步」由谁承担看 C-04：组件里有重试或对应按钮时，按钮就是下一步，文案不重复按钮名；
没有按钮时（toast、服务端错误、Bot 消息），下一步写在文案里，例如 `创建失败，请稍后重试。`。
需要用户去界面外处理的，写清楚去哪里做什么：`成员资格已停用，请联系管理员恢复。`

## 失败与未确认

「请求抛错」不等于「操作失败」：服务器可能已经完成、响应丢失。这类状态必须说
**未知**，不能报成功，也不能报失败。

| 场景 | 写 |
|---|---|
| 停止分享请求抛错 | 停止分享未确认 / 当前共享状态未知 |
| 停止线程超时 | 停止未确认 |
| 发送失败但草稿还在 | 发送失败，草稿已保留 |

恢复动作单独放按钮：重新检查、重试停止、重试。

## 空状态

- 一句话说明**这里会有什么**，加一个动作。
- 不用「这里是空的」「暂时没有内容」。
- 不卖萌（Apple：whimsical 的文案翻译后容易失效）。

例：`没有打开的网页` + 「打开网页」按钮。

## 按钮

- 写具体动作：`停止分享`、`重新复制`、`打开设置`，不写 `确定`、`是`、`好`。
- 破坏性动作与取消成对出现，顺序固定：破坏性在右（Apple HIG）。
- 按钮、标签、占位符和标题里不出现「请」（C-04 第 4 类）。
- 按钮旁边的提示不重复按钮的动作（C-04 第 1 类）：有「重试」按钮，就不再写「请重试」。

## 来源

| 规则 | 来源 |
|---|---|
| C-01 | Linear 产品内文案：quiet, status-line, almost wordless |
| C-02 / C-03 | Microsoft Writing Style Guide（no colloquial words）；Apple WWDC22（"oops"/"uh-oh" 显得居高临下） |
| C-04 | Shopify Polaris 与 Microsoft 的 "avoid please" 只适用于英文按钮和提示；中文「请」标出用户指令，按场景保留（本仓库复核结论） |
| C-05 | GitHub Primer（do not blame the user）；Microsoft（不让人自责） |
| C-06 | GitHub Primer（use the same terms as the UI that triggered it） |
| C-07 | Microsoft（present tense for a state that still exists） |
| C-08 | Shopify Polaris（specific, exact numbers and dates）；Material 3（explain consequences neutrally） |
| C-11 标签短、不成句、不带句号或冒号 | [Polaris Form layout](https://polaris-site-prod-kit.shopify.prod.shopifyapps.com/components/layout-and-structure/form-layout)（"Labels are not help text … Short and succinct (1–3 words)"）；[NN/g UI copy](https://www.nngroup.com/articles/ui-copy/)（"no more than 2–4 words. Avoid overexplaining"）；[Microsoft Windows writing style](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style)（"Don't end text for buttons, radio buttons, labels, or checkboxes with a period"）；[GOV.UK](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)（"input field labels are sentence case, but not punctuated"）；[Material 2 Writing](https://m2.material.io/design/communication/writing.html)（"Skip colons after labels"）；[Atlassian](https://atlassian.design/foundations/content/language-and-grammar)（"Avoid articles in buttons, labels"） |
| C-11 不加括号注释 | [Elastic EUI](https://eui.elastic.co/docs/content/writing/guidelines)（"Don't … add parentheses ()"，"Don't: Use (s), a colon after labels, or parenthetical statements"）；[GitLab Pajamas](https://design.gitlab.com/content/punctuation)（parentheses "Use only to define acronyms or jargon … Avoid other uses"）。例外 `（选填）`：[GOV.UK Question pages](https://design-system.service.gov.uk/patterns/question-pages/)（"add ‘(optional)’ to the labels of optional fields"）与 Polaris 相同 |
| C-11 不复述 | [Elastic EUI](https://eui.elastic.co/docs/content/writing/guidelines)（"Don't repeat what's already been said or state the obvious"）；Polaris 帮助文字（"Avoid repeating the field label"）；[NN/g Tooltip guidelines](https://www.nngroup.com/articles/tooltip-guidelines/)（tooltip 重复按钮文字 "repetitive and unnecessary"）；[Apple HIG Writing](https://developer.apple.com/design/human-interface-guidelines/writing)（"“Favorites” conveys the same message as “Your Favorites”"，"Check each word to be sure it needs to be there"） |
| C-11 解释分三档 | [NN/g Tooltip guidelines](https://www.nngroup.com/articles/tooltip-guidelines/)（"field requirements, shouldn’t be in a tooltip … Important information should always be on the page"；"If you can’t think of particularly helpful content, don’t offer a tooltip"）；[GOV.UK text input](https://design-system.service.gov.uk/components/text-input/)（hint text "relevant to the majority of users … a single short sentence, without any full stops"）；[GOV.UK](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)（"Fix the interface so it does not need explaining"）；[Material 2](https://m2.material.io/design/communication/writing.html)（"Communicate only essential details … Sometimes the most effective UI contains no text at all"） |

## 写文案时用的 skill

写或审 UI 文案时按顺序用这些 skill；它们与本文件冲突时以本文件为准。

| Skill | 用来做什么 |
|---|---|
| `unslop`（[`.claude/skills/unslop/`](../../.claude/skills/unslop/SKILL.md) 第 4 节 Copy 与 `references/signs.md` 的 Copy） | 必用。短标签、标签和按钮不带句号、不用感叹号、问候标题和 hype 词 |
| `kubai-design-tips` 的 `notes/design-system-pass.md` 第 5 节（`mikka-hosted-ui/.claude/skills/kubai-design-tips/`） | 必用（整屏或整页文案收敛时）。删掉重复界面已显示内容的文字；少用的帮助移进 tooltip 或内联提示 |
| `design:ux-copy`（插件，会话里有就用） | CTA、确认框、空状态的结构。它的 "Human / empathetic / celebratory" 语气让位于 C-01、C-03 |

`interface-design:design-deslop` 只管视觉，没有文案规则；`mobbin:plain-writing` 只用于 Mobbin skill 写给人的报告；
`writing-for-agents` 用于 AGENTS.md 和 skill。三者都不用于 UI 文案。

## 历史文案复核记录

下面记录该次文案修订的计数与例子；它们不代表当前消息字典的条目总数。

第一轮按旧 C-04「不写请」机械删除了 238 条「请」，复核后按新 C-04 逐条看组件重新归类：

| 归类 | 条数 | 处理 |
|---|---|---|
| 第 1 类：旁边有重试或对应按钮 | 32 | 保持删除「请重试」；删坏的句子改写成状态 + 影响 |
| 第 2 类：界面外的指令 | 141 | 恢复「请」，写完整句 |
| 第 3 类：没有按钮、没有其他下一步 | 55 | 恢复「请稍后重试」等下一步 |
| 第 4 类 / 已改成陈述句 | 10 | 保持（标题、状态标签、`任务标题不能为空` 这类校验提示） |

合并 main 后新进来的 28 条带「请」文案中，26 条本身符合新 C-04，保持不变；
另外 2 条做了调整（`连接失败，请重试` 旁边有重试按钮，改为 `连接失败`；`暂时没能完成` 口语化，改为 `暂时无法完成`）。

| 改动前 | 改动后 | 归类 |
|---|---|---|
| 重置链接无效或已过期，重新获取。 | 重置链接无效或已过期，请重新获取。 | 2 |
| Google 登录暂未配置，使用邮箱继续。 | Google 登录暂未配置，请使用邮箱继续。 | 2 |
| 浏览器阻止了新标签页，允许弹出窗口后重试。 | 浏览器阻止了新标签页，请允许弹出窗口后重试。 | 2 |
| 等待心跳超时，查看 ~/.mikka/daemon.log | 等待心跳超时，请查看 ~/.mikka/daemon.log | 2 |
| 检查填写内容 | 请检查填写内容。 | 2 |
| 属性保存失败。 | 属性保存失败，请稍后重试。 | 3 |
| 退出失败。 | 退出失败，请稍后重试。 | 3 |
| 密码恢复暂不可用 | 密码恢复暂不可用，请稍后重试。 | 3 |
| 无法取得控制权 | 无法取得控制权，请重试。 | 3（toast） |
| OAuth 登录未完成，可能已取消或授权已过期。重新尝试。 | OAuth 登录未完成，可能已取消或授权已过期。 | 1（登录按钮仍在） |
| 重试，或直接打开 skills.sh 浏览技能。 | 目录内容未显示，不代表没有匹配的技能。 | 1（「重试」「打开 skills.sh」按钮） |
| 已保留上次结果以获取最新权限。 | 已保留上次结果，权限可能不是最新。 | 1（「重新加载」按钮） |
| 提交失败，选择和回答已保留，在此重试。 | 提交失败，选择和回答已保留。 | 1（提交按钮仍在） |

英文：指令型句子（第 2 类）可以保留 `Please`；第 3 类恢复 `Please try again.` 等下一步；
第 1 类不写 `Try again`。`couldn't` / `can't` / `doesn't` 是 Microsoft Style Guide 推荐的标准缩写，
不算口语，不改。

## 自动检查

`node scripts/check-copy.mjs` 只拦截脚本能确定的违规，不猜「请」该不该写。

检查：

- 标签类 key（key 名以 `Button` / `Label` / `Placeholder` / `Title` / `Heading` / `Tab` / `Tooltip` / `Cta`
  结尾，或就叫 `title` / `label` / `placeholder` 等）的中文值里出现祈使「请」（`邀请`、`申请`、`请求` 不算）。
- 脚本里显式维护的 `retryButtonKeys` 名单：这些文字旁边渲染了重试或对应按钮，中文不能写「请……重试」，
  英文不能写 `try again` / `retry`。给文字旁边加按钮时把 key 加进名单，按钮去掉时移出；名单里的 key
  在 messages 中不存在也会报错。
- C-02 中文口语（「没能」「没发出去」「打不开了」、句末「吧」「呢」「哦」「啊」）。
- C-03 道歉和感叹（「抱歉」「对不起」「请稍等」「请稍候」、`sorry`、`oops`）。
- C-09 中文值里的「对话」（「对话框」除外），由 `pnpm i18n:check`（`scripts/check-i18n.mjs`）拦截。
- C-10 状态条按钮预算与原始 UUID/占位符泄露，由 `mikka-hosted-ui/scripts/copy-budget.test.mjs` 静态拦截。
- C-11 标签形状（棘轮）：标签类 key（以 `Button` / `Label` / `Title` / `Heading` / `Tab` / `Cta` 结尾，`Tooltip`、`Placeholder`
  不算）去掉 ICU 参数后，不以句号结尾，不含括号注释（`（选填）` / `（可选）` / `(optional)` 放行）。规则之前就有的条目记在
  `scripts/check-copy-baseline.json`，只对新出现的失败；修好一条就删掉它的基线行。测试：`scripts/check-copy.test.mjs`。

不检查：

- 完整句里的「请」该不该保留：取决于组件里有没有按钮，按 C-04 人工判断。
- 英文缩写（`couldn't`、`can't`、`doesn't`）。
- 状态行有没有给出下一步（第 3 类），审查时人工核对。
- C-11 的复述、标签里的说明性句子、帮助文字该不该常显，审查时人工核对（独立截图审查也要对照 C-11）。

## 尚未收敛

- 「请」的归类依赖组件当前渲染的按钮。改组件、加减按钮时，同步检查对应文案和 `retryButtonKeys`。
- 历史线程、归档内容和模型返回的正文不属于 UI 文案，不受本文件约束。
