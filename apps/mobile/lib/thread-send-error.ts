import { mobileMessages } from './messages'

/**
 * What a thread page says when a message to it is refused, by the server's
 * error code, in the web's words (messages/zh-CN.json Errors). Without a code
 * the app could not reach the server, and sending again is one tap.
 */
const errors = mobileMessages.Errors
const LINES: Record<string, string> = {
  threadReplaced: errors.threadReplaced,
  threadCannotContinue: errors.threadCannotContinue,
  threadStopping: errors.threadStopping,
  agentRepoMissing: errors.agentRepoMissing,
  agentNoDevice: errors.agentNoDevice,
  runNotFound: errors.runNotFound,
}

export function threadSendErrorLine(code: string | null): string {
  return (code && LINES[code]) || mobileMessages.MobileCore.notSentRetry
}
