import chineseMessages from '@/messages/zh-CN.json'

export type AgentCopy = { [Key in keyof typeof chineseMessages.AgentCopy]: string }

export const defaultAgentCopy: AgentCopy = chineseMessages.AgentCopy
