import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { Pool } from 'pg'
import { test as base, expect, app, browserClientHeaders, captureAuthenticationCookies, skipOnboarding } from './fixtures'
import { recordAuthenticationSecrets } from '../../scripts/test-accounts/session.mjs'

// Alex, 2026-11-22 (chat look as LobeHub): every block in a message spans the words' width, the full message column, so
// none stands squat beside the text: a tool group, its summary and rows (as LobeHub's, no tree indent), an expanded tool
// result, a code block, a table and the Crew cards.
// The hosted thread draws the column (styles/globals.css `data-look="lobehub"`); this checks the laid-out widths.

const test = base.extend<{ register: (page: Page) => Promise<{ email: string }> }>({
  register: async ({ playwright, baseURL }, use) => {
    const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() })
    const origin = new URL(baseURL!).origin
    try {
      await use(async page => {
        const email = `e2e-${randomUUID()}@example.com`
        const password = randomBytes(32).toString('base64url')
        if (process.env.MIKKA_TEST_ENVIRONMENT_FILE) await recordAuthenticationSecrets([password])
        try {
          const signed = await client.post(app('/api/auth/sign-up/email'), { headers: { origin }, data: { email, password, name: '宽度验收' } })
          expect(signed.ok()).toBeTruthy()
          await page.context().addCookies((await client.storageState()).cookies)
          await page.goto(app('/'))
          await skipOnboarding(page, email)
          return { email }
        } finally { await captureAuthenticationCookies(page.context()) }
      })
    } finally { await client.dispose() }
  },
})

function isolatedPool() {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('This spec requires an isolated E2E_DATABASE_URL')
  const target = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('Refusing to seed a business database')
  return new Pool({ connectionString, max: 1 })
}

const LONG = '登录后会先回到首页，再跳到原来的页面，这一步在 Safari 17 上偶尔白屏。原因是重定向地址在服务端被编码了两次，客户端解开一次以后仍然是编码过的路径，路由找不到页面就渲染了空白。修复只改一处：服务端写入 Cookie 时不再编码，读取时统一解码一次。'
const CODE = "```ts\nexport function readRedirect(cookie: string | undefined): string {\n  if (!cookie) return '/'\n  const target = decodeURIComponent(cookie)\n  return target.startsWith('/') && !target.startsWith('//') ? target : '/'\n}\n```"
const TABLE = '| 浏览器 | 修复前 | 修复后 |\n| --- | --- | --- |\n| Safari 17 | 白屏 | 正常 |\n| Chrome 131 | 正常 | 正常 |'

async function seedReply(email: string) {
  const pool = isolatedPool()
  try {
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
    const { rows: [coordinator] } = await pool.query<{ botId: string; workspaceId: string }>(`SELECT c."botId", c."workspaceId"
      FROM coordinator_bots c JOIN mikka_workspaces w ON w.id = c."workspaceId"
      WHERE c."ownerId" = $1 AND w."userId" = $1 AND w.kind = 'personal' LIMIT 1`, [user.id])
    if (!coordinator) throw new Error('The new account has no personal Coordinator')
    const agentId = randomUUID(), runId = randomUUID()
    await pool.query('INSERT INTO agents (id, "userId", harness, name) VALUES ($1, $2, $3, $4)', [agentId, user.id, 'codex', '工程 Agent'])
    await pool.query('INSERT INTO agent_runs (id, "userId", "workspaceId", "agentId", status, prompt, "promptTaskStart", "promptTaskLength", title, "titleSource") VALUES ($1, $2, $3, $4, $5, $6, 0, char_length($6), $7, $8)',
      [runId, user.id, coordinator.workspaceId, agentId, 'running', '修复登录重定向并补一条回归测试', '修复登录重定向', 'manual'])
    const messages = [
      { role: 'user', content: '把登录重定向的修复整理成一份说明。' },
      { role: 'assistant', mikkaStreamId: 's1', content: [
        { type: 'text', text: LONG },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'lib/auth/redirect.ts' } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'dispatch_run', input: { prompt: '修复登录重定向并补一条回归测试' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: 'export function readRedirect() {}' } },
        { type: 'tool-result', toolCallId: 'c2', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } },
      ] },
      { role: 'assistant', mikkaStreamId: 's1', content: [{ type: 'text', text: `改动如下：\n\n${CODE}\n\n结果：\n\n${TABLE}` }] },
    ]
    for (const message of messages) await pool.query(`INSERT INTO coordinator_messages (id, "userId", "botId", position, message)
      SELECT $1, $2, $3, coalesce(max(position), 0) + 1, $4 FROM coordinator_messages WHERE "userId" = $2 AND "botId" = $3`,
    [randomUUID(), user.id, coordinator.botId, JSON.stringify(message)])
  } finally { await pool.end() }
}

for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`every block in a reply is as wide as its words (${device})`, async ({ page, register }) => {
    await page.setViewportSize(viewport)
    const { email } = await register(page)
    await expect(page.getByRole('textbox', { name: '给 Coordinator 发消息', exact: true })).toBeVisible()
    await seedReply(email)
    await page.reload()
    const words = page.locator('.ui-th-text').filter({ hasText: '登录后会先回到首页' }).first()
    await expect(page.locator('.ui-th-text').filter({ hasText: '结果' }).locator('table')).toBeVisible()
    // The expanded result of the first tool.
    const head = page.locator('.ui-th-tools__head').first()
    // The thread follows the latest until the reader scrolls up themselves (patches/agent-thread.virtual-list.patch):
    // a script's scrollIntoView is put back at the end, so scroll up with the wheel, as a reader would, on a phone.
    const scroller = (await page.locator('.ui-th-scroll').first().boundingBox())!
    await page.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2)
    await expect(async () => {
      const box = (await head.boundingBox())!
      if (box.y < scroller.y) await page.mouse.wheel(0, Math.min(-60, box.y - scroller.y - 40))
      else if (box.y + box.height > scroller.y + scroller.height) await page.mouse.wheel(0, 300)
      await expect(head).toBeInViewport({ ratio: 1, timeout: 500 })
    }).toPass({ timeout: 15_000 })
    if (await head.getAttribute('aria-expanded') !== 'true') await head.click()
    await page.locator('summary.ui-th-tool').first().click()
    const width = async (selector: string) => (await page.locator(selector).first().boundingBox())?.width ?? -1
    const text = (await words.boundingBox())!
    const blocks = {
      'tool group': await width('.ui-th-tools'),
      'tool summary': await width('.ui-th-tools__head'),
      'tool row': await width('summary.ui-th-tool'),
      'expanded tool result': await width('details.ui-th-tool-details[open] > :not(summary)'),
      'code block': await width('.ui-th-text .agent-code-block'),
      table: await width('.ui-th-text [role="region"]:has(> [data-slot="table-container"])'),
      'Crew cards': await width('.ui-th-text [data-slot="subagents"]'),
      'one Crew card': await width('.ui-th-text [data-slot="subagents"] > :nth-child(2) > *'),
    }
    for (const [name, w] of Object.entries(blocks)) expect(Math.abs(w - text.width), `${name}: ${w} vs the words' ${text.width}`).toBeLessThanOrEqual(1)
  })
}
