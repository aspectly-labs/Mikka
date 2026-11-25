-- target: DATABASE_URL
-- Environments are the only container for repositories and run settings (public decision
-- 2026-11-26-0110 rules 1-5; Alex, 2026-11-25: personal 「仅我」 environments shared to the workspace).
-- Expand only: the Project -> repository -> environment tables stay readable for one release and are
-- no longer written. Rollback: revert application code; these columns and rows are additive.

-- 1. Scope. 'workspace' is every existing environment. A 'personal' one has an owner and is visible to,
--    and usable by, that owner only; sharing turns it into 'workspace' and keeps the owner.
ALTER TABLE workspace_environments ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace';
ALTER TABLE workspace_environments ADD COLUMN IF NOT EXISTS "ownerId" text;
DO $$ BEGIN
  ALTER TABLE workspace_environments ADD CONSTRAINT workspace_environments_scope_check
    CHECK (scope IN ('personal','workspace') AND (scope='workspace' OR "ownerId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS workspace_environments_owner_idx ON workspace_environments("workspaceId","ownerId") WHERE "ownerId" IS NOT NULL;

-- 2. Repository rows. configuration.repositoryKeys keeps meaning "cloned when the machine starts" for
--    every older reader; this column also carries on-demand rows, each row's base branch and the
--    environment's one 主仓库. It lives beside the strict configuration object so an older writer
--    or a rolled-back reader never meets an unknown configuration key.
ALTER TABLE workspace_environments ADD COLUMN IF NOT EXISTS repositories jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  ALTER TABLE workspace_environments ADD CONSTRAINT workspace_environments_repositories_array
    CHECK (jsonb_typeof(repositories)='array' AND jsonb_array_length(repositories)<=100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. A task's 「环境」 property replaces its Project's default environment.
CREATE TABLE IF NOT EXISTS workspace_task_environments (
  "issueId" uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "environmentId" uuid NOT NULL,
  -- NULL: set by this migration from the task's Project.
  "updatedBy" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("environmentId","workspaceId") REFERENCES workspace_environments(id,"workspaceId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS workspace_task_environments_environment_idx ON workspace_task_environments("workspaceId","environmentId");

-- 4. Backfill where unambiguous: the Project's default environment, else its only bound environment.
WITH bound AS (
  SELECT b."projectId", b."workspaceId", b."environmentId", b."isDefault" FROM workspace_project_environments b
  UNION ALL
  SELECT r."projectId", r."workspaceId", r."environmentId", false FROM workspace_project_repositories r WHERE r."environmentId" IS NOT NULL
), chosen AS (
  SELECT "projectId", "workspaceId",
    coalesce(min("environmentId"::text) FILTER (WHERE "isDefault"),
      CASE WHEN count(DISTINCT "environmentId")=1 THEN min("environmentId"::text) END)::uuid AS "environmentId"
  FROM bound GROUP BY "projectId", "workspaceId"
)
INSERT INTO workspace_task_environments("issueId","workspaceId","environmentId","updatedBy")
SELECT t."issueId", t."workspaceId", c."environmentId", NULL
FROM workspace_project_tasks t
JOIN chosen c ON c."projectId"=t."projectId" AND c."workspaceId"=t."workspaceId"
WHERE c."environmentId" IS NOT NULL
ON CONFLICT ("issueId") DO NOTHING;

-- 5. Move each Project repository's base branch and 主仓库 mark onto the environment it selected.
--    A branch is kept only when every binding of that environment and repository agrees; a primary
--    only when exactly one repository of the environment was primary. Start rows follow
--    repositoryKeys in order. An environment that listed no repositories admitted any, so its bound
--    repositories become on-demand rows. Revisions are unchanged: no run setting changes.
WITH defaults AS (
  SELECT "projectId","workspaceId","environmentId" FROM workspace_project_environments WHERE "isDefault"
), selected AS (
  SELECT r."workspaceId", coalesce(r."environmentId", d."environmentId") AS "environmentId",
    r."repositoryKey", r."baseBranch", r."isPrimary"
  FROM workspace_project_repositories r
  LEFT JOIN defaults d ON d."projectId"=r."projectId" AND d."workspaceId"=r."workspaceId"
), per_key AS (
  SELECT "workspaceId","environmentId","repositoryKey",
    CASE WHEN count(DISTINCT coalesce("baseBranch",''))=1 THEN min("baseBranch") END AS "baseBranch",
    bool_or("isPrimary") AS "isPrimary"
  FROM selected WHERE "environmentId" IS NOT NULL GROUP BY 1,2,3
), envs AS (
  SELECT e.id, e."workspaceId",
    CASE WHEN jsonb_typeof(e.configuration->'repositoryKeys')='array' THEN e.configuration->'repositoryKeys' ELSE '[]'::jsonb END AS keys
  FROM workspace_environments e WHERE e.repositories='[]'::jsonb
), rows AS (
  SELECT e.id, k.ord AS ord, k.key, 'start' AS clone, pk."baseBranch", coalesce(pk."isPrimary",false) AS "isPrimary"
  FROM envs e CROSS JOIN LATERAL jsonb_array_elements_text(e.keys) WITH ORDINALITY AS k(key, ord)
  LEFT JOIN per_key pk ON pk."environmentId"=e.id AND pk."workspaceId"=e."workspaceId" AND pk."repositoryKey"=k.key
  UNION ALL
  SELECT e.id, 1000 + row_number() OVER (PARTITION BY e.id ORDER BY pk."repositoryKey") AS ord, pk."repositoryKey", 'demand', pk."baseBranch", pk."isPrimary"
  FROM envs e JOIN per_key pk ON pk."environmentId"=e.id AND pk."workspaceId"=e."workspaceId"
  WHERE jsonb_array_length(e.keys)=0
), primaries AS (
  SELECT id, count(*) FILTER (WHERE "isPrimary") AS n FROM rows GROUP BY id
), built AS (
  SELECT r.id, jsonb_agg(jsonb_build_object('key', r.key, 'clone', r.clone, 'baseBranch', r."baseBranch",
    'primary', r."isPrimary" AND p.n=1) ORDER BY r.ord) AS repositories
  FROM rows r JOIN primaries p ON p.id=r.id GROUP BY r.id HAVING count(*)<=100
)
UPDATE workspace_environments w SET repositories=built.repositories
FROM built WHERE w.id=built.id AND w.repositories='[]'::jsonb;
