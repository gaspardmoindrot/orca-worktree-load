// Draws the README and catalog images from the real panel view, fed with invented sample data.
//   npm run shoot        (needs Google Chrome installed; writes assets/*.png)
// Every image shows tools/sample-data.json, never a real machine.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sample = JSON.parse(readFileSync(join(root, 'tools/sample-data.json'), 'utf8'))
const bundle = execFileSync('npx', ['esbuild', 'tools/scene.ts', '--bundle', '--format=iife', '--global-name=Scene', '--log-level=warning'], {
  cwd: root,
  encoding: 'utf8'
})
const icon = readFileSync(join(root, 'assets/icon.png')).toString('base64')

// Orca's default theme tokens (src/renderer/src/assets/main.css in stablyai/orca).
const TOKENS = {
  dark: { background: '#0a0a0a', foreground: '#f0f0f0', muted: '#262626', 'muted-foreground': '#acacac', accent: '#404040', border: 'rgb(255 255 255 / 0.07)', ring: '#737373', destructive: '#ff6568' },
  light: { background: '#ffffff', foreground: '#0a0a0a', muted: '#f5f5f5', 'muted-foreground': '#696969', accent: '#f5f5f5', border: '#e5e5e5', ring: '#a1a1a1', destructive: '#e40014' }
}
const STAGE = {
  dark: { bg: '#151515', fg: '#f0f0f0', muted: '#9a9a9a', frame: 'rgb(255 255 255 / 0.08)' },
  light: { bg: '#f3f3f3', fg: '#0a0a0a', muted: '#6b6b6b', frame: '#e2e2e2' }
}
const OPEN = 'feat/checkout-redesign'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function panel(theme, state, width, height) {
  const html = globalThis.Scene.panelHtml(sample, state, theme, TOKENS[theme])
  return `<iframe style="width:${width}px;height:${height}px;border:1px solid ${STAGE[theme].frame};border-radius:12px;background:${TOKENS[theme].background};box-shadow:0 20px 50px rgb(0 0 0 / ${theme === 'dark' ? 0.45 : 0.12})" srcdoc="${esc(html)}"></iframe>`
}

function page(theme, body) {
  const s = STAGE[theme]
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;width:100vw;height:100vh;overflow:hidden;background:${s.bg};color:${s.fg};font-family:-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
    .muted{color:${s.muted}}
  </style></head><body>${body}</body></html>`
}

// The panel's view code is plain functions; run the bundle once in Node to get them.
new Function(bundle.replace('var Scene', 'globalThis.Scene'))()
const openKey = sample.worktrees.find((w) => w.branch === OPEN)?.key

const scenes = [
  {
    file: 'assets/cover.png',
    size: [800, 500],
    html: page(
      'dark',
      `<div style="display:flex;height:100%;align-items:center;gap:44px;padding:0 0 0 64px">
        <div style="flex:1;min-width:0">
          <img src="data:image/png;base64,${icon}" width="64" height="64" style="border-radius:14px">
          <div style="font-size:34px;font-weight:650;letter-spacing:-.02em;margin-top:22px">Worktree Load</div>
          <div class="muted" style="font-size:16px;line-height:1.45;margin-top:10px;max-width:330px">What each worktree costs your Mac. Agents, MCP servers, dev servers and Docker, with a Stop button for each one.</div>
        </div>
        <div style="align-self:flex-end;margin-bottom:-14px">${panel('dark', { showIdle: false }, 340, 470)}</div>
      </div>`
    )
  },
  ...['dark', 'light'].map((theme) => ({
    file: `assets/screenshot-${theme}.png`,
    size: [1280, 800],
    html: page(
      theme,
      `<div style="display:flex;justify-content:center;align-items:flex-start;gap:40px;padding-top:56px;height:100%">
        <figure style="margin:0"><figcaption class="muted" style="font-size:14px;margin:0 0 12px 4px">Every worktree, heaviest first</figcaption>${panel(theme, {}, 400, 700)}</figure>
        <figure style="margin:0"><figcaption class="muted" style="font-size:14px;margin:0 0 12px 4px">Open one to see where its memory goes</figcaption>${panel(theme, { open: new Set([openKey]), showGone: true }, 400, 700)}</figure>
      </div>`
    )
  }))
]

const browser = await chromium.launch({ channel: 'chrome' })
for (const scene of scenes) {
  const p = await browser.newPage({ viewport: { width: scene.size[0], height: scene.size[1] }, deviceScaleFactor: 2 })
  await p.setContent(scene.html, { waitUntil: 'load' })
  await p.waitForTimeout(200)
  await p.screenshot({ path: join(root, scene.file) })
  await p.close()
  console.log(scene.file)
}
await browser.close()
