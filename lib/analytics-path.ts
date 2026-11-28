// Routes and URLs as analytics may carry them: every dynamic segment replaced
// by a placeholder. lib/analytics-policy.ts (the web's before_send and the
// desktop main process) and lib/first-touch.ts both read paths through here.

/** Pages whose next segment is a credential, wherever they sit in the path
 * (after a base path or locale): an artifact, thread or capture share link and
 * the two invitations. Its holder can open what it names, so it never leaves.
 * Matched without regard to case. */
const CREDENTIAL_PREFIXES = [['a'], ['invite'], ['organization-invite'], ['threads', 'shared'], ['share']]
/** Pages whose next segment names a workspace (`/w/acme`) rather than a page. */
const SLUG_PREFIXES = [['w']]
/** A segment that is a page's own name (`settings`, `forgot-password`): lower-case
 * words, no digits, so a lower-case hex id or token is never mistaken for one. */
const ROUTE_WORD = /^(?=.{1,40}$)[a-z]+(?:-[a-z]+)*$/
const LOCALE_SEGMENT = /^(?:en|zh-CN)$/
/** An API version (`/api/v1/…`), which messages and frames name. */
const VERSION_SEGMENT = /^v\d{1,2}$/
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** What analyticsPath writes in place of a segment. A path that already went
 * through it (the desktop renderer's, which main sanitizes again) keeps them, so
 * a second pass changes nothing. A placeholder carries no data of its own. */
const PLACEHOLDERS = new Set([':id', ':token', ':redacted', ':slug'])
/** A bundle file a stack frame names (`index-B3x9.js`): its name groups the frame, and is the build's, not a person's. */
const BUNDLE_FILE = /^[\w.-]{1,128}\.(?:m?js|cjs|css|map|wasm)$/

function follows(words: string[], prefix: string[]) {
  return words.length >= prefix.length && prefix.every((word, index) => words[words.length - prefix.length + index] === word)
}

/**
 * A page path with every dynamic segment replaced by a placeholder. Only a
 * page's own words and the locale stay; a share or invitation token becomes
 * `:token` after its page word, a UUID or number `:id`, an email `:redacted`,
 * and anything else that is not a route word (`SPOT-4`, a token on a page this
 * list does not name yet) `:token`. The query and hash are the caller's to drop.
 * Idempotent: an existing placeholder stays as it is. Linear in the path's length.
 */
export function analyticsPath(pathname: string) {
  const words: string[] = []
  return pathname.split('/').map(raw => {
    if (!raw) return raw
    let clean: string
    if (PLACEHOLDERS.has(raw)) clean = raw
    else if (CREDENTIAL_PREFIXES.some(prefix => follows(words, prefix))) clean = ':token'
    else if (SLUG_PREFIXES.some(prefix => follows(words, prefix))) clean = ':slug'
    else if (raw.includes('@')) clean = ':redacted'
    else if (UUID_SEGMENT.test(raw) || /^\d+$/.test(raw)) clean = ':id'
    else if (ROUTE_WORD.test(raw) || LOCALE_SEGMENT.test(raw) || VERSION_SEGMENT.test(raw)) clean = raw
    else clean = ':token'
    words.push(raw.toLowerCase())
    return clean
  }).join('/')
}

/** A URL's origin as analytics names it. The desktop's own scheme (mikka://app)
 * has no WHATWG origin; its host still names the app, never a person. */
export function analyticsOrigin(url: URL) {
  return url.origin === 'null' && url.protocol === 'mikka:' && url.host === 'app' ? 'mikka://app' : url.origin
}

/** A path inside free text, with a bundle file's own name kept so a stack frame still groups. */
function textPath(path: string) {
  const cut = path.lastIndexOf('/')
  const file = path.slice(cut + 1)
  return BUNDLE_FILE.test(file) ? `${analyticsPath(path.slice(0, cut))}/${file}` : analyticsPath(path)
}

const TEXT_URL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#'"`<>()]*)(\/[^\s?#'"`<>()]*)?/gi
const TEXT_PATH = /(^|[\s'"`(<=])(\/[^\s?#'"`<>()]*)/g

/**
 * Free text (an error message, a frame's file or function) with every URL's
 * path and every absolute path through analyticsPath: `failed /a/mks_…`
 * becomes `failed /a/:token`. A bundle file's name stays.
 */
export function analyticsTextPaths(text: string) {
  return text
    .replace(TEXT_URL, (_match, origin: string, path: string | undefined) => `${origin}${path ? textPath(path) : ''}`)
    .replace(TEXT_PATH, (_match, before: string, path: string) => `${before}${textPath(path)}`)
}
