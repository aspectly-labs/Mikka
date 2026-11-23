-- #2941: thread-scoped env vars reuse workspace_secrets with scopeType 'thread'.
alter table workspace_secrets drop constraint if exists "workspace_secrets_scopeType_check";
alter table workspace_secrets add constraint "workspace_secrets_scopeType_check"
  check ("scopeType" in ('workspace', 'repository', 'thread'));
alter table workspace_secrets drop constraint if exists workspace_secrets_scope_ref;
alter table workspace_secrets add constraint workspace_secrets_scope_ref check (
  ("scopeType" = 'workspace' and "scopeRef" = '') or
  -- owner/repo, stored lowercase; '.' and '..' are not segments.
  ("scopeType" = 'repository' and "scopeRef" ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    and "scopeRef" !~ '(^|/)\.{1,2}(/|$)') or
  ("scopeType" = 'thread' and "scopeRef" <> ''));
