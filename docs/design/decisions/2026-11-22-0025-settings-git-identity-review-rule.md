# Git 提交身份、GPG 签名边界与内置审阅角色边界

来源：#3110 WS-A（帧 19 Git 与发布，对齐 #2957 前端设置页，独立于 P5 #2973 的 PR 默认值与自动审阅仓库开关）。

## 1. 提交作者与邮箱（`gitAuthorName` / `gitAuthorEmail`）

在 `lib/settings/registry.ts` 注册两个可继承标量字段（`group: 'git'`，`page: 'git'`，`personalContext: 'workspace'`）：

- `gitAuthorName`：字符串，trim 后长度 `<= 100`（无控制字符与 `<>`），默认值 `""`。
- `gitAuthorEmail`：合法邮箱字符串（长度 `<= 254`）或 `""` 表示使用默认回落，默认值 `""`。

两者复用 P1 类型化表（`personal_setting_values` / `workspace_setting_values`）与 `resolveSettingValue`，返回 `{ value, source: 'personal' | 'workspace' | 'default' }`。个人 `null` 继承工作区值，再继承默认空串；个人显式写入 `""` 覆盖工作区配置并回落到默认行为。

运行认领链路（`readCliRunPolicy(..., { includeGitIdentity: true })` -> `POST /v1/devices/:deviceId/runs/:runId/claim` -> `@mikka/protocol/device` `RunAssignment.gitIdentity` -> `@mikka/daemon`）在已有工作区成员锁与运行策略事务中按需解析非空的 `name` / `email` 并下发到 daemon（不影响模型准入或订阅上下文读取路径的语句预算）。`packages/daemon/src/agents/publish.ts`（`publishRun` 与 `retainDeliverable`）按字段独立执行三级优先级：

1. 仓库本地 `git config`（`user.name` / `user.email`，隔离宿主全局与系统配置，防止宿主 `~/.gitconfig` 覆盖工作区或个人设置）
2. 运行下发的已解析设置（`gitAuthorName` / `gitAuthorEmail`）
3. `FALLBACK_IDENTITY`（`Mikka Agent <agent@mikka.invalid>`）

## 2. GPG 签名提交（评估结论：`pro:blocked`，不伪造开关）

端到端核查确认当前架构下无法安全交付真实 GPG 签名提交，不提供伪造或仅保存布尔值的假开关：

1. **沙箱与进程隔离边界**：`packages/daemon/src/agents/github-runtime.ts:80-88` 与 `local-github.ts:62-63` 显式注入 `commit.gpgSign=false`、`tag.gpgSign=false`。Agent 在受限沙箱内运行，宿主 `gpg-agent` socket、硬件密钥（YubiKey/SmartCard）、macOS Keychain / 1Password 签名器在沙箱内不可达（见 `packages/daemon/test/github-runtime.test.ts:156-169`）。
2. **Daemon 发布安全加固**：`packages/daemon/src/agents/publish.ts:58-67` 的 `SAFE_GIT` 固定 `-c commit.gpgSign=false` 与 `-c core.hooksPath=/dev/null`，防止工作树内不受信任的配置在宿主 daemon 上触发外部 `gpg.program` 执行。
3. **凭据暴露边界（[`2026-11-08-0240`](2026-11-08-0240-credential-exposure-boundary.md)）**：E2B 云端任务机与本地 daemon 仅接收当前线程运行所需的最小运行期凭据（选定 CLI 订阅租约、单仓库短期 GitHub 凭据、不可读出站能力）。向任务机或 daemon 下发用户长期 GPG 私钥与口令违反凭据暴露边界。
4. **缺少密钥托管与公钥同步基础设施**：仓库内无 GPG 密钥生成、KMS/HSM 远端签名服务、密钥环存储或 GitHub 公钥同步（`/user/gpg_keys`）实现；E2B 模板不含任何用户身份或密钥环。

该子项标记 `pro:blocked`，后续若产品决定支持签名提交，需单独设计基于 GitHub App GraphQL `createCommitOnBranch` 服务端签名或受控 KMS 签名代理，而非下发私钥。

## 3. 工作区审阅角色边界（Alex，2026-11-21：剥离 `reviewRuleSchema` 独立 CRUD）

内置 Software Factory 的 `stage='review'` 是产品唯一的 App Reviewer 审阅角色，自动审阅触发仓库开关与审阅参数由 P5（#2973，`review-repositories` 与 `codeReview*` 注册字段）统一承载。因此不单独新增 `workspace_review_rules` 数据表或 `reviewRuleSchema` 设置页 CRUD / Desktop RPC 接口，避免引入与内置 Factory 审阅流水线平行的冗余规则配置面。
