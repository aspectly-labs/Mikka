# Git 提交身份、GPG 签名边界与工作区审阅规则接口

来源：#3110 WS-A（帧 19 Git 与发布，对齐 #2957 前端设置页，独立于 P5 #2973 的 PR 默认值与自动审阅仓库开关）。

## 1. 提交作者与邮箱（`gitAuthorName` / `gitAuthorEmail`）

在 `lib/settings/registry.ts` 注册两个可继承标量字段（`group: 'git'`，`page: 'git'`，`personalContext: 'workspace'`）：

- `gitAuthorName`：字符串，trim 后长度 `<= 100`（无控制字符与 `<>`），默认值 `""`。
- `gitAuthorEmail`：合法邮箱字符串（长度 `<= 254`）或 `""` 表示使用默认回落，默认值 `""`。

两者复用 P1 类型化表（`personal_setting_values` / `workspace_setting_values`）与 `resolveSettingValue`，返回 `{ value, source: 'personal' | 'workspace' | 'default' }`。个人 `null` 继承工作区值，再继承默认空串；个人显式写入 `""` 覆盖工作区配置并回落到默认行为。

运行认领链路（`readCliRunPolicy` -> `POST /v1/devices/:deviceId/runs/:runId/claim` -> `@mikka/protocol/device` `RunAssignment.gitIdentity` -> `@mikka/daemon`）在已有工作区成员锁与运行策略事务中解析非空的 `name` / `email` 并下发到 daemon。`packages/daemon/src/agents/publish.ts`（`publishRun` 与 `retainDeliverable`）按字段独立执行三级优先级：

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

## 3. 工作区审阅规则（`reviewRuleSchema` 读写与 Desktop RPC）

`packages/protocol/src/orchestrator.ts:242` 的 `reviewRuleSchema`（ADR ORV-172：`requirePullRequest`、`requireCi`、`checkHarness`、`branchTemplate`、`prBodyTemplate`）此前无服务端存储与读写入口，且与 P5 #2973 的 `review-repositories` 自动审阅触发列表职责正交。

新增幂等增量迁移 `workspace_review_rules` 表（主键 `("workspaceId", "repoKey")`，`repoKey = ''` 表示工作区默认规则，非空标准化 `host/owner/name` 表示按仓库覆盖条目，对应帧 19「+」添加规则能力），并提供：

- REST：`GET / PATCH / DELETE /api/settings/workspace/[workspaceId]/review-rules`
- Desktop RPC：`review-rule-settings.getWorkspaceReviewRules`、`review-rule-settings.saveWorkspaceReviewRule`、`review-rule-settings.deleteWorkspaceReviewRule`

权限边界：工作区活跃成员可读（`GET`），仅工作区管理员可写/删（`PATCH` / `DELETE`）；未登录返回 `401`，非成员、停用成员或跨工作区返回 `403`，普通成员写入返回 `403`。返回结构携带明确 `source`（工作区规则为 `'workspace' | 'default'`，仓库覆盖项为 `'repository'`，无个人级伪继承）。
