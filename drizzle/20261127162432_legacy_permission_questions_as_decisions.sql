-- Agents never ask a human for permission (ADR 2026-11-27-1615): an execution
-- question has no `permission` kind any more. A question stored with it reads
-- as an ordinary decision, in its column and in the handoff kept for replay
-- (the protocol parser already reads a stored run report's `permission` as
-- `decision`, so a replayed hand-in fingerprints the same as this row).
-- The check still admits `permission` so an older writer during the deploy
-- does not fail; nothing new writes it.
UPDATE factory_questions
SET kind = 'decision',
    request = CASE WHEN request #>> '{handoff,kind}' = 'permission'
      THEN jsonb_set(request, '{handoff,kind}', '"decision"') ELSE request END
WHERE kind = 'permission';
