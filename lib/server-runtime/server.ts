/**
 * The server's request and response types, bound to the request scope that
 * carries the real Request, its cookies, its locale and its `after` queue.
 *
 * Application route handlers import this module instead of a framework package.
 */
import { bindRequestCallback, requireRequestScope } from '../../apps/api/src/context'
import { CookieJar } from '../../apps/api/src/cookies'

type RouteConfig = { basePath?: string }
export class RouteURL extends URL {
  basePath: string
  constructor(input: string | URL, options: { routeConfig?: RouteConfig } = {}) {
    super(input)
    const prefix = options.routeConfig?.basePath ?? '/mikka'
    this.basePath = prefix && (super.pathname === prefix || super.pathname.startsWith(`${prefix}/`)) ? prefix : ''
    if (this.basePath) super.pathname = super.pathname.slice(this.basePath.length) || '/'
  }
  override get href(): string {
    const value = new URL(super.href)
    value.pathname = this.basePath + (super.pathname === '/' ? '' : super.pathname) || '/'
    return value.href
  }
  override set href(value: string) { super.href = value }
  override toString(): string { return this.href }
  override toJSON(): string { return this.href }
  clone(): RouteURL { return new RouteURL(this.href, { routeConfig: { basePath: this.basePath } }) }
}

export class RouteRequest extends Request {
  readonly routeUrl: RouteURL
  readonly cookies: CookieJar
  constructor(input: RequestInfo | URL, options: RequestInit & { routeConfig?: RouteConfig; duplex?: 'half' } = {}) {
    const url = input instanceof Request ? input.url : String(input)
    const { routeConfig, ...init } = options
    let source = input
    // srvx NodeRequest is a Request-compatible adapter, but its private Undici
    // state belongs to the SDK's documented native backing request. Leave the
    // outer object (runtime/abort/waitUntil) in the real request scope untouched.
    if (input instanceof Request && '_request' in input) {
      const canonical = (input as Request & { _url?: URL })._url
      if (canonical && canonical.href !== url) throw new TypeError('API_REQUEST_URL_MISMATCH')
      if (input.bodyUsed && init.body == null) throw new TypeError('API_REQUEST_BODY_USED')
      source = (input as Request & { _request?: Request })._request ?? input
      if (source instanceof Request && source.url !== url) throw new TypeError('API_REQUEST_URL_MISMATCH')
    }
    super(source, { duplex: 'half', ...init } as RequestInit)
    this.routeUrl = new RouteURL(url, { routeConfig })
    this.cookies = new CookieJar(this.headers.get('cookie'), value => this.headers.set('cookie', value))
  }
}

export class RouteResponse<_Body = unknown> extends Response {
  private jar?: CookieJar
  get cookies(): CookieJar {
    if (!this.jar) {
      this.jar = new CookieJar(null, undefined, (name, encoded) => {
        const retained = this.headers.getSetCookie().filter(value => !value.startsWith(`${name}=`))
        this.headers.delete('set-cookie')
        for (const value of retained) this.headers.append('set-cookie', value)
        this.headers.append('set-cookie', encoded)
      })
    }
    return this.jar
  }
  static override json<Body>(body: Body, init?: ResponseInit): RouteResponse<Body> {
    const response = Response.json(body, init)
    // srvx materializes a response after headers are accessed by spreading its
    // init. Response getters are not own properties, so copy the HTTP fields.
    return new RouteResponse<Body>(response.body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    })
  }
  static override redirect(url: string | URL, init: number | ResponseInit = 307): RouteResponse {
    const options = typeof init === 'number' ? { status: init } : init
    const status = options.status ?? 307
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status code')
    const headers = new Headers(options.headers)
    headers.set('location', new URL(String(url)).toString())
    return new RouteResponse(null, { ...options, status, headers })
  }
}
export function after(task: (() => unknown) | PromiseLike<unknown>): void {
  const scope = requireRequestScope()
  scope.after.add(typeof task === 'function' ? bindRequestCallback(task) : task)
}
