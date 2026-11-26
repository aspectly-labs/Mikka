/** Which `data-track-owner` values analytics keeps (lib/analytics-policy.ts, `ui_control_click`). An owner is source
 * text the UI checkout's build writes (its scripts/track-owner/vite-plugin.mjs, format in scripts/track-owner/format.mjs):
 *   <path>.tsx#<Component>:<Element>[<label>].<N>
 * The checkout keeps a copy of this rule in its format.mjs and tests every owner it writes against this file when the
 * public checkout is around it, so keep the two the same. This file imports nothing and uses only erasable types, so
 * Node can load it directly.
 *
 * - The path starts at one of the checkout's source roots and has no `.` or `..` segment.
 * - The index is at most three digits, a handler label (`[onClick=handler]`) at most 64 characters, any other label
 *   1 to 48 characters with no control, format or line-separator characters.
 * - Nothing in the owner (path, component, element, handler or label) looks like data: an email address, a URL or
 *   domain, an IPv4 address, or a long number (an id, phone or card number), also in fullwidth or other scripts'
 *   digits. A label shaped like a hashed message key (`FeatureCopy.c_30108106`) is a name, so its digits are allowed. */
export const TRACK_OWNER_MAX_LENGTH = 191
const TRACK_OWNER =
  /^((?:core|web|slots|components|lib|shared|preview)(?:\/[\w.@$-]+)+\.(?:tsx|jsx))#[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[(?:on[A-Z][A-Za-z]*=[A-Za-z_$][\w$.]{0,63}|([^[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,48}))\])?(?:\.\d{1,3})?$/u
const MESSAGE_KEY_LABEL = /^[A-Za-z][\w.]*\.c_[0-9a-f]{8}$/
const OWNER_DATA = [
  /[^\s@]@[^\s@]/u, // an email address
  /[a-z][a-z\d+.-]*:\/\/|\bwww\./iu, // a URL
  /\b(?:mailto|tel|data|javascript):/u, // a URL without `//`
  /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}-]+\.)+(?:com|net|org|io|ai|co|cn|uk|de|jp|ru|xyz|gov|edu|dev|app)(?![\p{L}\p{N}_-])/iu, // a domain
  /(?<![\p{Nd}.])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?![\p{Nd}])/u, // an IPv4 address
  /\p{Nd}{5,}|(?:\p{Nd}[\s().,+/_:-]*){7,}/u, // an id, phone or card number
]

/** Whether text looks like data rather than a name. Fullwidth forms (`＠`, `４`) count as their ASCII letters. */
export function looksLikeOwnerData(text: string): boolean {
  const normalized = text.normalize('NFKC')
  return OWNER_DATA.some(shape => shape.test(normalized))
}

export function isTrackOwner(owner: unknown): owner is string {
  if (typeof owner !== 'string' || owner.length > TRACK_OWNER_MAX_LENGTH) return false
  const match = TRACK_OWNER.exec(owner)
  if (!match) return false
  if (match[1].split('/').some(segment => /^\.+$/.test(segment))) return false
  const label = match[2]
  let text = owner.replace(/\.(?:tsx|jsx)#/, ' ')
  if (label !== undefined && MESSAGE_KEY_LABEL.test(label)) text = text.replace(`[${label}]`, '[]')
  return !looksLikeOwnerData(text)
}
