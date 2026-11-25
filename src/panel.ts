// The right-sidebar panel (an html panel: Orca wraps this module in a page). The worker posts a
// snapshot after every sample; this draws it with src/view.ts and handles clicks.
import type { PanelPayload } from './model'
import { buildView, CSS, render } from './view'

declare const orca: {
  plugin: {
    request(name: string, input?: unknown): Promise<unknown>
    on(event: string, handler: (payload: unknown) => void): { dispose(): void }
  }
}

const style = document.createElement('style')
style.textContent = CSS
document.head.append(style)
const root = document.createElement('main')
document.body.append(root)

let data: PanelPayload | null = null
let receivedAt = 0
const open = new Set<string>()
let showGone = false
let showIdle = false
let last = ''

function draw(): void {
  if (!data) {
    root.innerHTML = '<p class="empty">Measuring…</p>'
    return
  }
  const html = render(buildView(data), { open, showGone, showIdle, stale: Date.now() - receivedAt > 30_000 })
  // Only touch the page when something changed, so bar widths animate and hover stays put.
  if (html !== last) {
    root.innerHTML = html
    last = html
  }
}

function receive(payload: unknown): void {
  data = payload as PanelPayload
  receivedAt = Date.now()
  draw()
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button')
  if (!target) return
  const toggle = target.getAttribute('data-toggle')
  if (toggle !== null) {
    if (open.has(toggle)) open.delete(toggle)
    else open.add(toggle)
  } else if (target.hasAttribute('data-open')) {
    void orca.plugin.request('load.open', { path: target.getAttribute('data-open') })
    return
  } else if (target.hasAttribute('data-show-gone')) {
    showGone = !showGone
  } else if (target.hasAttribute('data-show-idle')) {
    showIdle = !showIdle
  }
  draw()
})

orca.plugin.on('load.snapshot', receive)
void orca.plugin.request('load.get').then(receive)
setInterval(draw, 10_000)
draw()
