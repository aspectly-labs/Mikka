import { z } from 'zod'
import { json } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { pool } from '@/lib/db'
import { ExecutionSettings } from '@/lib/execution-settings'
import { botModelMenu, botModelScope, chooseBotModel, refreshBotModelMenu, setChatModelSettings, setPreferredRoute } from '@/lib/bot-model-menu'
import { chatModelOptionsSchema } from '@/lib/model-picker-options'
import { ModelRouteUnavailable } from '@/lib/model-route-rejection'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


const botParam = z.uuid().nullable()
// An option id as the menu lists it: a binding uuid, `credits:<vendor/model>` (Mikka 额度), or `apikey:<keyId>:<model>` (lib/bot-model-menu-view.ts).
const choice = z.strictObject({ bot: botParam, id: z.string().min(1).max(300) })
const temporaryChoice = z.strictObject({ bot: z.uuid(), id: z.uuid(), mode: z.literal('temporary-if-absent') })
const restoreChoice = z.strictObject({ bot: z.uuid(), mode: z.literal('restore-implicit'), bindingId: z.uuid(), revision: z.string().regex(/^[0-9]{1,10}$/) })
const optionsChoice = z.strictObject({ bot: botParam, options: chatModelOptionsSchema })
const routeChoice = z.strictObject({ bot: botParam, modelKey: z.string().min(1).max(512), optionId: choice.shape.id })
const putChoice = z.union([choice, temporaryChoice, restoreChoice, optionsChoice, routeChoice])

function failed(error: unknown) {
  if (error instanceof ActionFailureError && (error.code === 'botNotFound' || error.code === 'workspaceAccessDenied')) return json({ error: 'botNotFound' }, 404)
  // A binding held by another account answers the same as a missing one: the
  // response never discloses whether the id exists under someone else (#3057).
  if (error instanceof ActionFailureError && error.code === 'validationGeneric') return json({ error: 'invalidModel' }, 400)
  if (error instanceof ModelRouteUnavailable) return json({ error: 'modelUnavailable', health: error.health }, 409)
  if (error instanceof SubscriptionRefusal) return json({ error: 'modelUnavailable' }, 409)
  if (error instanceof ActionFailureError && error.code === 'executionModelUnknown') return json({ error: 'modelUnavailable' }, 409)
  throw error
}

/** `GET /api/mobile/model?bot=<id>`: the composer's model menu for a bot, or the Coordinator (no `bot`). */
async function handleGET(request: Request, user: ApiSession['user']) {
  const bot = botParam.safeParse(new URL(request.url).searchParams.get('bot'))
  if (!bot.success) return json({ error: 'invalidBot' }, 400)
  try {
    const botId = await openChatBotId(user, bot.data)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    if (new URL(request.url).searchParams.get('choiceState') === '1')
      return json(await botModelMenu(pool, new ExecutionSettings(pool), scope, botId, Date.now(), true))
    return json(await botModelMenu(pool, new ExecutionSettings(pool), scope, botId))
  } catch (error) { return failed(error) }
}

/**
 * `PUT /api/mobile/model` with `{ bot, id }`: saves the pick for the bot's next
 * runs and returns the menu. 409 `modelUnavailable` when the credential is not
 * usable here any more.
 */
async function handlePUT(request: Request, user: ApiSession['user']) {
  const body = putChoice.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidModel' }, 400)
  try {
    const botId = await openChatBotId(user, body.data.bot)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    const settings = new ExecutionSettings(pool)
    if ('modelKey' in body.data) return json(await setPreferredRoute(pool, settings, scope, botId, body.data.modelKey, body.data.optionId))
    if ('options' in body.data) {
      const menu = await botModelMenu(pool, settings, scope, botId)
      await setChatModelSettings(pool, scope, botId, body.data.options, menu.current.capabilities)
      return json(await botModelMenu(pool, settings, scope, botId))
    }
    if ('mode' in body.data) {
      if (!botId) return json({ error: 'invalidBot' }, 400)
      if (body.data.mode === 'restore-implicit') {
        const restored = await settings.restoreTemporaryBotModel(scope, botId, body.data)
        return restored ? json({ restored: true, preferenceState: 'absent' }) : json({ error: 'modelChanged' }, 409)
      }
      const temporarySelection = await settings.setTemporaryBotModel(scope, botId, body.data.id)
      if (!temporarySelection) return json({ error: 'modelChanged' }, 409)
      return json({ ...await botModelMenu(pool, settings, scope, botId), temporarySelection })
    }
    return json(await chooseBotModel(pool, settings, scope, botId, body.data.id))
  } catch (error) { return failed(error) }
}

/** `POST /api/mobile/model` with `{ bot }`: 刷新, re-reads the menu after asking each subscription for its models. */
async function handlePOST(request: Request, user: ApiSession['user']) {
  const body = z.strictObject({ bot: botParam }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidBot' }, 400)
  try {
    const botId = await openChatBotId(user, body.data.bot)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    return json(await refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, botId))
  } catch (error) { return failed(error) }
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/model',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)

export const POST = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/model',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user }) => handlePOST(request, user),
)

export const PUT = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/model',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user }) => handlePUT(request, user),
)
