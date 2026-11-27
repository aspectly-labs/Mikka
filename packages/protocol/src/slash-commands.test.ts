import { describe, expect, it } from 'vitest'
import {
  CLAUDE_DANGEROUS_PASSTHROUGH_COMMANDS,
  CLAUDE_HOST_OWNED_COMMANDS,
  CODEX_CURATED_COMMANDS,
  EVE_AVAILABLE_COMMANDS,
  availableCommandSchema,
  groupAvailableCommands,
  isBlockedClaudeCommand,
  mergeAvailableCommands,
  mikkaHostCommands,
  normalizeClaudeCommands,
  normalizeCodexCommands,
  normalizeEveCommands,
  parseLeadingSlashCommand,
  rankAvailableCommands,
  resolveSkillMentionsForHarness,
  structuredMentionsSchema,
  systemEventDataSchema,
} from './slash-commands'
import { runCommandSchema } from './device'

describe('slash-commands protocol contract', () => {
  it('parses leading slash commands without misclassifying unix file paths', () => {
    expect(parseLeadingSlashCommand('/compact focus on auth')).toEqual({
      name: 'compact',
      args: 'focus on auth',
    })
    expect(parseLeadingSlashCommand('  /mcp:github:pr-review #42')).toEqual({
      name: 'mcp:github:pr-review',
      args: '#42',
    })
    expect(parseLeadingSlashCommand('/login')).toEqual({ name: 'login', args: '' })
    expect(parseLeadingSlashCommand('/usr/local/bin/node --version')).toBeNull()
    expect(parseLeadingSlashCommand('hello /compact')).toBeNull()
  })

  it('blocks every dangerous pass-through command and terminal_slash_commands entry', () => {
    for (const cmd of CLAUDE_DANGEROUS_PASSTHROUGH_COMMANDS) {
      expect(isBlockedClaudeCommand(cmd)).toMatchObject({ blocked: true, reason: 'dangerous_passthrough' })
      expect(isBlockedClaudeCommand(`/${cmd.toUpperCase()}`)).toMatchObject({ blocked: true, reason: 'dangerous_passthrough' })
    }
    for (const cmd of CLAUDE_HOST_OWNED_COMMANDS) {
      expect(isBlockedClaudeCommand(cmd).blocked).toBe(true)
    }
    expect(isBlockedClaudeCommand('vim-custom', ['vim-custom'])).toEqual({
      blocked: true,
      reason: 'terminal_only',
      canonical: 'vim-custom',
    })
    expect(isBlockedClaudeCommand('compact')).toEqual({ blocked: false })
    expect(isBlockedClaudeCommand('pr-review')).toEqual({ blocked: false })
  })

  it('normalizes Claude Code init + supportedCommands, strips terminal/host-owned, and classifies MCP & skills', () => {
    const commands = normalizeClaudeCommands({
      initSlashCommands: ['compact', 'login', 'model', 'review', 'terminal-only', 'my-skill', 'mcp__github__summarize'],
      terminalSlashCommands: ['terminal-only', 'vim'],
      initSkills: ['my-skill', 'extra-skill'],
      supportedCommands: [
        { name: 'review', description: 'Review diff', argumentHint: '[files]' },
        { name: 'linear:triage', description: 'Triage issues (MCP)', argumentHint: '<team>' },
        { name: 'config', description: 'Open config' },
      ],
    })

    const names = commands.map(c => c.name)
    expect(names).not.toContain('login')
    expect(names).not.toContain('model')
    expect(names).not.toContain('config')
    expect(names).not.toContain('terminal-only')

    expect(commands.find(c => c.name === 'compact')).toMatchObject({
      name: 'compact',
      input: { hint: '[instructions]' },
      _meta: { source: 'claude-code' },
    })
    expect(commands.find(c => c.name === 'review')).toMatchObject({
      name: 'review',
      description: 'Review diff',
      input: { hint: '[files]' },
      _meta: { source: 'claude-code' },
    })
    expect(commands.find(c => c.name === 'mcp:github:summarize')).toMatchObject({
      _meta: { source: 'mcp', server: 'github' },
    })
    expect(commands.find(c => c.name === 'mcp:linear:triage')).toMatchObject({
      description: 'Triage issues',
      input: { hint: '<team>' },
      _meta: { source: 'mcp', server: 'linear' },
    })
    expect(commands.find(c => c.name === 'my-skill')).toMatchObject({ _meta: { source: 'skill' } })
    expect(commands.find(c => c.name === 'extra-skill')).toMatchObject({ _meta: { source: 'skill' } })
    for (const cmd of commands) {
      expect(availableCommandSchema.safeParse(cmd).success).toBe(true)
    }
  })

  it('normalizes Codex curated commands + skills and Eve commands', () => {
    const codex = normalizeCodexCommands([{ name: 'deploy-check', description: 'Verify rollout' }])
    expect(codex.map(c => c.name)).toEqual([...CODEX_CURATED_COMMANDS.map(c => c.name), 'deploy-check'])
    expect(codex.find(c => c.name === 'deploy-check')).toMatchObject({ _meta: { source: 'skill' } })

    const eve = normalizeEveCommands([{ name: 'daily-brief', description: 'Summarize inbox' }])
    expect(eve.map(c => c.name)).toEqual([...EVE_AVAILABLE_COMMANDS.map(c => c.name), 'daily-brief'])
  })

  it('merges host and runtime commands with host winning duplicates, ranks matches, and groups into 4 sections', () => {
    const host = mikkaHostCommands({ threadSurface: 'coding', hasTask: true })
    const runtime = [
      { name: 'model', description: 'CLI model', _meta: { source: 'claude-code' as const } },
      { name: 'effort', description: 'CLI effort', _meta: { source: 'claude-code' as const } },
      { name: 'compact', description: 'Compact context', _meta: { source: 'claude-code' as const } },
      { name: 'audit-ui', description: 'Run UI audit', _meta: { source: 'skill' as const } },
      { name: 'mcp:github:pr', description: 'Review PR', _meta: { source: 'mcp' as const, server: 'github' } },
    ]
    const merged = mergeAvailableCommands(host, runtime)
    expect(merged.find(c => c.name === 'model')?._meta.source).toBe('mikka')
    expect(merged.find(c => c.name === 'effort')).toBeUndefined()
    expect(merged.find(c => c.name === 'compact')?._meta.source).toBe('claude-code')

    const grouped = groupAvailableCommands(merged)
    expect(grouped.map(g => g.section)).toEqual(['mikka', 'harness', 'skill', 'mcp'])

    const ranked = rankAvailableCommands(merged, 'btw')
    expect(ranked[0]?.name).toBe('side')
    const rankedCompact = rankAvailableCommands(merged, 'comp')
    expect(rankedCompact[0]?.name).toBe('compact')
  })

  it('resolves $skill mentions per harness without corrupting shell vars', () => {
    const text = 'Check $HOME and run $security-review on auth'
    expect(resolveSkillMentionsForHarness('codex', text, ['security-review'])).toEqual({
      text,
      skills: ['security-review'],
    })
    const claude = resolveSkillMentionsForHarness('claude_code', text, ['security-review'])
    expect(claude.skills).toEqual(['security-review'])
    expect(claude.text).toContain('$HOME')
    expect(claude.text).toContain('/security-review')
    expect(claude.text).toContain('Skill tool')

    const eve = resolveSkillMentionsForHarness('eve', text, ['security-review'])
    expect(eve.skills).toEqual(['security-review'])
    expect(eve.text).toContain('load_skill')
    expect(eve.text).toContain('security-review')
  })

  it('validates structured mentions, system events, and compact/clientComposed run commands', () => {
    expect(
      structuredMentionsSchema.safeParse([
        { kind: 'slack_channel', id: 'C123', label: '#eng', start: 0, end: 4 },
        { kind: 'device', id: 'dev-1', start: 5, end: 12 },
        { kind: 'subagent', id: 'run-2', start: 13, end: 22 },
        { kind: 'plugin', id: 'plg-1', start: 23, end: 30 },
      ]).success,
    ).toBe(true)

    expect(
      systemEventDataSchema.safeParse({
        kind: 'command_blocked',
        command: 'login',
        originalText: '/login',
        validCommands: ['compact', 'review'],
        reason: 'dangerous_passthrough',
      }).success,
    ).toBe(true)

    expect(
      runCommandSchema.safeParse({
        kind: 'compact',
        runId: 'run-1',
        messageId: '00000000-0000-4000-8000-000000000001',
        instructions: 'keep failing tests',
      }).success,
    ).toBe(true)

    expect(
      runCommandSchema.safeParse({
        kind: 'input',
        runId: 'run-1',
        messageId: '00000000-0000-4000-8000-000000000002',
        text: '/login',
        clientComposed: true,
      }).success,
    ).toBe(true)
  })
})
