// pnpm dev:local's substitutes for the cloud services other than GitHub
// (docs/local-runtime.md). They are extra routes on the one local fake-service
// process (tests/mvp/services.mjs, 127.0.0.1:3191):
//
//   /litellm/v1/chat/completions   LiteLLM Chat Completions (scripted, no LLM)
//   /litellm/v1/messages           LiteLLM Anthropic Messages (scripted)
//   /litellm/v1/responses          LiteLLM OpenAI Responses (scripted)
//   /litellm/v1/decisions          LiteLLM Decisions (first choice / 0.5)
//   /litellm/v1/models             LiteLLM model list
//   /litellm/v1/audio/transcriptions  LiteLLM transcription (fixed text)
//   /litellm/scenarios             scripted fault/cost scenarios (POST {marker, fault|cost})
//   /deepseek/models               provider /models probe for the scripted seeded key
//   /resend/emails                 Resend send-email → local outbox
//   /mail, /mail.json              the outbox
//
// The preload sends requests here only when no real key is set
// (scripts/dev-local/transport.mjs), so each route accepts only the placeholder.
// The whole LiteLLM surface lives in tests/mvp/fake-litellm.mjs and is shared
// with the mvp fixture; this file only adds the mail/resend routes.
import { randomUUID } from 'node:crypto'
import { fakeLiteLLMRoutes, LOCAL_DEEPSEEK_KEY, LOCAL_LITELLM_KEY, LOCAL_LITELLM_URL } from '../../tests/mvp/fake-litellm.mjs'

export { LOCAL_DEEPSEEK_KEY, LOCAL_LITELLM_KEY, LOCAL_LITELLM_URL }
export { chatCompletion, chatCompletionPrompt, localDecision, localModelAnswer } from '../../tests/mvp/fake-litellm.mjs'

/** The placeholder for RESEND_API_KEY when the developer set none. Not a credential. */
export const LOCAL_RESEND_KEY = 'mikka-local-outbox'
/** The placeholder for CRON_SECRET when the developer set none. Not a credential. */
export const LOCAL_CRON_SECRET = 'mikka-local-cron'
const MAX_BODY = 16 * 1024 * 1024
const LOCAL_ALLOWANCE_MICRO_USD = 1_000_000_000 // $1000 of local, unbilled credit

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}


/**
 * Every local workspace without one gets the card verification and allowance a
 * real workspace gets from Stripe, so Mikka 默认 runs. Returns how many.
 */
export async function grantLocalCredits(appPool, workspacePool = appPool) {
  const { rows } = await workspacePool.query('SELECT id FROM mikka_workspaces')
  if (!rows.length) return 0
  const ids = rows.map(row => row.id)
  const granted = await appPool.query(
    `INSERT INTO hosted_verifications ("workspaceId") SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING RETURNING "workspaceId"`, [ids])
  await appPool.query(
    `INSERT INTO hosted_allowances ("workspaceId", remaining) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`, [ids, LOCAL_ALLOWANCE_MICRO_USD])
  return granted.rowCount
}

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/**
 * The `routes` hook for startMvpServices: answers its own paths and returns
 * true, or returns false for the fake GitHub and the MVP routes.
 */
export function localServiceRoutes({ log = console.info, origin = 'http://127.0.0.1:3191' } = {}) {
  const outbox = []
  const litellmRoutes = fakeLiteLLMRoutes()
  const litellm = (request, response, url) => litellmRoutes(request, response, url, { readBody: readJson })
  const routes = async (request, response, url) => {
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true }
    const bearer = request.headers.authorization?.replace(/^Bearer /, '')
    try {
      if (url.pathname === '/mail.json') return json({ messages: outbox })
      if (url.pathname === '/mail') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        const rows = outbox.toReversed().map(mail => `<article><h2>${escape(mail.subject)}</h2><p>${escape(mail.at)} → ${escape(mail.to.join(', '))}</p><pre>${escape(mail.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre></article>`)
        response.end(`<!doctype html><meta charset="utf-8"><title>Local outbox</title><body style="font:14px system-ui;max-width:860px;margin:24px auto;padding:0 16px">${rows.join('') || '<p>Empty</p>'}</body>`)
        return true
      }
      if (url.pathname === '/resend/emails' && request.method === 'POST') {
        if (bearer !== LOCAL_RESEND_KEY) return json({ message: 'unknown key' }, 401)
        const body = await readJson(request)
        const mail = { id: randomUUID(), at: new Date().toISOString(), from: body.from, to: [body.to].flat(), subject: body.subject ?? '', text: body.text ?? body.html ?? '' }
        outbox.push(mail)
        log(`mail "${mail.subject}" to ${mail.to.join(', ')}: ${origin}/mail`)
        return json({ id: mail.id })
      }
      if (await litellm(request, response, url)) return true
      return false
    } catch (error) {
      return json({ error: { message: error.message, type: 'local_services_error' } }, 500)
    }
  }
  return { routes, outbox }
}
