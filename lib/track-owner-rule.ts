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
 * - No part looks like data: an email address, a URL, a domain with a path, a host and port, an IPv4 address, a UUID,
 *   a key or token, or a long number, also in fullwidth or other scripts' digits. The path and the label also may
 *   not name a domain, and the label may not hold seven or more digits. A hashed message-key label
 *   (`FeatureCopy.c_30108106`) is a name, so its digits are allowed. */
export const TRACK_OWNER_MAX_LENGTH = 191
// <path>#<Component>:<Element>[onX=<handler>] or [<label>], then .<N>: groups 1 path (no extension), 2 component,
// 3 element, 4 handler, 5 label, 6 index.
const TRACK_OWNER =
  /^((?:core|web|slots|components|lib|shared|preview)(?:\/[\w.@$-]+)+)\.(?:tsx|jsx)#([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\[(?:(on[A-Z][A-Za-z]*=[A-Za-z_$][\w$.]{0,63})|([^[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,48}))\])?(\.\d{1,3})?$/u
/** The UI checkout's hashed message keys, which are names. */
const MESSAGE_KEY_LABEL = /^FeatureCopy\.c_[0-9a-f]{8}$/
/** Data in any part of an owner. */
const OWNER_DATA = [
  /[^\s@]@[^\s@]/u, // an email address
  /[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:mailto|tel|data|javascript):/iu, // a URL
  /\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S/iu, // a domain and a path
  /\.[a-z]{2,}:\d{2,5}/iu, // a host and port
  /(?<![\p{Nd}.])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?![\p{Nd}])/u, // an IPv4 address
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu, // a UUID
  /(?<![\p{L}\p{N}_-])(?=[\p{L}_-]*\p{N})[\p{L}\p{N}_-]{20,}/u, // a key or token: 20+ letters and digits with a digit
  /\p{Nd}{5,}|(?:\p{Nd}[\s().,+/_:$-]*){7,}/u, // an id, phone or card number
]
/** A domain: any two-letter ending, or a generic one. */
const DOMAIN =
  /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2}|com|net|org|info|biz|xyz|gov|edu|mil|int|pro|name|mobi|app|dev|site|online|tech|cloud|page|link|live|store|shop|blog|email|space|website|team|chat|club|design|studio|digital|media|news|art|fun|life|world|today|agency|network|systems|software|tools|zone|works|group|global|company|services|solutions|host|top|vip|wiki|social|click|work|ink|one|plus)(?![\p{L}\p{N}_-])/iu

function normalized(text: string): string {
  return text.normalize('NFKC')
}

/** Whether text in any part of an owner looks like data. Fullwidth forms (`＠`, `４`) count as their ASCII letters. */
export function looksLikeOwnerData(text: string): boolean {
  const value = normalized(text)
  return OWNER_DATA.some(shape => shape.test(value))
}

/** Whether a label is data rather than a control's name: anything above, a domain, or seven or more digits however
 * they are separated. A hashed message key (`FeatureCopy.c_30108106`) is a name. */
export function isDataLabel(label: string): boolean {
  if (MESSAGE_KEY_LABEL.test(label)) return false
  const value = normalized(label).replace(/[[\]]/g, ' ')
  return looksLikeOwnerData(value) || DOMAIN.test(value) || (value.match(/\p{Nd}/gu)?.length ?? 0) >= 7
}

export function isTrackOwner(owner: unknown): owner is string {
  if (typeof owner !== 'string' || owner.length > TRACK_OWNER_MAX_LENGTH) return false
  const match = TRACK_OWNER.exec(owner)
  if (!match) return false
  const [, path, component, element, handler, label, index] = match
  if (path.split('/').some(segment => /^\.+$/.test(segment))) return false
  if (label !== undefined && isDataLabel(label)) return false
  if (DOMAIN.test(normalized(path))) return false
  // The parts are checked apart from the owner's own `#`, `:` and brackets, so those are never read as data.
  return !looksLikeOwnerData([path, component, element, handler ?? '', index ?? ''].join(' # '))
}
