// A tool call's name as every row shows it (Alex, 2026-11-22): English, in title form, whatever the UI language, as
// Claude Code, Codex and Cursor name their tools. Never the raw identifier with its underscores. Pure, so the Bot chat,
// Agent threads and tests name a tool the same way.
import { readableToolName } from '@/lib/coordinator/tool-metadata'

/** Coding-agent tools (Claude Code, Codex, Cursor, Gemini CLI), matched without case, by what they do. */
const TITLES: Record<string, string> = {
  read: 'Read file', read_file: 'Read file', view: 'Read file', cat: 'Read file', notebookread: 'Read notebook', read_many_files: 'Read files',
  bash: 'Run command', shell: 'Run command', execute: 'Run command', exec_command: 'Run command', local_shell: 'Run command', run_shell_command: 'Run command',
  write_stdin: 'Write to terminal', bashoutput: 'Read command output', killshell: 'Stop command', killbash: 'Stop command',
  grep: 'Search', search: 'Search', search_file_content: 'Search', codebase_search: 'Search', grep_search: 'Search',
  glob: 'Find files', find: 'Find files', file_search: 'Find files', ls: 'List files', list_dir: 'List files', list_directory: 'List files',
  edit: 'Edit file', multiedit: 'Edit file', edit_file: 'Edit file', str_replace: 'Edit file', replace: 'Edit file', search_replace: 'Edit file', apply_patch: 'Edit file',
  write: 'Write file', write_file: 'Write file', create_file: 'Write file', notebookedit: 'Edit notebook', delete: 'Delete file', delete_file: 'Delete file', move: 'Move file',
  webfetch: 'Fetch web page', web_fetch: 'Fetch web page', fetch: 'Fetch web page', websearch: 'Web search', web_search: 'Web search', google_web_search: 'Web search',
  task: 'Start subagent', agent: 'Start subagent', spawn_agent: 'Start subagent',
  todowrite: 'Update todos', todoread: 'Read todos', update_plan: 'Update plan', taskcreate: 'Create todo', taskupdate: 'Update todo',
  exitplanmode: 'Finish plan', save_memory: 'Save memory', view_image: 'View image',
}

/**
 * The title a tool call's row shows: a coding agent's known tool by what it does, else the title the tool declared (an
 * MCP tool's `title`, `annotations.title`, or Mikka's own display name), else its own name spelled out: an MCP tool
 * without its `mcp__server__` prefix, with spaces for underscores and the first word capitalised.
 */
export function toolTitle(name: string, declared?: string | null): string {
  const known = TITLES[name.toLowerCase()]
  if (known) return known
  const title = declared?.trim()
  if (title && !/_/.test(title)) return title
  const bare = name.replace(/^mcp__.+?__/, '').replace(/^mcp__/, '')
  return readableToolName(bare || name)
}
