-- migrate: reviewed-data #3388 removes the executable mutation from closed browser_operation rows (masked summary and digest kept); no other rows change
-- target: MIKKA_DATABASE_URL

-- No permission approvals (docs/design/decisions/2026-11-27-1615-no-permission-approvals.md).
--
-- drizzle/20261127162323_retire_write_approvals.sql closed every waiting
-- proposal, browser actions included, as 'declined'. A closed browser action
-- keeps only its masked summary and digest (lib/cloud-computer/action-reviews.ts
-- scrubBrowserMutation). This removes the executable mutation from every closed
-- browser_operation row still holding one, as sweepBrowserMutations does,
-- instead of waiting for the owner's next browser action. A running row keeps
-- it: it may still execute. Row locks only; no table lock.
--
-- Idempotent: a second run matches no rows.
SET LOCAL lock_timeout = '5s';

UPDATE pending_actions SET input = (input - 'mutation') || '{"mutationScrubbed":true}'::jsonb
WHERE action = 'browser_operation' AND input ? 'mutation' AND status IN ('done', 'declined', 'failed');
