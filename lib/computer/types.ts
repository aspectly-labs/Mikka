/** Shared browser/server computer contract. */
export * from '@mikka/protocol/computer'

export type SetupStep = 'login' | 'check' | 'install' | 'start' | 'connect'
export type SetupStepState = 'idle' | 'active' | 'done' | 'failed'
export const SETUP_STEPS: SetupStep[] = ['login', 'check', 'install', 'start', 'connect']
