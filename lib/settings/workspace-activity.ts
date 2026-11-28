import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { readGovernanceLease } from '@/lib/governance/lease'
import { GovernanceError } from '@/lib/governance/errors'
import { usageRange } from '@/lib/governance/usage'
import { isRunChainRootSql } from '@/lib/run-chain'
import { countWorkspaceMergedPulls } from '@/lib/github/user-access'
import type { EnterpriseReader } from '@/lib/enterprise/principal'
import { threadCostsPending, type WorkspaceContributionDay, type WorkspaceSettingsActivity } from './device-activity-contract'

/** Workspace activity is an administrator's aggregate, with task content ACLs
 * still applied. Thread content, task titles and private PR URLs never leave it. */
function issueMetadata(alias: 'i' | 'v') {
  return `coalesce(${alias}.content->'attrs'->'mikka',${alias}.content->'attrs'->'orvilo','{}'::jsonb)`
}

export async function readWorkspaceSettingsActivity(reader: EnterpriseReader, workspaceId: string,
  range: { from?: string | null; to?: string | null }, groupBy: string | null = null): Promise<WorkspaceSettingsActivity> {
  z.uuid().parse(workspaceId)
  if (groupBy && groupBy !== 'member') throw new GovernanceError('invalid_request')
  const { from, to } = usageRange(range)
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()))
  const { rows, keys, counts } = await withTaskWorkspace(reader, workspaceId, async () => {
    const scope = await readGovernanceLease(workspacePool, workspaceId, reader.id)
    if (scope.role !== 'admin') throw new GovernanceError('access_denied')
    const { rows: members } = await workspacePool.query<{ userId: string }>(`SELECT "userId" FROM mikka_workspace_members
      WHERE "workspaceId"=$1 AND status='active' ORDER BY "userId"`, [workspaceId])
    const { rows: configured } = await workspacePool.query<{ key: string }>(`WITH environments AS (
      SELECT e.configuration,to_jsonb(e)->'repositories' AS repositories FROM workspace_environments e WHERE e."workspaceId"=$1
      AND e."archivedAt" IS NULL AND (coalesce(to_jsonb(e)->>'scope','workspace')='workspace' OR to_jsonb(e)->>'ownerId'=$2)
    ) SELECT DISTINCT key FROM (
      SELECT jsonb_array_elements_text(configuration->'repositoryKeys') AS key FROM environments
      UNION ALL SELECT jsonb_array_elements(repositories)->>'key' FROM environments
      UNION ALL SELECT "repositoryKey" FROM workspace_project_repositories WHERE "workspaceId"=$1
      UNION ALL SELECT jsonb_array_elements_text("repositoryKeys") FROM workspace_repository_policies WHERE "workspaceId"=$1
    ) keys WHERE key IS NOT NULL`, [workspaceId, reader.id])
    const { rows } = await pool.query<WorkspaceContributionDay>(`WITH
      visible_tasks AS (
        SELECT i.id,i."userId" FROM issues i WHERE i."workspaceId"=$1 AND i."ownershipState"='bound'
          AND ${issueMetadata('i')}->>'deletedAt' IS NULL
          AND mikka_resource_acl_allowed('account',$5,i."workspaceId",'task',i.id,'canReadContent')
      ), versions AS (
        SELECT v."issueId",v."userId",v.revision,v.status,v."createdAt" AS at,v.actor_type,v.actor_id,metadata,
          lag(v.status) OVER w AS previous_status,lag(v.revision) OVER w AS previous_revision,
          pulls,lag(pulls) OVER w AS previous_pulls
        FROM issue_versions v JOIN visible_tasks i ON i.id=v."issueId" AND i."userId"=v."userId"
        CROSS JOIN LATERAL (SELECT ${issueMetadata('v')} AS metadata) m
        CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(metadata->'pullRequests')='array'
          THEN metadata->'pullRequests' ELSE '[]'::jsonb END AS pulls) p
        WINDOW w AS (PARTITION BY v."issueId" ORDER BY v.revision,v.id)
      ), credited AS (
        SELECT *,coalesce(CASE WHEN metadata->'assignee'->>'kind'='member' THEN metadata->'assignee'->>'id' END,
          CASE WHEN actor_type='user' THEN actor_id END,"userId") AS member
        FROM versions WHERE previous_revision=revision-1
      ), completion_events AS (
        SELECT DISTINCT ON ("issueId",date_trunc('day',at AT TIME ZONE 'UTC'))
          "issueId",date_trunc('day',at AT TIME ZONE 'UTC') AS day,member
        FROM credited WHERE status='done' AND previous_status<>'done' AND at>=$3 AND at<$4
          AND member=ANY($2::text[])
        ORDER BY "issueId",date_trunc('day',at AT TIME ZONE 'UTC'),at,revision
      ), pull_events AS (
        SELECT DISTINCT ON (rtrim(pull->>'url','/')) rtrim(pull->>'url','/') AS url,c.at,c.member
        FROM credited c CROSS JOIN LATERAL jsonb_array_elements(c.pulls) pull
        WHERE pull->>'state'='merged' AND nullif(pull->>'url','') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.previous_pulls) previous
            WHERE rtrim(previous->>'url','/')=rtrim(pull->>'url','/') AND previous->>'state'='merged')
        ORDER BY rtrim(pull->>'url','/'),c.at,c."issueId"
      ), events AS (
        SELECT to_char(day,'YYYY-MM-DD') AS day,member,1 AS tasks,0 AS pulls,0 AS threads FROM completion_events
        UNION ALL
        SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD'),member,0,1,0 FROM pull_events WHERE at>=$3 AND at<$4
        UNION ALL
        SELECT to_char(r."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD'),r."userId",0,0,1
        FROM agent_runs r
        WHERE r."workspaceId"=$1 AND r."userId"=ANY($2::text[])
          AND r.kind<>'group_chat' AND r."createdAt">=$3 AND r."createdAt"<$4 AND ${isRunChainRootSql('r')}
          AND (r."issueId" IS NULL OR r."issueId" IN (SELECT id FROM visible_tasks))
      )
      SELECT day,member AS "memberId",sum(tasks)::int AS "completedTasks",sum(pulls)::int AS "mergedPullRequests",sum(threads)::int AS threads
      FROM events WHERE member=ANY($2::text[]) GROUP BY day,member ORDER BY day,member`,
    [workspaceId, members.map(member => member.userId), previousFrom, to, reader.id])
    const { rows: published } = await pool.query<{ key: string }>(`SELECT DISTINCT p."remoteKey" AS key FROM run_publications p
      JOIN issues i ON i.id=p."issueId" JOIN agent_runs r ON r.id=p."runId" AND r."workspaceId"=i."workspaceId"
      WHERE i."workspaceId"=$1 AND i."ownershipState"='bound' AND p."pullRequest" IS NOT NULL
      AND mikka_resource_acl_allowed('account',$2,i."workspaceId",'task',i.id,'canReadContent')`, [workspaceId, reader.id])
    const { rows: [counts] } = await pool.query<{ current: number; previous: number }>(`WITH visible AS (
      SELECT DISTINCT ON (lower(p."pullRequest"->>'url')) lower(p."pullRequest"->>'url') AS url,p."issueId",
        p."pullRequest"->>'mergedAt' AS merged_at FROM run_publications p JOIN issues i ON i.id=p."issueId"
      JOIN agent_runs r ON r.id=p."runId" AND r."workspaceId"=i."workspaceId"
      WHERE i."workspaceId"=$1 AND i."ownershipState"='bound' AND p."pullRequest"->>'state'='merged'
        AND mikka_resource_acl_allowed('account',$2,i."workspaceId",'task',i.id,'canReadContent')
      ORDER BY lower(p."pullRequest"->>'url'),p."pullRequest"->>'mergedAt' NULLS LAST,p."createdAt"
    ), merges AS (
      SELECT coalesce(merged_at::timestamptz,(SELECT min(v."createdAt") FROM issue_versions v
        WHERE v."issueId"=visible."issueId" AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${issueMetadata('v')}->'pullRequests')='array'
            THEN ${issueMetadata('v')}->'pullRequests' ELSE '[]'::jsonb END) pr
          WHERE lower(rtrim(pr->>'url','/'))=visible.url AND pr->>'state'='merged'))) AS at FROM visible
    ) SELECT count(*) FILTER(WHERE at>=$3 AND at<$4)::int AS current,
      count(*) FILTER(WHERE at>=$5 AND at<$3)::int AS previous FROM merges`, [workspaceId, reader.id, from, to, previousFrom])
    return { rows, counts, keys: [...new Set([...published, ...configured].map(row => row.key))] }
  })
  const start = from.toISOString().slice(0, 10)
  const contributions = rows.filter(row => row.day >= start)
  const merged = await countWorkspaceMergedPulls(reader.id, keys, from, to, previousFrom)
  const previous = { mergedPullRequests: counts.previous,
      mergedPullRequestsAll: merged.previous }
  return { workspaceId, from: from.toISOString(), toExclusive: to.toISOString(), timeZone: 'UTC', groupBy: 'member',
      dateSource: 'recorded_events', contributions, mergedPullRequests: counts.current, mergedPullRequestsAll: merged.current, previous, threadCosts: threadCostsPending }
}
