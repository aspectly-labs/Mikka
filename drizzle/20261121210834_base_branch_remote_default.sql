-- target: MIKKA_DATABASE_URL

-- #838: a null baseBranch means "follow the remote's default branch" (origin/HEAD);
-- the daemon resolves it at run time. The 'main' values below were written by the
-- old schema default and the bot-runtime INSERT, not by a user setting one —
-- no code path ever wrote a user-chosen baseBranch.
UPDATE device_repos SET "baseBranch" = NULL WHERE "baseBranch" = 'main';
ALTER TABLE device_repos ALTER COLUMN "baseBranch" DROP DEFAULT;
ALTER TABLE agent_runs ALTER COLUMN "baseBranch" DROP DEFAULT;
