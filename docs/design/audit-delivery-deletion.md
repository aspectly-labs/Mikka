# 删除保护下的持久审计投递

- **Status:** In Review
- **Owner:** root
- **Tracking issue:** [#3416](https://github.com/aspectly-labs/Mikka/issues/3416)
- **Target repositories:** `aspectly-labs/Mikka`
- **Related specs:** [账号删除](../settings-backend/account.md)、[工作区删除与审计留存](../settings-backend/workspace.md)

## 1. 问题与范围

生产审计投递反复出现 SQLSTATE `55000`。只读核对发现，删除申请后产生的登录失败审计已提交到 outbox，但通用工作区删除 trigger 拒绝其向审计表追加。删除流程尚处于外部清理阶段；审计失败与外部清理失败分别处理。

整改分两次小发布：先建立 pending 审计的留存保护，再修复删除 guard 下的可信追加。本 PR 只完成前者；不取消账号删除、不恢复业务写入，不处理订阅清理、UI 或新的调度机制。

## 2. 当前生命周期

`auditAuthentication` 读取真实账号和 active membership，并在持有 membership `FOR SHARE` 的事务中调用 `enqueueWorkspaceAudit`。outbox 无级联外键，原合同要求删除账号/工作区不能抹掉未投递证据。

`deliverWorkspaceAudits` 锁住一个 receipt，验证严格 payload，在主库按原 ID 插入并完整读回后，再提交 workspace outbox acknowledgment。历史 workspace migration 把通用 INSERT/UPDATE guard 也装到了保留的 `workspace_audit_events` 上，因此这个可信投递被意外挡住。

另一个交错发生在保留期到期时：目标表暂时为空不代表没有待投递证据。提前移除 `workspace_deletions` 和保留策略，会使稍后到达的审计失去原有期限。

## 3. 改动与合同

第一份 PR 只建立投递与保留任务的事务协调，不包含 schema migration。审计追加继续使用现有严格 payload、稳定 UUID、完整读回和事务边界；当前删除 guard 的拒绝行为仍可见，不吞掉其失败。

第一份正式上线并核验后，第二份独立 PR 才改审计表的 guard 为 BEFORE UPDATE，保留其它表、函数、账号与工作区 tombstone。后续主库/工作区两份条件式迁移分别覆盖 legacy guard 和 fresh shared-target 顺序，未知 trigger 形态拒绝。这些迁移与对应正向 guard 测试已准备，但不包含在第一份 PR 中。

投递沿用现有 `mikka-audit-retention:<workspace>` advisory lock 的共享模式，持有到主库提交、读回以及源 acknowledgment 完成。保留任务沿用独占模式；删除工作区到期时，先以普通 SELECT 检查 pending outbox，有 pending 则保留策略及 deletion record。这里不能锁 outbox 行，否则会与投递的行锁顺序反转。

原批次上限、失败 receipt 保留、重启重放和错误诊断不变。每个实际待投递 receipt 增加一次共享锁语句；空队列不增加查询。

## 4. 安全与隔离

没有新 endpoint、权限、凭据、用户可控绕过开关或遥测字段。第一份不修改任何删除 guard。第二份仅恢复可信审计追加，不能创建业务行、session 或新会员关系；删除保护下修改已有审计仍被拒绝。

最终 `deleteWorkspaceData` 删除 membership 时，会等待已经持有 `FOR SHARE` 的认证审计事务提交；之后新登录尝试查不到该 membership，不能再制造该工作区的 outbox。真实 Better Auth HTTP 与真实删除函数的锁交错测试覆盖这个收尾边界。

## 5. 兼容与回滚

没有客户端或内部协议变化。第一份没有 schema 迁移，兼容现有 API 与数据库，可按原流程回滚；此时尚未放开删除中的审计追加。

第二份必须等第一份生产发布与版本核验完成后再合并/发布，确保自动 rollback 的上一份 API artifact 已含本次留存保护。正式迁移经过既有受保护数据库窗口；迁移不会随代码自动回滚。若需要恢复旧 trigger，另开 corrective migration PR，并说明这会重新积压删除中的审计；不得直接改生产 guard、清 outbox 或抹掉已投递记录。

## 6. 验证

- `pnpm test:audit-db`：真实 PG17、完整现有迁移、真实 Better Auth 请求，包含 pending 策略保留、原 ID 幂等投递、双库重启与保留期。
- 真实 `pg_blocking_pids` 证明主库提交到源 ack 之间保留任务等待；最终会员删除等待 in-flight auth，删除后没有新 tenant intent。
- audit DB 文件组共用 fixture 数据库，串行运行各文件，防止 Better Auth 全库 schema introspection 与另一文件 DROP SCHEMA 交错；每个测试内部的真实并发连接/锁等待保持。首轮这类 fixture 失败日志保留，不冒称产品失败。
- 第二份将补入已准备的 guarded-auth 和迁移升级回归，覆盖旧 `55000`、fresh shared target 顺序、legacy main guard、重复执行、未知 guard 拒绝和共享函数逐字不变。
- `pnpm test:audit`、typecheck、lint、local-first 与完整生产构建；第二份另外执行 migration gates。
- UI、模型和设备验收不适用；没有相关变更或付费调用。

## 7. 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 清除 pending outbox 或吞掉 `55000` | 会丢失已提交证据，破坏原合同。 |
| 删除整个 workspace guard 或增加通用 bypass | 会扩大业务写入与恢复边界。 |
| 停止记录删除申请后的登录失败 | 不能处理已提交记录，也丢掉真实安全事件。 |
| 只放行 INSERT，不保护 pending 留存 | 仍可能提前丢失审计到期策略。 |

## 8. 发布与观测

先合并并发布第一份，通过 staging/production 核验 serving revision，记录可作为下一轮自动 rollback 的 artifact。第一份不承诺消除现有 `55000`。再完成第二份 guard 修复、受保护迁移与发布，核对 `mikka.audit.error_code=55000` 故障消失、pending 计数下降、原 receipt ID 可读回以及 reconcile 成功状态。不得把 CI 或合并视为生产恢复。生产只读取聚合及状态，不输出用户身份或审计内容。
