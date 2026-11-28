import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import { transform } from 'esbuild'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { serverDocumentKind } from '../../../lib/server-pages.ts'
import { cn } from '../../../lib/utils.ts'
import { needsOfficialUi, officialUi } from './application-test-build.mjs'

const require = createRequire(import.meta.url)
// The invitation cards are the official UI's (core/components/workspace in its checkout); without one these tests skip.
const source = officialUi.dir ? await readFile(`${officialUi.dir}/core/components/workspace/invitation-card.tsx`, 'utf8') : ''
const { code } = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' })
const loadCard = runInThisContext('(function (require, module) {' + code + '\n})')

for (const locale of ['en', 'zh-CN']) {
  const messages = JSON.parse(await readFile(new URL('../../../messages/' + locale + '.json', import.meta.url), 'utf8'))
  for (const serverOnly of [false, true]) {
    test(locale + ' Workspace and Organization invitations from ' + (serverOnly ? 'the self-hosted server' : 'an official app'), { skip: needsOfficialUi }, async t => {
      const window = new Window()
      const mockFetch = async url => ({
        ok: true,
        json: async () => String(url).includes('/api/organization-invitations/')
          ? { organizationName: 'Acme Org', inviterName: 'Maya', role: 'admin' }
          : { workspaceName: 'Design WS', inviterName: 'Alex', role: 'member' },
      })
      const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true, fetch: mockFetch, AbortController: window.AbortController }
      const previous = Object.getOwnPropertyDescriptors(globalThis)
      Object.assign(globalThis, globals)
      if (serverOnly) document.documentElement.dataset.mikkaServerPage = 'authentication'
      const root = createRoot(document.body.appendChild(document.createElement('div')))
      t.after(async () => {
        await act(async () => root.unmount())
        await window.close()
        for (const key of Object.keys(globals)) {
          if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
          else delete globalThis[key]
        }
      })
      const plain = ({ children }) => createElement('div', null, children)
      const accept = t.mock.fn(async () => ({ joined: true, role: 'member' }))
      const workspaceId = 'workspace-one'
      let admitted = false
      const acceptWorkspace = t.mock.fn(async () => admitted ? { ok: true, data: { workspaceId } } : { ok: false, error: 'Declined' })
      const go = t.mock.method(window.location, 'assign', () => {})
      const boundary = {
        '@hosted/core/components/icons': { LoaderCircle: () => null, Users: () => null },
        '@hosted/core/components/ui/spinner': { Spinner: () => null },
        '@/lib/intl/i18n-client': {
          useTranslations: namespace => {
            const dict = namespace.split('.').reduce((partDict, part) => partDict[part], messages)
            return Object.assign(key => dict[key], { has: key => Object.hasOwn(dict, key) })
          },
        },
        '@hosted/core/components/blocks/auth-19/components/auth-card': {
          AuthCard: ({ title, description, children }) => createElement('section', null, createElement('h1', null, title), description && createElement('p', { role: 'status' }, description), children),
        },
        '@hosted/core/components/auth/account-line': { AccountLine: ({ email }) => createElement('p', { 'data-slot': 'account-line' }, email) },
        '@hosted/core/components/ui/card': { Card: plain, CardContent: plain, CardFooter: plain, CardHeader: plain, CardTitle: plain },
        '@hosted/core/components/ui/button': { Button: props => createElement('button', props), buttonVariants: () => '' },
        '@hosted/core/components/ui/alert': { Alert: plain, AlertDescription: plain },
        '@hosted/core/lib/client-runtime/localized-navigation': { Link: props => createElement('a', props) },
        '@/lib/server-pages': { serverDocumentKind },
        '@/lib/utils': { cn },
        '@/lib/use-action-error': { useActionError: () => String },
        '@hosted/core/hooks/settings/use-organization': { organizationApi: { acceptInvitation: accept }, useOrganizationErrorText: () => String },
        '@/app/actions/workspace': { acceptWorkspaceInvitation: acceptWorkspace }, '@/lib/auth-client': {},
        '@/lib/base-path': { withBasePath: path => '/mikka' + path },
      }
      const mod = { exports: {} }
      loadCard(id => Object.hasOwn(boundary, id) ? boundary[id] : require(id), mod)
      const token = 'a'.repeat(64)
      const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 10)))
      const render = async email => {
        await act(async () => root.render(createElement(mod.exports.OrganizationInvitationCard, { token, email })))
        await flush()
      }
      const links = () => [...document.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')])
      const back = [serverOnly ? messages.Invite.viewServerAndApps : messages.Invite.backToWorkspace, '/']
      const notNow = [messages.Invite.notNow, '/']
      const signInHref = '/sign-in?next=' + encodeURIComponent('/organization-invite/' + token)
      await render(null)
      assert.equal(links().some(([, href]) => href === signInHref), true)
      await render('member@example.test')
      assert.deepEqual(links(), [notNow])
      await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === messages.Invite.join).click())
      assert.deepEqual(accept.mock.calls.map(c => c.arguments), [[token]])
      assert.deepEqual(links(), serverOnly ? [back] : [[messages.Organization.invitations.openOrganization, '/settings?section=organization']])

      const renderWorkspace = async email => {
        await act(async () => root.render(createElement(mod.exports.InvitationCard, { token, email })))
        await flush()
      }
      const wsSignInHref = '/sign-in?next=' + encodeURIComponent('/invite/' + token)
      await renderWorkspace(null)
      assert.equal(links().some(([, href]) => href === wsSignInHref), true)
      await renderWorkspace('member@example.test')
      const joinButton = () => [...document.querySelectorAll('button')].find(b => b.textContent === messages.Invite.join)
      await act(async () => joinButton().click())
      assert.ok(joinButton(), 'a refused workspace invitation can be retried')
      assert.equal(document.querySelector('[role=status]'), null)
      assert.equal(go.mock.callCount(), 0)
      admitted = true
      await act(async () => joinButton().click())
      assert.deepEqual(acceptWorkspace.mock.calls.map(c => c.arguments), [[token], [token]])
      if (serverOnly) {
        assert.equal(document.querySelector('[role=status]').textContent, messages.Invite.joined)
        assert.deepEqual(links(), [back])
        assert.equal(joinButton(), undefined)
        assert.equal(go.mock.callCount(), 0)
      } else {
        assert.deepEqual(go.mock.calls.map(c => c.arguments), [['/mikka/settings/members?workspace=' + workspaceId]])
      }
    })
  }
}
