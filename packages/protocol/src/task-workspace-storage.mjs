// Portable task workspaces use the same R2 archive format as DirectoryBackup.
// Each owner-controlled namespace contains immutable tar.zst objects and a
// separately committed manifest with the exact byte length and SHA-256.
export const TASK_WORKSPACE_PREFIX = 'task-workspaces/v1/'
export const TASK_WORKSPACE_SUFFIX = '.tar.zst'
