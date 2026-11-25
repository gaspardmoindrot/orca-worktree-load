// The right-sidebar panel (an html panel: Orca wraps this module in a page). The worker posts a
// snapshot after every sample; this draws it with src/view.ts and handles clicks.
import type { PanelPayload } from './model'
import { buildView, CSS, render, stopText, type Confirm, type Row, type View } from './view'

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

let view: View | null = null
const open = new Set<string>()
let showGone = false
let showIdle = false
let confirm: Confirm | null = null
let busy: string | null = null
let notice: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let last = ''

function draw(): void {
  if (!view) {
    root.innerHTML = '<p class="empty">Measuring…</p>'
    return
  }
  const html = render(view, { open, showGone, showIdle, confirm, busy, notice })
  // Only touch the page when something changed, so bars animate and hover stays put.
  if (html !== last) {
    root.innerHTML = html
    last = html
  }
}

function receive(payload: unknown): void {
  view = buildView(payload as PanelPayload)
  draw()
}

function allRows(v: View): Row[] {
  return [...v.orca, ...v.other, ...v.gone]
}

function ask(id: string, rows: Row[], what: string): void {
  if (rows.length === 0) return
  const keepShells = rows.some((r) => !r.gone) ? ' Terminals stay open.' : ''
  confirm = { id, keys: rows.map((r) => r.key), text: `${rows.length > 1 ? `${what}: stop ` : 'Stop '}${stopText(rows)}?${keepShells}` }
}

function say(text: string): void {
  notice = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice = null
    draw()
  }, 6000)
}

async function runStop(): Promise<void> {
  if (!confirm) return
  const current = confirm
  busy = current.id
  draw()
  try {
    const result = (await orca.plugin.request('load.stop', { keys: current.keys })) as { processes: number; containers: number; failed: string[] }
    const parts = [result.processes ? `${result.processes} processes` : '', result.containers ? `${result.containers} containers` : ''].filter(Boolean)
    const done = `Stopped ${parts.join(' and ') || 'nothing'}.`
    say(result.failed.length ? `${done} Failed: ${result.failed[0]}` : done)
  } catch (error) {
    say(`Could not stop: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    busy = null
    confirm = null
    draw()
  }
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button')
  if (!target || !view || busy) return
  const attr = (name: string) => target.getAttribute(name)
  if (attr('data-toggle') !== null) {
    const key = attr('data-toggle')!
    if (open.has(key)) open.delete(key)
    else open.add(key)
  } else if (attr('data-stop') !== null) {
    const row = allRows(view).find((r) => r.key === attr('data-stop'))
    if (row) ask(`row:${row.key}`, [row], row.name)
  } else if (attr('data-stop-section') !== null) {
    const id = attr('data-stop-section')!
    const list = id === 'orca' ? view.orca : id === 'other' ? view.other : view.gone
    ask(`section:${id}`, list, id === 'gone' ? `${list.length} Docker stacks` : `${list.length} worktrees`)
  } else if (target.hasAttribute('data-confirm')) {
    void runStop()
    return
  } else if (target.hasAttribute('data-cancel')) {
    confirm = null
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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && confirm && !busy) {
    confirm = null
    draw()
  }
})

orca.plugin.on('load.snapshot', receive)
void orca.plugin.request('load.get').then(receive)
draw()
