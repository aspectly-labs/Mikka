-- migrate: reviewed-data #3323 Retire queue-producing triggers and preserve local detachment and membership handling.
DROP TRIGGER IF EXISTS linear_issue_sync_outbox ON issues;
DROP TRIGGER IF EXISTS linear_document_sync_outbox ON issue_documents;
DROP FUNCTION IF EXISTS enqueue_linear_issue_sync();

-- Preserve local detachment history and membership fences.
create or replace function detach_personal_issue() returns trigger
language plpgsql as $$
begin
  if (new.scope='personal' and old.scope is distinct from new.scope)
    or (new."linearSyncPolicy"='disabled' and old."linearSyncPolicy"='explicit') then
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier","sourceLinkId","publicationId","externalTargetVerified")
      select "linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier",id,"publicationId","externalTargetVerified"
      from linear_issue_links where "issueId"=new.id
      on conflict ("linearIssueId") do nothing;
    -- Includes a create whose HTTP response has not returned and has no link yet.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","publicationId")
      select "linearIssueId","issueId","ownerId","teamSyncId",id from linear_issue_publications
      where "issueId"=new.id and "retiredAt" is null
      on conflict ("linearIssueId") do update set "publicationId"=coalesce(linear_issue_detachments."publicationId",excluded."publicationId");
    -- Fence the legacy app-UUID identity even if an older create has no response
    -- or reservation. A guard-only row is not proof of a remote issue to archive.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId")
      values(new.id::text,new.id,new."userId") on conflict ("linearIssueId") do nothing;
    update linear_issue_publications set "retiredAt"=now() where "issueId"=new.id and "retiredAt" is null;
    delete from linear_issue_links where "issueId"=new.id;
    update linear_sync_outbox set status='done',"claimToken"=null,"lastError"=null,"updatedAt"=now()
      where "issueId"=new.id and operation='sync' and status in ('queued','processing','failed');
    -- Publication settings cannot revoke collaboration in a bound tenant.
    if new."workspaceId" is null then
      update run_tokens set "revokedAt"=now() where "revokedAt" is null and "runId" in
        (select id from agent_runs where "issueId"=new.id and "userId"<>new."userId");
      update agent_runs set status='cancelled',"stopRequestedAt"=now(),"finishedAt"=now(),"leaseExpiresAt"=null,
        "stopReason"='Task became personal',"updatedAt"=now()
        where "issueId"=new.id and "userId"<>new."userId" and status in ('queued','preparing','running','waiting_input','finishing');
    end if;
  end if;
  return new;
end;
$$;
