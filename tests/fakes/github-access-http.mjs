import { createServer } from 'node:http'
import { json } from './http.mjs'

/**
 * @typedef {{ id: number | string, login: string }} GitHubFakeUser
 * @typedef {{ id: number | string, full_name: string, private: boolean, description?: string | null, homepage?: string | null, pushed_at?: string | null }} GitHubFakeRepository
 * @typedef {{ method: string | undefined, pathname: string, search: string, headers: import('node:http').IncomingHttpHeaders, bodyText: string }} GitHubFakeRequestRecord
 * @typedef {(request: import('node:http').IncomingMessage) => GitHubFakeUser | null | Promise<GitHubFakeUser | null>} GitHubUserHandler
 * @typedef {(request: import('node:http').IncomingMessage) => GitHubFakeRepository[] | null | Promise<GitHubFakeRepository[] | null>} GitHubRepositoriesHandler
 * @typedef {(url: URL, request: import('node:http').IncomingMessage, bodyText: string, response: import('node:http').ServerResponse) => Response | boolean | undefined | void | Promise<Response | boolean | undefined | void>} GitHubCustomRequestHandler
 * @typedef {{ appId?: number, installationId?: number, getUser?: GitHubUserHandler, getRepositories?: GitHubRepositoriesHandler, onRequest?: GitHubCustomRequestHandler | null }} GitHubAccessHttpOptions
 */

/**
 * Loopback GitHub HTTP fake for tests that retain real lib/github/user-access.ts
 * instead of mocking the provider module (#2886).
 *
 * @param {GitHubAccessHttpOptions} [options]
 */
export async function startGitHubAccessHttp({
  appId = 4840908,
  installationId = 11,
  getUser = () => ({ id: 42, login: 'fixture-user' }),
  getRepositories = () => [],
  onRequest = null,
} = {}) {
  /** @type {GitHubFakeRequestRecord[]} */
  const requests = []
  const state = { appId, installationId, getUser, getRepositories, onRequest }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, bodyText })
    try {
      if (state.onRequest) {
        const custom = await state.onRequest(url, request, bodyText, response)
        if (custom === true || response.writableEnded) return
        if (custom instanceof Response) {
          response.writeHead(custom.status, Object.fromEntries(custom.headers.entries()))
          response.end(Buffer.from(await custom.arrayBuffer()))
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/user') {
        const user = await state.getUser(request)
        if (!user) return json(response, { message: 'Unauthorized' }, 401)
        return json(response, user)
      }
      if (request.method === 'GET' && url.pathname === '/user/installations') {
        const repos = await state.getRepositories(request)
        if (repos === null) return json(response, { message: 'Unavailable' }, 502)
        const installations = repos.length
          ? [{ id: Number(state.installationId), app_id: Number(state.appId), suspended_at: null, account: { login: repos[0].full_name.split('/')[0] } }]
          : []
        return json(response, { installations })
      }
      if (request.method === 'GET' && url.pathname === `/user/installations/${state.installationId}/repositories`) {
        const repos = await state.getRepositories(request)
        if (repos === null) return json(response, { message: 'Unavailable' }, 502)
        return json(response, { repositories: repos })
      }
      if (request.method === 'GET' && url.pathname.startsWith('/repos/')) {
        const parts = url.pathname.slice('/repos/'.length).split('/')
        if (parts.length === 2) {
          const full = `${parts[0]}/${parts[1]}`.toLowerCase()
          const repos = (await state.getRepositories(request)) ?? []
          const match = repos.find(repo => repo.full_name.toLowerCase() === full)
          if (match) return json(response, match)
          return json(response, { message: 'Not Found' }, 404)
        }
      }
      return json(response, { message: `Unhandled GitHub fake path: ${request.method} ${url.pathname}` }, 404)
    } catch {
      return json(response, { message: 'Fixture server error' }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback GitHub fake failed to bind TCP port')
  const origin = `http://127.0.0.1:${address.port}`
  const realFetch = globalThis.fetch
  /**
   * @param {typeof fetch} [fallback]
   * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
   */
  const routeFetch = (fallback = realFetch) => async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input)
    const parsed = new URL(rawUrl)
    if (parsed.origin === 'https://api.github.com') {
      const target = `${origin}${parsed.pathname}${parsed.search}`
      if (input instanceof Request) return realFetch(new Request(target, input), { redirect: 'error' })
      return realFetch(target, { ...init, redirect: 'error' })
    }
    return fallback(input, init)
  }
  return {
    origin,
    requests,
    state,
    routeFetch,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(() => resolve(undefined)))
    },
  }
}
