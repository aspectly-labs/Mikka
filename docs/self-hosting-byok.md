# 自托管：全部使用自己的服务

这些配置在服务器启动时读取。`MIKKA_EDITION=community` 是默认版本；自己的邮箱、文件、密码箱、模型和订阅都不需要 Mikka 账号。主部署步骤见 [自托管部署](self-hosting.md)。

## 邮件

| 变量 | 用途 |
| --- | --- |
| `MIKKA_EMAIL_FROM` | 发件人，例如 `My Mikka <login@example.com>`。未设置时沿用 `Mikka <noreply@aspectlylabs.com>`；自行部署应配置自己有权发信的地址。 |
| `SMTP_URL` | SMTP 连接串，例如 `smtps://user:password@smtp.example.com:465`，或 `smtp://user:password@smtp.example.com:587?requireTLS=true`。用户名、密码中的特殊字符需 URL 编码。 |
| `RESEND_API_KEY` | 没有 `SMTP_URL` 时使用的 Resend Key。 |

SMTP 优先。验证邮箱、找回密码、账号数据导出通知和额度告警复用 `lib/mail-delivery.ts`，使用同一个发件人和传输配置。SMTP 的 provider acceptance（服务端接受邮件）与 Resend 的有效消息 ID 都是发送成功的条件。日志不记录收件人、正文、登录链接、SMTP 凭据或供应商错误正文。

