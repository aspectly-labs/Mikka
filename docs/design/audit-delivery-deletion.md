# 删除保护下的持久审计投递

- **Status:** In Review
- **Owner:** root
- **Tracking issue:** [#3416](https://github.com/aspectly-labs/Mikka/issues/3416)
- **Target repositories:** `aspectly-labs/Mikka`
- **Related specs:** [账号删除](../settings-backend/account.md)、[工作区删除与审计留存](../settings-backend/workspace.md)

## 1. 问题与范围

生产审计投递反复出现 SQLSTATE `55000`。只读核对发现，删除申请后产生的登录失败审计已提交到 outbox，但通用工作区删除 trigger 拒绝其向审计表追加。删除流程尚处于外部清理阶段；审计失败与外部清理失败分别处理。

整改分两次小发布：先建立 pending 审计的留存保护，再修复删除 guard 下的可信追加。第一份已建立事务与留存屏障；第二份只纠正审计追加的触发器。不取消账号删除、不恢复业务写入，不处理订阅清理、UI 或新的调度机制。

## 2. 当前生命周期

`auditAuthentication` 读取真实账号和 active membership，并在持有 membership `FOR SHARE` 的事务中调用 `enqueueWorkspaceAudit`。outbox 无级联外键，原合同要求删除账号/工作区不能抹掉未投递证据。

`deliverWorkspaceAudits` 锁住一个 receipt，验证严格 payload，在主库按原 ID 插入并完整读回后，再提交 workspace outbox acknowledgment。历史 workspace migration 把通用 INSERT/UPDATE guard 也装到了保留的 `workspace_audit_events` 上，因此这个可信投递被意外挡住。

另一个交错发生在保留期到期时：目标表暂时为空不代表没有待投递证据。提前移除 `workspace_deletions` 和保留策略，会使稍后到达的审计失去原有期限。

## 3. 改动与合同

第一份 PR 只建立投递与保留任务的事务协调，不包含 schema migration。审计追加继续使用现有严格 payload、稳定 UUID、完整读回和事务边界；当前删除 guard 的拒绝行为仍可见，不吞掉其失败。

第二份仅将 `workspace_audit_events` 已知的 `account_deletion_workspace_guard` 改为 BEFORE UPDATE，保留其它表、共享函数、账号与工作区 tombstone。主库和工作区各一份条件式 corrective migration，覆盖 legacy main guard、分库缺表和 fresh shared-target 顺序；没有数据回填或删除。

迁移只接受普通独立审计表，以及原函数、普通启用、逐行 BEFORE INSERT/UPDATE 或 BEFORE UPDATE、无参数、无条件、无列限定、无父 trigger 的已知 guard。缺表或普通表缺此 guard 保持 no-op；分区父表/子表、继承关系、非普通表以及未知 trigger 形态明确失败，事务保留原定义。迁移不会通过修改共享函数来绕过其它业务表的删除保护。

投递沿用现有 `mikka-audit-retention:<workspace>` advisory lock 的共享模式，持有到主库提交、读回以及源 acknowledgment 完成。保留任务沿用独占模式；删除工作区到期时，在确认源工作区已删除后，以普通 SELECT 检查 pending outbox，有 pending 则保留策略及 deletion record。这里不能锁 outbox 行，否则会与投递的行锁顺序反转。

在检查 pending 之前，先确认源 `mikka_workspaces` 行已经消失；若仍存在，返回 `workspace_present` 并保留策略。真实删除顺序是 APP 先提交、WS 后提交，后一步回滚可能保留 membership。普通 SELECT 在 WS 删除未提交时仍看到该行并跳过；看到行消失时，同一事务的 membership 删除已提交，先前持 `FOR SHARE` 的认证审计也已提交，随后 READ COMMITTED 的 pending 查询可看到它。这里不增加行锁，也不把主库 tombstone 当作工作区删除完成的证明。

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
- 双库中主库 tombstone 已过 90 天、WS 删除事务回滚且 pending 为零时，策略仍保留；其后新增的真实 outbox、最终 WS 删除、进程重启投递仍受原保留期约束。
- audit DB 文件组共用 fixture 数据库，串行运行各文件，防止 Better Auth 全库 schema introspection 与另一文件 DROP SCHEMA 交错；每个测试内部的真实并发连接/锁等待保持。首轮这类 fixture 失败日志保留，不冒称产品失败。
- 第二份的真实 Better Auth 请求验证删除申请后的原始 receipt ID 可投递一次、payload 清除且失败登录不产生 session；业务 INSERT/UPDATE、审计 UPDATE 和账号写屏障仍拒绝。迁移回归使用历史 guard 函数，覆盖 fresh shared target 顺序、两目标独立升级、缺表、重复执行、列限定/禁用 guard 拒绝，以及分区和继承的原生父子 trigger 定义逐字保留。
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

第一份已随 `9a82be9f59e5` 的正式生产版本核验，原发布回执与原生资源读回已核对；后续第二份发布必须使用包含第一份保护的回滚基线。该事实只解除第二份的发布依赖，不代表追加故障已修复。第二份仍须完成独立审查、门禁、受保护迁移与发布，随后核对 `mikka.audit.error_code=55000` 故障消失、pending 计数下降、原 receipt ID 可读回以及 reconcile 成功状态。不得把 CI 或合并视为生产恢复。生产只读取聚合及状态，不输出用户身份或审计内容。
