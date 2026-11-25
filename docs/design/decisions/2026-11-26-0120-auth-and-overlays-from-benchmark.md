# Sign-in, standalone pages, dialogs and menus follow the benchmark of top agent products

- Date: 2026-11-26 01:20 UTC
- **Status:** Accepted
- Source: Alex, 2026-11-25: 「找得到的为什么要交给我」 — questions that top products already answer are decided from
  that evidence, not handed to Alex ([2026-11-25-2330](2026-11-25-2330-owner-decisions-chat-memory-views-projects.md)
  rule 9). The sign-in / standalone-page and secondary-state benchmarks were checked against Capy, ChatGPT/Codex, Claude
  (with Claude Code), Cursor, Devin and Perplexity; GitHub, Linear or Vercel were consulted only where none of the six
  has the surface. Only the rows the evidence settles are recorded here.
- Rule: [2026-11-25-1630](2026-11-25-1630-paid-blocks-themed-by-mikka-tokens.md) 「benchmark first, not precedent」.
- Count: 「n/m」 is n of the m products that have the surface. Research IDs (AO…, DO…) refer to the resolved
  auth-overlays benchmark table.

## Decision

### Signing in

1. **Email first (AO-01).** The first screen is Google and GitHub (with a 「上次使用」 badge), then one email field and
   继续. The server picks the second step: password, code or SSO. Enterprise SSO is found by email domain, with one small
   text link; passkeys appear only where the browser supports them. Evidence 6/6 email-first with at most one input on
   the first screen (ChatGPT, Claude, Perplexity, Cursor, Devin, Capy's `start → sso / password / email-code` flow).
2. **Email is verified with a code (AO-03):** a 6-digit code in the flow (six boxes, paste, auto-submit when full), resend
   with a countdown, 「换一个邮箱」. The mail also carries a link as fallback; `/verify-email` is only the link's landing page
   (verifying, expired, already used, opened on another device). The backend moves from links to codes. Evidence 5/6
   code-first (ChatGPT, Cursor, Perplexity, Devin, Capy); Claude is link-first with a code fallback.
3. **Password reset happens inside the sign-in flow (AO-04):** 「忘记密码？」 on the password step → confirm the prefilled
   email → enter the code → set a new password (live rules; 「其他设备会退出登录」) → into the app. The password step also
   offers 「改用邮箱验证码登录」. `/forgot-password` and `/reset-password` remain only for old links. Evidence 2/2 products
   with password sign-in reset by code in-flow (ChatGPT, Capy); code sign-in as an alternative 3/3 (ChatGPT, Cursor,
   Capy).

### First run

4. **Onboarding asks at most two steps before the first thread (AO-05):** ① model source (subscription or Mikka 额度;
   skipped when a usable source exists); ② code access (GitHub repositories, or 「这台电脑」 on desktop). The workspace is
   created as 「{名字} 的工作区」 without asking for an address or the name again. Integrations, invitations, plan and the
   desktop app move to the home checklist (rule 5). Invited and same-domain users first see 「加入你的团队」 (rule 6). The
   affectUI Onboarding block is themed by tokens; removing steps changes data only. Evidence 5/6 ask at most two
   questions before the first prompt (ChatGPT, Devin, Cursor web, Perplexity, Claude); only Capy runs several steps, and
   its Subscription and GitHub steps are exactly these two. Personal workspaces are created automatically in 4/6.
5. **A 「开始使用 Mikka」 checklist under the home composer (DO-09):** connect GitHub, pick repositories, start the first
   thread, see the first PR, install the desktop app, create the first automation, invite members. Each item can be
   skipped, the list can be dismissed, and it disappears when done. Evidence 2/2 products that need setup before first
   use (Devin 「Get started 1 of 6」, Capy onboarding checklist).
6. **Workspaces can be found by email domain (AO-07).** After verifying a domain an admin turns on 「可被发现」 (off by
   default) and picks auto-join or approval. Same-domain users see 「{工作区}（{n} 位成员）· 加入 / 继续使用个人工作区」 after
   sign-up; the switcher's 「加入或新建工作区」 and `/workspaces/new` also list joinable workspaces. New backend switch on
   top of domain verification. Evidence 5/6 (ChatGPT Business discovery + auto-join, Claude organization discovery, Capy,
   Cursor domain auto-join, Devin by GitHub organization).

### Standalone pages

7. **One invitation landing page (AO-08),** merging `/invite` and `/organization-invite`; not an in-app dialog. It opens
   signed out with 「登录或注册」 embedded and the invited email prefilled; a different signed-in account is named, with
   「切换账号」. Pending invitations may also be listed in the workspace switcher. Evidence: standalone page in ChatGPT,
   Cursor and Claude; only Capy uses an in-app dialog (Linear and Attio also use a page).
8. **Device approval stays a standalone page (AO-09),** opened from the terminal or machine and returning there after
   sign-in. It adds 「以下信息由该设备上报，未经验证」, the anti-phishing line 「如果验证码是别人发给你的，请拒绝」, the target
   workspace, an editable device name, relative expiry and the state after approve / deny. 设置 › 设备 lists devices and
   links 「连接新设备」 to the same page. Evidence: OpenAI's device-code page, GitHub `login/device`, Vercel CLI; only Capy
   uses a settings dialog (its phishing warning is adopted).
9. **The OAuth consent page stays (AO-10).** The first-party CLI signs in through the browser (local callback) with a
   short 「授权 Mikka CLI」 page marked 「Mikka 官方」; device code (`mikka login --device`, rule 8's page) is the fallback for
   remote or headless machines. Third-party consent pages add publisher, trust and redirect details. Evidence 3/3 agent
   CLIs default to browser authorization (Claude Code, Cursor CLI, Codex CLI; GitHub CLI also shows an authorize page).
10. **A shared thread link opens the real thread for anyone with access (AO-06)** — thread sharing is permission-scoped
    (Alex). Without access: 「无法打开这个线程 · 当前账号 {邮箱}…」 with 「切换账号」 and 「返回 Mikka」. No 「复制到我的工作区继续」
    while sharing is permission-scoped (it only applies to public snapshots: ChatGPT, Claude, Perplexity 3/3).
11. **No 「Remix」 on a shared artifact (AO-11).** The public artifact header has 复制链接 / 下载, plus 登录 or 「在 Mikka 中打开」.
    Evidence 1/6 (Claude only).

### Dialogs and menus

12. **Sidebar search opens ⌘K (DO-01)** with the current section (threads / Bots) preselected; the sidebar's in-place filter
    goes. Evidence 4/4 products with a sidebar search entry open the same palette (Capy, ChatGPT, Codex, Claude; Devin has
    one palette).
13. **One create dialog (DO-02).** New task, new Bot and start-work use the same themed `Dialog` (md / lg, no grey footer,
    ghost Cancel), keeping 「继续新建」 and ⌘↵. New task's one-column body (large title, description, property chips) is
    unchanged; the Kanban `CreateWindow` shell is retired. Evidence: Capy uses one dialog primitive everywhere
    (`new-issue-dialog`, `dialog-pages`); Claude and Cursor each have one dialog look.
14. **No Start work dialog (DO-03).** The task page and `task-start-conversation` put 「环境 · 机器 · 交给」 chips under the
    composer; Send starts the work. The Harness pill is removed (copy rule). Evidence 4/4 start from the composer (Devin,
    Capy, Codex cloud, Cursor background agents).
15. **No separate new-group-chat dialog (DO-04).** A thread becomes multi-person through 「添加成员」 from new thread or the
    thread header; Bots and people share that picker. The dialog's 「模型」 (Harness) segment goes. Evidence 0/6 have a
    group-chat creation dialog (Capy adds people in the share dialog; ChatGPT stopped new group chats on 2026-07-09).
16. **One workspace-and-account menu, bottom left (DO-05):** identity → 切换工作区 ▸ (with 「加入或新建工作区」) → 设置 ⌘, →
    外观 ▸ / 语言 ▸ → 帮助 ▸ → 退出登录. 插件 is not in this menu. Evidence 5/5 verifiable products have one user menu (Capy,
    ChatGPT, Claude, Perplexity, Codex; Devin's 「My Team ▾」 is also one entry).

### Billing and versions

17. **Top-up confirms before charging (DO-06):** 充值 opens a Dialog (or right Sheet) with amount and presets, payment
    method (changeable), subtotal, tax and 今日应付, then 「购买 ${金额}」; failures name the cause (card declined, duplicate
    submission). Auto-refill is another segment of the same panel. Evidence 3/3 (Capy funding sheet, Perplexity Add
    credits, ChatGPT/Codex checkout).
18. **New versions never block by default (DO-07).** The web shows 「有新版本 · 刷新」 at the sidebar foot or tab bar; desktop
    shows 「重启以更新」. Only a server-declared minimum version the client no longer meets opens a blocking dialog.
    Evidence 4/4 non-blocking (Codex, Capy, Cursor, Claude desktop). Desktop details are in
    [2026-11-26-0110](2026-11-26-0110-pages-environments-from-benchmark.md) rule 17.
19. **Running out of credit is a notice card, not a paywall (DO-08).** In chat it is the single bottom slot's notice card
    (priority 3): the cause and reset time, then 「换免费模型 · 等到 {时间} · 用我的订阅接管 · 查看选项」. 查看选项 opens a funding
    sheet that lists free ways out before top-up and plans. Pages outside chat use a top banner. Send no longer opens a
    「选择套餐」 dialog first. Evidence: in-place notices in Claude, Cursor and Capy (`UsedUpCard`, `SponsoredRefusalCard`,
    `WaitMenu`; its funding sheet lists free options first).

## Not decided here (still with Alex)

- AO-02 whether sign-in and sign-up are one page or two (3 : 3). Both options keep rule 1.

The right column's Overview question raised in this benchmark (DO-10) is settled by
[2026-11-26-0110](2026-11-26-0110-pages-environments-from-benchmark.md) rule 10.

## Supersedes

- [2026-11-15-1900](2026-11-15-1900-models-on-gateway-like-capy.md) in part: rule 8's four-step onboarding (工作区, 模型,
  推荐, 套餐; rules 4–5) and the send-time 「选择套餐」 dialog (rule 19).
- [2026-11-02-1645](2026-11-02-1645-onboarding-bind-subscription.md) in part: its place in the old Bot-led onboarding;
  binding a subscription is now step ① 模型来源 (rule 4).
- [2026-11-15-1111](2026-11-15-1111-capy-create-windows.md) in part: 「窗口仍是 affectUI Kanban 的 `CreateWindow`」 — the shell
  becomes the shared Dialog; the one-column body stays (rule 13).
- [2026-11-19-2110](2026-11-19-2110-new-task-create-only.md) in part: moving dispatch into the task's 「Start work」 dialog
  (rule 14). New task still only registers.
- [2026-11-02-1638](2026-11-02-1638-desktop-update-on-launch.md): the cold-start desktop update gate (rule 18).
- [2026-11-03-1437](2026-11-03-1437-required-app-refresh.md) in part: the blocking dialog on any different web build —
  only a declared minimum blocks now (rule 18).
