-- Editor file writes (file_save/file_rename/file_delete) join the same
-- operation ledger as Git writes so every mutation shares one audit row,
-- one undo capture and one "latest write" chain per run/repository.
ALTER TABLE coding_workspace_git_operations
  DROP CONSTRAINT IF EXISTS coding_workspace_git_operations_kind_check,
  ADD CONSTRAINT coding_workspace_git_operations_kind_check
    CHECK (kind IN ('revert','restore','save','rename','delete'));
