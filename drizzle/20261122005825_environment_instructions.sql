-- target: DATABASE_URL

-- Standing working instructions for runs and Bots bound to this Environment (WS-F, #3110).
-- Rollback: revert application code and retain this additive column and its data.
ALTER TABLE workspace_environments
  ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT ''
  CHECK (char_length(instructions) <= 2000);
