import { randomBytes, randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { Pool } from 'pg'
import { test, expect, app, browserClientHeaders, register, seedTask } from './fixtures'

// Alex, 2026-11-22 (chat look as LobeHub): a reply opens with its author's mark and name, and every mark fills the same
// 28px box: a Bot, a coding agent (Codex, Claude Code), Mikka and a person. The hosted thread draws the box
// (slots/thread.tsx); the marks come from this app. This checks what is drawn, not only the box: a 14px Codex glyph in a
// 28px box once read as a much smaller avatar than the Coordinator's beside it.

const MARK = 28

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This spec requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

/** The header's mark: its box, and the largest thing drawn inside it (an svg, image, canvas or filled shape). */
async function markSize(header: Locator) {
  return header.locator(':scope > :first-child').evaluate(mark => {
    const box = mark.getBoundingClientRect()
    const filled = (element: Element) => {
      if (/^(svg|img|canvas)$/i.test(element.tagName)) return true
      const style = getComputedStyle(element)
      return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
    }
    let drawn = 0
    for (const element of [mark, ...mark.querySelectorAll('*')]) {
      if (!filled(element)) continue
      const rect = element.getBoundingClientRect()
      // What the box clips away is not drawn: a blob's svg is larger than its box.
      drawn = Math.max(drawn, Math.min(rect.width, box.width, rect.height, box.height))
    }
    return { width: box.width, height: box.height, drawn }
  })
}

async function expectFullMark(header: Locator, who: string) {
  await expect(header).toBeVisible()
  const size = await markSize(header)
  expect(size.width, `${who}'s mark box`).toBeCloseTo(MARK, 0)
  expect(size.height, `${who}'s mark box`).toBeCloseTo(MARK, 0)
  expect.soft(size.drawn, `${who}'s mark is drawn at ${size.drawn}px in its ${MARK}px box`).toBeGreaterThanOrEqual(MARK - 0.5)
}

const header = (scope: Page | Locator, name: string) => scope.locator('.ui-th-who').filter({ hasText: name }).first()

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }) })

test('the Coordinator, Codex and Claude Code marks each fill the 28px header box', async ({ page }) => {
  const { email } = await register(page)
  // The personal Coordinator exists once its chat has opened.
  await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
  const title = `作者头像 ${randomUUID().slice(0, 8)}`
  await seedTask(page, title)
  const runs: string[] = []
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [coordinator] } = await pool.query<{ botId: string; workspaceId: string }>('SELECT "botId", "workspaceId" FROM coordinator_bots WHERE "ownerId" = $1 LIMIT 1', [user.id])
    await pool.query(`INSERT INTO coordinator_messages (id, "userId", "botId", position, message)
      SELECT $1, $2, $3, coalesce(max(position), 0) + 1, $4 FROM coordinator_messages WHERE "userId" = $2 AND "botId" = $3`,
    [randomUUID(), user.id, coordinator.botId, JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '收到，我来安排。' }] })])
    // The task belongs to the person's own workspace, as one made in the app does; its runs then belong there too.
    const { rows: [issue] } = await pool.query<{ id: string }>('UPDATE issues SET "workspaceId" = $3 WHERE "userId" = $1 AND title = $2 RETURNING id', [user.id, title, coordinator.workspaceId])
    for (const [harness, prompt] of [['codex', '整理登录重定向'], ['claude_code', '补一条回归测试']]) {
      const agentId = randomUUID(), runId = randomUUID()
      runs.push(runId)
      await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, harness, harness])
      await pool.query('INSERT INTO agent_runs (id, "userId", "workspaceId", "issueId", "agentId", status, prompt) VALUES ($1, $2, $3, $4, $5, $6, $7)', [runId, user.id, coordinator.workspaceId, issue.id, agentId, 'running', prompt])
      await pool.query('INSERT INTO run_chunks (id, "runId", seq, chunk) VALUES ($1, $2, 1, $3)', [randomUUID(), runId, JSON.stringify({ type: 'text-delta', id: runId, delta: `${prompt}：已开始。` })])
    }
  } finally { await pool.end() }

  await page.reload()
  await expectFullMark(header(page, 'Coordinator'), 'The Coordinator')

  for (const [index, [name, prompt]] of [['Codex', '整理登录重定向'], ['Claude Code', '补一条回归测试']].entries()) {
    // A thread link opens the run's conversation beside the chat.
    await page.goto(app(`/?thread=${runs[index]}`))
    const reply = page.locator('.ui-th-agent').filter({ hasText: `${prompt}：已开始。` }).first()
    await expect(reply).toBeVisible()
    await expectFullMark(reply.locator('.ui-th-who'), name)
  }
  // No other line in the thread heads itself with a smaller mark: an Agent switch between the runs is a line, not an author.
  const headers = page.locator('.ui-th-who:visible')
  for (let index = 0; index < await headers.count(); index++) await expectFullMark(headers.nth(index), `Header ${index + 1}`)
})

test('a Bot and a person each fill the 28px header box in a group', async ({ page, playwright, baseURL }) => {
  const { email } = await register(page)
  const origin = new URL(baseURL!).origin
  // Another person in the group: their messages head with their own mark.
  const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
  let otherId: string
  try {
    const signed = await other.post(app('/api/auth/sign-up/email'), { headers: { origin }, data: { email: `e2e-${randomUUID()}@example.com`, password: randomBytes(32).toString('base64url'), name: '林青' } })
    expect(signed.ok()).toBeTruthy()
    otherId = (await signed.json()).user.id as string
  } finally { await other.dispose() }
  const workspaceId = (await (await page.request.get(app('/api/workspace'))).json()).workspace.id as string
  const title = `头像群 ${randomUUID().slice(0, 8)}`
  const created = await page.request.post(app('/api/conversations'), { headers: { origin }, data: { workspaceId, title } })
  expect(created.status()).toBe(201)
  const { id } = await created.json() as { id: string }
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const botId = randomUUID()
    await pool.query('INSERT INTO bots (id, "workspaceId", "ownerId", name, color, shape) VALUES ($1, $2, $3, $4, \'orange\', \'hexagone\')', [botId, workspaceId, user.id, '值班 Bot'])
    await pool.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, \'bot\', $2, \'member\')', [id, botId])
    for (const [type, author, body] of [['user', otherId, '发布前要过一遍清单。'], ['bot', botId, '好的，我来整理发布清单。']]) {
      await pool.query('UPDATE conversations SET "lastPosition" = "lastPosition" + 1 WHERE id = $1', [id])
      await pool.query('INSERT INTO conversation_messages (id, "conversationId", position, "authorType", "authorId", body) SELECT $1, $2, "lastPosition", $3, $4, $5 FROM conversations WHERE id = $2',
        [randomUUID(), id, type, author, body])
    }
  } finally { await pool.end() }

  await page.reload()
  // A group's row sits under 群聊 and names itself unread: 「头像群 …，未读」.
  await page.getByRole('complementary', { name: '侧栏导航', exact: true }).getByRole('button', { name: new RegExp(`^${title}`) }).click()
  const chat = page.getByRole('region', { name: title, exact: true })
  await expect(chat.getByText('好的，我来整理发布清单。')).toBeVisible()
  await expectFullMark(header(chat, '值班 Bot'), 'A Bot')
  await expectFullMark(chat.locator('.ui-th-agent').filter({ hasText: '发布前要过一遍清单。' }).locator('.ui-th-who'), 'A person')
})
