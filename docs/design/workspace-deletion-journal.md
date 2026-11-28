# 工作区删除的持久记录

本文面向实现和审查 #3439 的后端维护者，定义应用数据库中
`workspace_deletion_jobs` 的存储合同。第一份扩展只建立表、约束和工作区清理时的
保留规则。`deleteWorkspaceData` 尚未创建或恢复这些任务；双库删除的自动恢复由
#3439 后续行为 PR 接入并验收。

## 原始授权和作用域

`id` 标识一次删除请求，`workspaceId` 是唯一目标，`requestedBy` 是发起人的内部
用户 ID。记录不保存邮箱、工作区名称、HTTP session、令牌、供应商错误正文或凭据。
`authorizationVersion = 1` 表示写入方完成以下准入检查：fresh session、活跃 admin、
enterprise 约束、team 类型、确认名称和无活跃订阅。`authorizedAt` 是这次检查的时刻，
`requestedAt` 是受权请求入库的时刻。

这些列是受信业务代码留下的证据，**填写字段本身不授予删除权限**。读取者也不能把
某个历史 `workspace_deletions` 行转换成请求；迁移不扫描或回填历史 tombstone。
后台任务不保存和继承 HTTP session，不能因为请求人同时属于另一个工作区而扩大目标。

`teamIds` 和 `projectIds` 在准备完成时冻结，均为一维、无 NULL 元素的 UUID 数组。
NULL 表示尚未准备，空数组表示范围内没有该类对象。后续执行器必须先在目标工作区的
关系锁下验证每个 ID 的归属，执行时同时限定 `workspaceId`；空数组使用空集合语义，
不得转换为省略 WHERE、跨工作区查询或重新枚举全库。表不使用指向工作区、请求人、
团队或项目的级联外键，因此源对象删除后仍可读取恢复依据。

## 阶段与提交边界

约束验证每个阶段必须具有的时间戳、冻结范围和结果形状：

| 阶段 | 含义 | 持久结果 |
| --- | --- | --- |
| `requested` | 准入记录已保存，尚未开始不可逆清理；执行前仍需核对权限 | 无冻结范围，计数为空 |
| `prepared` | 恢复依据和范围已冻结，进入不可逆清理边界 | `preparedAt`、两个冻结数组；计数为空 |
| `main_deleted` | 应用数据库删除已提交 | 在同一 APP 事务写入 `mainDeletedAt` 和 `bots / threads / tasks` 三个计数 |
| `workspace_deleted` | 工作区数据库删除已提交 | `workspaceDeletedAt`，再加入 `projects / teams / invitations / members` 四个计数 |
| `completed` | 两个库与现有清理回执的交接均已确认 | 七个计数、`completedAt`、有限的回执保留期限 |
| `cancelled` | 尚未准备的请求取消，不开始破坏性步骤 | `cancelledAt`，没有冻结范围和删除结果 |

`prepared` 之后不能取消、抹掉已完成阶段或重新借用旧 session 授权。恢复只完成原请求的
范围。CHECK 校验行的形状和时间顺序；它不验证跨库事实，也不替代后续执行器的物理
session lock、失锁检测、条件更新和单调阶段转换。请求身份、授权字段和已冻结范围在
执行器中不可修改。WS 提交成功但 APP 阶段回写前退出时，恢复必须重新核对同一目标的
提交事实并幂等补记。

**工作区持久写入屏障属于后续行为 PR。** 外层 WS 事务的行锁会在失败后释放，不能充当
跨重启屏障。没有实际屏障、已接入的执行器和双库故障验收，不能把本表或 `prepared`
字段宣称为已完成的可恢复删除。

`deletedCounts` 只接受上述七个键及非负整数 JSON 数字；缺少本阶段必需的键、JSON null、
字符串、负数、小数和额外字段均被拒绝。`main_deleted` 不能提前声称具有 WS 计数。
不持久化 `nextWorkspaceId`，后续状态读取仍按调用者的新鲜权限计算工作区选择。

## 调度与生命周期

同一工作区最多有一条未取消记录。完成记录在保留期内也占用这个幂等范围，避免重试
变成另一次删除。非终态有有限的 `nextAttemptAt`，没有 `retentionUntil`；due 索引只
包含非终态。后续执行器复用既有 `account-deletions` 通道、提交后唤醒和 reconcile，
不增加定时器或轮询。

终态回执只为原请求状态、结果和重复请求保留最小身份及七个计数。进入 `completed`
或 `cancelled` 必须清除 `nextAttemptAt`，写入有限的 `retentionUntil`；期限从终态
起算，最多 90 天。这是执行回执的上限，不改变审计的90天宽限或更长保留期。非终态不能过期，终态期限不能是
无穷值。独立 retention 索引为终态清理提供有界入口。

启用写入方的行为 PR 必须同时接入终态生命周期：到期后通过原有删除任务通道清除
该回执的身份、冻结 ID 和结果记录，不能无限保留；仍在处理的任务不得清除。必要的
审计证据继续由原审计账本及其保留/hold 规则负责，不能为了清 journal 修改审计策略。
这份扩展不主动删除任何记录，也不接入任务调度。

`lib/workspace-rows.ts` 的动态清理按 `workspaceId / workspace_id` 发现业务表，
`KEPT_WITH_WORKSPACE` 必须保留本表，否则 APP 清理会删掉自己的恢复依据。这个例外
同时保护工作区删除和复用同一清理器的账号删除；它不改变账号删除的授权和 guard。

## 发布与回滚

扩展迁移只创建表和索引，不修改旧表、历史 SQL、旧删除记录或已有触发器。目标是
`MIKKA_DATABASE_URL`；主库与工作区库分离时不要求跨库外键，同库测试也适用。

先发布并验证这一保留规则，再发布完整行为 PR。启用生产者之前，须核实所有可能调用
工作区清理的在役 API 与固定旧部署的删除任务都支持保留本表，按既有流程迁移或排空
旧执行者。产生任务后，回滚基线必须仍包含该保留规则；更老的清理器会把 journal
当成普通租户行删除，不能拿它作为安全回滚目标。代码回滚不撤销扩展迁移。

## 验证范围

`tests/workspace-admin.db.test.ts` 使用真实 PostgreSQL 检查约束、历史 tombstone 无回填，
并在真实 `deleteWorkspaceData` 路径中证明目标与其他工作区的 journal 均完整保留。
这些手工写入的 schema fixture 不代表生产入口已创建任务。

迁移还需通过空库完整重放及完整前版 schema 的升级验证。后续行为 PR 负责真实 action
准入、双库崩溃恢复、丢 wake、重复执行和失锁验收；既有
[审计投递与删除边界](audit-delivery-deletion.md) 继续适用。
