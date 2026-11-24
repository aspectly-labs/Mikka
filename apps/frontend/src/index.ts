// Runtime selection happens before the application is imported. Web
// instrumentation installs deployment-aware fetch and analytics first. The
// application is the official UI checkout's core/renderer, or the headless page
// when this repository is built alone (lib/ui-overlay.mjs).
import 'mikka:frontend-runtime'
await import('mikka:application')
