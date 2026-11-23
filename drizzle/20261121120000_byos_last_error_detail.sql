-- target: MIKKA_DATABASE_URL
-- The worker persists failure detail beside the code ("code (detail)"): the
-- check keeps its bounded code vocabulary and permits the detail suffix.
begin;
set local lock_timeout = '5s';

alter table byos_connections drop constraint if exists "byos_connections_lastErrorCode_check";
alter table byos_connections add constraint "byos_connections_lastErrorCode_check"
  check ("lastErrorCode" ~ '^(publication_failed|refresh_failed|publication_missing|integrity_failed|acquire_expired|projection_failed)( \([a-zA-Z0-9_.:-]{1,127}\))?$');

commit;