本地可使用 Mailpit，例如 `SMTP_URL=smtp://mailpit:1025`。SMTP 是否需要 TLS 由自己的邮件服务决定；`smtps:` 从连接开始使用 TLS，`smtp:` 支持 STARTTLS。发信实现使用 [Nodemailer SMTP transport](https://nodemailer.com/smtp)。

## 文件与 S3 兼容存储

| 变量 | 用途 |
| --- | --- |
| `S3_ENDPOINT` | 服务根地址，例如 `http://minio:9000` 或自己的 S3 兼容 HTTPS 地址。支持路径前缀。 |
| `S3_BUCKET` | 已创建的私有 bucket。 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 对该 bucket 有读写权限的凭据。 |
| `S3_REGION` | 签名区域，默认 `us-east-1`；MinIO 可使用此默认值。 |

S3 配置优先于 R2。配置其中一部分却缺少必要字段时会拒绝写入，不会将文件悄悄写到另一个位置。上传、下载、删除、短期私有下载地址和大文件直传共用该配置；存储的数据库枚举仍叫 `r2`，以兼容现有记录和所有文件消费者。

原有 `R2_ACCOUNT_ID`（或 `CLOUDFLARE_ACCOUNT_ID`）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ARTIFACTS_BUCKET` 保持有效。R2 的默认 bucket 是 `mikka-artifacts`。

社区版未配置 bucket 时，即使 `NODE_ENV=production`，文件仍存储在自己的 PostgreSQL 中。云版的生产部署仍要求对象存储。数据库备份需包含内联文件；使用 bucket 时需同时备份 bucket。

## 密码箱

社区版设置 `CREDENTIAL_MASTER_KEY`，值为严格 base64 编码的 32 字节随机密钥。例如在自己的安全终端运行 `openssl rand -base64 32`，将结果放入服务器的 secret 配置。

每条秘密继续使用独立随机 AES-256-GCM 数据密钥。主密钥只包裹数据密钥；owner、credential ID、网站 origin 和用途绑定到 authenticated additional data。密码、会话快照和被包裹的数据密钥使用不同用途，跨用户、跨站点或篡改密文无法解密。不要把此密钥提交进仓库；恢复备份需要原密钥，更换密钥需要先迁移既有记录。

社区版在同一进程调用现有 broker：一次性租约、浏览器页面绑定、权限检查、截图保护和审计保持有效，不需要部署 `services/credential-broker`。云版通过 Cloudflare 私有 broker/identity 使用 AWS KMS；即使意外设置本地主密钥，`MIKKA_EDITION=cloud` 也不会改用它。

## 必需的 LiteLLM 模型出口

社区版和云版都通过后台 LiteLLM 发出 Mikka 管理的模型请求，包括 Coordinator、标题、Decisions、Planning、转写，以及个人 API Key 的聊天和 Agent 运行。应用不再直连厂商、Vercel AI Gateway、Workers AI 或自部署模型。

| 变量 | 用途 |
| --- | --- |
| `MIKKA_LITELLM_URL` | 受信任 LiteLLM 服务的根地址，例如 Compose 内网的 `http://litellm:4000`；也支持包含 `/v1` 的地址。 |
| `MIKKA_LITELLM_MASTER_KEY` | 应用调用该 LiteLLM 的服务密钥；与 LiteLLM 的 `LITELLM_MASTER_KEY` 匹配。只放在服务端 secret 配置中，不交给 Agent。 |

两项缺一时，模型请求不可用，没有直连 fallback。模型准入、工作区权限、原有预算预留和用量记录仍由 Mikka 执行。daemon 的 API-key 运行使用本次运行绑定的 Mikka 网关令牌，经后台 LiteLLM；不把用户真实 Key 交给 CLI。

同机运行的 Desktop/daemon 可通过 HTTP loopback 连接本地服务器：`BETTER_AUTH_URL` 必须与连接地址的 origin 完全一致（协议、主机、端口），设备类型必须是本地。服务器只下发 `mkg_` 运行令牌和对应的 Mikka 模型网关地址，不下发厂商 Key。其他 HTTP 地址和云端设备仍需 HTTPS。支持该协议的 daemon 会发送 `x-mikka-model-gateway-loopback: 1`；旧 daemon 收到 `daemonUpgradeRequired`，运行保留在队列中，升级后再领取。

在 LiteLLM 中配置 `mikka-default`、`mikka-title`、`mikka-decision` 和 `mikka-planning` 别名。`mikka-title` 映射到 GPT-6 Luna；其他别名的实际模型和上游由部署者配置。Vercel AI Gateway、Neon AI Gateway、Workers AI 或自己的兼容模型都是 LiteLLM 上游；在 LiteLLM 的配置和 secret 环境中设置它们的凭据。参考同版本的 [`deploy/litellm/config.yaml`](../deploy/litellm/config.yaml)。个人 API Key 的模型和端点继续通过「模型与订阅」选择，后端将已授权的来源交给 LiteLLM，失败时不切换到 Mikka 的 Key。

旧 `MIKKA_DEFAULT_MODEL_*`、`ZEROCAT_*`、应用内 Workers AI 配置、`DECISIONS_URL`、`DECISIONS_API_KEY`、`OPENAI_DECISIONS_API_KEY` 和 `DECISION_MODEL` 不再提供独立模型路径。把实际模型、端点和上游凭据迁到 LiteLLM 配置后，再升级应用；只设置旧变量无法启用默认模型。Decisions 使用 LiteLLM 的原生 `/v1/decisions` 协议，别名是 `mikka-decision`。

官方 Claude Code / Codex 订阅 OAuth 保留独立连接路径，仍需完成下文部署的订阅后端。这是 [LiteLLM 决策](design/decisions/2026-11-20-0530-litellm-only-model-egress.md) 中等待兼容性验证和 Alex 决定的明确例外。未配置 LiteLLM 时，订阅连接本身不代表服务器的默认模型可用。

## PostHog 与功能缺省值

`POSTHOG_HOST` 配置完整的 ingestion URL，默认 `https://us.i.posthog.com`。项目 token 为 `MIKKA_PUBLIC_POSTHOG_KEY`（旧名 `NEXT_PUBLIC_POSTHOG_KEY` 和 `NEXT_PUBLIC_POSTHOG_HOST` 仍可使用，见[改名说明](operations/public-env-rename.md)）；本地求值使用的 secret 仍为 `POSTHOG_SECRET_KEY`。不设置项目 token 时，不创建客户端、不发送统计。Web 前端的公开 token 和 host 属于前端构建配置；桌面客户端使用连接服务器的功能快照。

### 桌面客户端的统计、错误报告和功能 flag

- **功能 flag**：桌面渲染进程的 CSP 只连接 app 自己，不加载 PostHog SDK。它读的 flag（`lib/feature-flags.ts` 的 `CLIENT_FLAG_KEYS`）由所连服务器在 bootstrap 里按同一个用户 id、在服务器配置的同一个 PostHog 项目中求值（`lib/desktop-rpc/features.ts`），再经 Web 同一个 `postHogFlag` 读出。所以自托管服务器的桌面客户端看到的是这台服务器自己 PostHog 项目的值；服务器没配 PostHog 时用上表的缺省值。flag 变化在下一次 bootstrap（启动、换账号或换工作区）生效，不另外轮询。安全和计费判断始终在服务器上做，客户端的值只决定界面显示。
- **统计和错误报告**：只有官方构建带 PostHog 项目的公开 ingestion key（发布时读取 `MIKKA_PUBLIC_POSTHOG_KEY`，旧名 `NEXT_PUBLIC_POSTHOG_KEY`）。发送地址取构建时的 `POSTHOG_HOST`（旧名 `NEXT_PUBLIC_POSTHOG_HOST`），未设置时为 `https://us.i.posthog.com`，与 Web 的缺省一致；官方发布不设置它，因为 Mikka Cloud 的 PostHog 项目在美国区。社区版和自己构建的桌面客户端没有 key，什么都不发。官方客户端只在当前账号位于内置服务器（Mikka Cloud）时发送；连到自托管服务器的账号不向 Mikka 发送任何事件。
- **发什么**：由主进程发送，经过与 Web 相同的白名单（`lib/analytics-policy.ts`）：页面浏览（路由去掉 id 和查询串）、Web Vitals、渲染进程错误（`$exception`：错误类名和 app 自己打包代码的栈帧，即函数名、`mikka://app` 下的打包文件和行列号；桌面端把错误信息换成类名，不发送）、渲染/运行错误的类名（`frontend_render_error`、`frontend_runtime_error`），以及桌面自己的 `desktop_api_error`（被拒绝或失败的 API 请求：路由模板、方法、状态码、错误码）、`desktop_main_error`（主进程错误类名，不含信息和堆栈）和 `desktop_process_gone`（子进程退出原因）。每个事件带 `platform=desktop`、版本号和公开仓库、官方 UI 两个提交 SHA。不发送消息、代码、文件内容、路径里的 id、错误信息，也不发送 app 自身代码以外的栈帧。主进程自己的报告每小时最多 200 条，同一种失败 10 分钟内只报一次；共享关闭、自托管或构建没有 key 时，这些报告既不发送也不计数。
- **关闭**：设置 › 电脑 › 隐私 ›「共享使用情况和错误报告」，默认开；选择保存在本机用户数据目录的 `telemetry.json`（同时保存登录前使用的匿名 id），关闭后统计和错误报告都不再发送，与 Web 的退出开关同时停止统计和错误事件的做法一致。
- **崩溃转储**：Electron `crashReporter` 需要接收 minidump 的端点，目前没有，所以不启用；渲染进程崩溃只以 `desktop_process_gone` 记录原因。

以下是没有 PostHog 时的社区版默认行为。明确设置的管理员旧环境变量仍优先；连接了 PostHog 后，明确的远程布尔值优先。云版 deployment switch 保持原有远程/旧变量回退顺序。

| Deployment switch | PostHog key | 社区版缺省 |
| --- | --- | --- |
| `credentialVault` | `mikka-credential-vault-off` | 开 |
| `agentKit` | `mikka-agent-kit-off` | 开 |
| `agentKitLiveEval` | `mikka-agent-kit-live-eval` | 关 |
| `cloudComputerTasks` | `mikka-cloud-computer-tasks-off` | 开 |
| `issueTools` | `mikka-issue-tools-off` | 开 |
| `factoryRouting` | `mikka-factory-routing-off` | 开 |
| `factoryLifecycle` | `mikka-factory-lifecycle-off` | 开 |
| `personalMailbox` | `mikka-personal-mailbox-off` | 开 |
| `personalWrites` | `mikka-personal-writes-off` | 开 |
| `skillModelEvaluation` | `mikka-skill-model-evaluation` | 关 |
| `proactiveProfile` | `mikka-proactive-profile-deployment` | 关 |
| `groupContribution` | `mikka-group-contribution-off` | 开 |
| `byos` | `mikka-byos` | 开 |
| `byosClaudeOAuth` | `mikka-byos-claude-oauth` | 开 |
| `byosCodexOAuth` | `mikka-byos-codex-oauth` | 开 |
| `byosEnrollment` | `mikka-byos-enrollment` | 开 |
| `factoryVercelPublication` | `mikka-factory-vercel-publication` | 关 |
| `factoryVercelProduction` | `mikka-factory-vercel-production` | 关 |
| `deviceUnitFence` | `mikka-device-unit-fence-off` | 开 |
| `dbEgressSample` | `mikka-db-egress-sample` | 开 |

| 按用户 / UI flag | 没有项目时的 flag 值 | 结果 |
| --- | --- | --- |
| `mikka-byos-subscription-chat` | `true` | 订阅聊天可用 |
| `mikka-byos-subscription-native` | `true` | 订阅原生线程可用 |
| `mikka-cloud-computer` | `true` | 显示自带 E2B Key 的电脑功能 |
| `mikka-computer-billing` | `false` | 不启用电脑收费 |
| `mikka-email-sign-in-off` | `false` | 邮箱登录可用 |
| `mikka-computer-tab-off` | `false` | 电脑 tab 可用 |
| `mikka-proactive-profile` / `mikka-proactive-research` | `false` | 不打开实验能力 |
| 四个 `mikka-upcoming-*` | `false` | 不显示尚未实现的功能 |
| 未知 flag | `false` | 不凭未知 key 打开能力 |
| `mikka-linear-sync` | 关闭 | 保留 Alex 关闭的全局 Linear 同步；连接自己的 Linear 账号是另一条路径 |

2026-11-07 只读核对了 Mikka PostHog 项目 `670821`：订阅 [chat](https://us.posthog.com/project/670821/feature_flags/1022059) / [native](https://us.posthog.com/project/670821/feature_flags/1022061) 为所有人 100% 开；[enrollment](https://us.posthog.com/project/670821/feature_flags/1022075) 和 [数据库采样](https://us.posthog.com/project/670821/feature_flags/1024999) 对 production 为 100% 开；已建立的 kill flags 不活动。Factory 的历史 gate 名是 `mikka-factory-routing` / `mikka-factory-lifecycle`，production 100% 开，代码已使用默认开的 `*-off` 形式。电脑 UI 的生产启用还读取 `NEXT_PUBLIC_COMPUTER_ENABLED`，不能只看远程 gate 的 inactive 状态。BYOS/OAuth 的三个历史变量 `MIKKA_BYOS_ENABLED`、`MIKKA_BYOS_CLAUDE_OAUTH`、`MIKKA_BYOS_CODEX_OAUTH` 已通过 [生产配置只读检查](https://github.com/alexj11324/Mikka/actions/runs/42316591790) 确认均为 `1`。未建立远程 flag 的项仍保留明确管理员覆盖。

## Skills 搜索

技能目录读取需要 Vercel OIDC。没有可用部署身份时，接口不会向上游发出未认证请求，并返回 `skills_search_identity_unavailable`；上游拒绝身份时返回 `skills_search_identity_rejected`。其他上游不可用或响应不合规时，分别返回固定 `skills_search_unavailable` / `invalid_skills_response`，不泄露上游响应。社区版或 Cloudflare 部署若没有受支持的身份，仍可从页面打开 skills.sh 浏览；不需要用户提供 Mikka Key。

## 验证

`pnpm test:self-hosted-byok` 使用真实本地 SMTP socket 和 OpenAI-compatible HTTP fixture 验证传输协议，并覆盖 S3 签名/字节往返、邮件发件人、local KMS 隔离、无 OIDC 的 skills 搜索，以及不配 PostHog 的默认行为。不会发送真实邮件、调用收费模型或访问真实用户数据。部署验收另需在隔离域名使用自己的 Mailpit/SMTP、MinIO 和浏览器凭据流程，并按项目规则验证共享测试账号的云版兼容性。
