// The right-sidebar panel (an html panel: Orca wraps this module in a page). The worker posts a
// snapshot after every sample; this draws it with src/view.ts and handles clicks.
import type { Snapshot } from './model'
import { buildView, CSS as PANEL_CSS, render, renderError, stopText, type Row, type View } from './view'

declare const orca: {
  plugin: {
    request(name: string, input?: unknown): Promise<unknown>
    on(event: string, handler: (payload: unknown) => void): { dispose(): void }
  }
}

const style = document.createElement('style')
style.textContent = PANEL_CSS
document.head.append(style)
const root = document.createElement('main')
document.body.append(root)

let view: View | null = null
let error: string | null = null
const open = new Set<string>()
let showGone = false
let showIdle = false
let busy: string | null = null
let notice: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let pointerDown = false
let drawn = ''

const FOCUS_ATTRS = ['data-toggle', 'data-stop', 'data-stop-section', 'data-open', 'data-show-gone', 'data-show-idle']

function draw(): void {
  // A redraw between mousedown and mouseup would swallow the click: wait for the mouseup.
  if (pointerDown) return
  const html = view ? render(view, { open, showGone, showIdle, busy, notice }) : error ? renderError(error) : '<p class="empty">Measuring…</p>'
  if (html === drawn) return
  // Keep keyboard focus on the same button across the redraw.
  const focused = document.activeElement?.closest('button')
  const attr = focused ? FOCUS_ATTRS.find((a) => focused.hasAttribute(a)) : undefined
  const selector = focused && attr ? `[${attr}="${CSS.escape(focused.getAttribute(attr) ?? '')}"]` : null
  root.innerHTML = html
  drawn = html
  if (selector) root.querySelector<HTMLElement>(selector)?.focus()
}

function receive(payload: unknown): void {
  view = buildView(payload as Snapshot)
  draw()
}

function say(text: string): void {
  notice = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice = null
    draw()
  }, 6000)
}

async function stop(id: string, rows: Row[]): Promise<void> {
  if (rows.length === 0 || busy) return
  const what = stopText(rows)
  busy = id
  draw()
  try {
    const result = (await orca.plugin.request('load.stop', { keys: rows.map((r) => r.key) })) as { processes: number; containers: number; failed: string[] }
    const done = result.processes || result.containers ? `Stopped ${what}.` : 'Nothing left to stop.'
    say(result.failed.length ? `${done} Failed: ${result.failed[0]}` : done)
  } catch (e) {
    say(`Could not stop: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busy = null
    draw()
  }
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button')
  if (!target || !view) return
  const attr = (name: string) => target.getAttribute(name)
  if (attr('data-toggle') !== null) {
    const key = attr('data-toggle')!
    if (open.has(key)) open.delete(key)
    else open.add(key)
  } else if (attr('data-stop') !== null) {
    const row = [...view.orca, ...view.other].find((r) => r.key === attr('data-stop'))
    if (row) void stop(`row:${row.key}`, [row])
    return
  } else if (attr('data-stop-section') !== null) {
    const id = attr('data-stop-section')!
    void stop(`section:${id}`, id === 'orca' ? view.orca : id === 'other' ? view.other : view.gone)
    return
  } else if (attr('data-open') !== null) {
    void orca.plugin.request('load.open', { path: attr('data-open') })
    return
  } else if (target.hasAttribute('data-show-gone')) {
    showGone = !showGone
  } else if (target.hasAttribute('data-show-idle')) {
    showIdle = !showIdle
  }
  draw()
})

document.addEventListener('pointerdown', () => (pointerDown = true))
document.addEventListener('pointerup', () => {
  pointerDown = false
  // Let the click land first, then catch up on what arrived meanwhile.
  setTimeout(draw)
})

orca.plugin.on('load.snapshot', receive)
orca.plugin.request('load.get').then(receive, (e: unknown) => {
  error = e instanceof Error ? e.message : String(e)
  draw()
})
draw()
