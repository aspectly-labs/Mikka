import { APIError } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'

export const otpRequestPaths = ['/email-otp/send-verification-otp', '/email-otp/request-password-reset']
export const otpPurposeByPath = new Map([
  ['/email-otp/verify-email', 'email-verification'],
  ['/sign-in/email-otp', 'sign-in'],
  ['/email-otp/reset-password', 'forget-password'],
])

// Use the ordinary TOTP/recovery challenge and trusted-device policy for every
// first factor. Better Auth 1.7's matcher only includes password-based sign-ins.
export function mikkaTwoFactor() {
  const plugin = twoFactor({ issuer: 'Mikka', allowPasswordless: true })
  for (const hook of plugin.hooks.after) {
    const matches = hook.matcher
    hook.matcher = context => matches(context.path === '/sign-in/email-otp' ? { ...context, path: '/sign-in/email' } : context)
  }
  return plugin
}

// Unknown recipients have no stored challenge. An expired or exhausted code
// must produce the same public reply as an absent challenge.
export function publicOtpError(path: string | undefined, result: unknown) {
  if (!otpPurposeByPath.has(path ?? '') || !(result instanceof APIError)) return
  if (['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS', 'USER_NOT_FOUND'].includes(result.body?.code ?? '')) {
    return Response.json({ code: 'INVALID_OTP', message: 'Invalid or expired code' }, { status: 400, headers: { 'cache-control': 'no-store' } })
  }
}

export const disabledEmailOtpPaths = [
  '/forget-password/email-otp', '/email-otp/check-verification-otp',
  '/email-otp/request-email-change', '/email-otp/change-email',
]
