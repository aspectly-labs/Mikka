import { createHash } from 'node:crypto'
import { skillMarkdown } from '@mikka/protocol/skill'
import { pluginActor } from '@/lib/plugins/actor'
import { createSkillSchema, deletePluginSchema, PluginError, updateSkillSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { fetchSkillSource } from '@/lib/plugins/skill-source'
import { defineRoute } from '@/lib/primitives/define-route'

async function handleGET(request: Request) {
  return pluginResponse(async () => {
    const userId = await pluginActor(request)
    const ids = new URL(request.url).searchParams.getAll('id')
    if (ids.length) {
      const input = deletePluginSchema.safeParse({ id: ids[0] })
      if (ids.length !== 1 || !input.success) throw new PluginError('invalidPluginInput', 400)
      return { skill: await personalPlugins.getSkill(userId, input.data.id) }
    }
    const skills = await personalPlugins.listSkills(userId)
    return { skills, count: skills.length, scope: 'personal' }
  })
}

async function handlePOST(request: Request) {
  return pluginResponse(async () => {
    const userId = await pluginActor(request)
    const input = await pluginBody(request, createSkillSchema)
    if ('source' in input) {
      const existing = (await personalPlugins.listSkills(userId)).find(skill => skill.source.toLowerCase() === input.source.toLowerCase() && skill.slug === input.slug)
      return { skill: existing ?? await personalPlugins.installSkill(userId, await fetchSkillSource(input)) }
    }
    const body = skillMarkdown({ name: input.name, instructions: input.instructions })
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    return {
      skill: await personalPlugins.installSkill(userId, {
        name: input.name,
        source: 'local/manual',
        slug: input.slug,
        sourceKind: 'self-improvement',
        sourceRevision: sha256,
        sourcePath: 'SKILL.md',
        body,
        sha256,
      }),
    }
  }, 201)
}

async function handlePATCH(request: Request) {
  return pluginResponse(async () => {
    const userId = await pluginActor(request), input = await pluginBody(request, updateSkillSchema)
    if (input.name === undefined && input.instructions === undefined && input.enabled !== undefined) {
      return { skill: await personalPlugins.updateSkill(userId, input.id, input.enabled) }
    }
    return { skill: await personalPlugins.editSkill(userId, input.id, input) }
  })
}

async function handleDELETE(request: Request) {
  return pluginResponse(async () => {
    const userId = await pluginActor(request)
    await personalPlugins.deleteSkill(userId, (await pluginBody(request, deletePluginSchema)).id)
    return { deleted: true }
  })
}

export const GET = defineRoute<'session', 'none'>(
  { route: '/api/skills', auth: 'session', origin: 'any', workspace: 'none' },
  async ({ request }) => handleGET(request),
)

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/skills', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => handlePOST(request),
)

export const PATCH = defineRoute<'session', 'none'>(
  { route: '/api/skills', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => handlePATCH(request),
)

export const DELETE = defineRoute<'session', 'none'>(
  { route: '/api/skills', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => handleDELETE(request),
)
