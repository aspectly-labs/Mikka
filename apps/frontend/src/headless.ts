// This repository is Mikka's engine, API and runtime; it carries no product
// interface (decisions 2026-11-22-2205 and 2026-11-24-1000). The official build
// compiles the private UI checkout instead (lib/ui-overlay.mjs). A build without
// it serves this page, so a server built from this repository alone answers a
// browser plainly. A desktop test build without it (apps/desktop/scripts/build.mjs
// refuses a production one) shows the same page in the window, and the native
// acceptance checks the shell around it (apps/desktop/test/bundled-smoke.mjs).
const root = document.getElementById('root')
const desktop = 'mikka' in window
const chinese = document.documentElement.lang.startsWith('zh')
document.documentElement.dataset.mikkaHeadless = 'true'
if (root) {
  document.title = 'Mikka'
  root.setAttribute('role', 'main')
  root.style.cssText = 'font: 15px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 20vh auto; padding: 0 1.5rem'
  const heading = document.createElement('h1')
  heading.style.cssText = 'font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem'
  heading.textContent = desktop
    ? chinese ? '这个测试版没有界面' : 'This test build has no interface'
    : chinese ? '这台服务器没有网页界面' : 'This server has no web interface'
  const body = document.createElement('p')
  body.style.margin = '0'
  body.textContent = desktop
    ? chinese ? '请从 Mikka 官网下载正式版。' : 'Download Mikka from its website.'
    : chinese ? '请在 Mikka App 里连接这台服务器。' : 'Connect to it from the Mikka app.'
  root.replaceChildren(heading, body)
}
export {}
