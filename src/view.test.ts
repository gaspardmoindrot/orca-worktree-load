import { assert, test } from 'orca/testing'
import { buildView, bytes, render, statusBar, stopText, type UiState } from './view'
import { snapshot } from './fixtures'

const ui: UiState = { open: new Set(), showGone: false, showIdle: false, busy: null, notice: null }

test('splits worktrees into Orca, other checkouts and leftover Docker stacks', () => {
  const v = buildView(snapshot())
  assert.deepEqual(v.orca.map((r) => r.name), ['api'])
  assert.deepEqual(v.other.map((r) => r.name), ['agent-1'])
  assert.deepEqual(v.gone.map((r) => r.name).sort(), ['agent-9', 'shared'])
  assert.deepEqual(v.idle, ['idle one'])
  const api = v.orca[0]
  assert.equal(api.summary, '1 Claude · dev server · 1 MCP server · 2 containers')
  assert.equal(api.cpu, '7% CPU', '70% of one core on 10 cores')
  assert.equal(v.other[0].cpu, null, 'quiet worktrees show no CPU')
  assert.equal(v.segments.reduce((n, s) => n + s.bytes, 0), 19 * 2 ** 30, 'the bar adds up to the memory macOS reports as used')
})

test('says what a stop ends, in words', () => {
  const v = buildView(snapshot())
  assert.equal(stopText([v.orca[0]]), '1 Claude session, 1 MCP server, 1 dev server and 2 containers')
  assert.equal(stopText([]), 'nothing')
})

test('the status bar counts the same worktrees as the panel', () => {
  const bar = statusBar(buildView(snapshot()))
  assert.match(bar.text, / in 2 worktrees$/)
  assert.equal(bar.tone, 'warning')
  assert.match(bar.tooltip, /^Heaviest: api /)
})

test('renders rows, the leftover Docker warning, an open row and a running stop', () => {
  const v = buildView(snapshot())
  const closed = render(v, ui)
  assert.match(closed, /2 Docker stacks left running/)
  assert.match(closed, /Orca worktrees/)
  assert.ok(!closed.includes('Open in Orca'))
  const opened = render(v, { ...ui, open: new Set(['/w/api']), showGone: true, showIdle: true })
  assert.match(opened, /Open in Orca/)
  assert.match(opened, /Claude sessions/)
  assert.match(opened, /MCP · Github/)
  assert.match(opened, /idle one/)
  assert.match(render(v, { ...ui, busy: 'row:/w/api' }), /aria-label="Stopping"/)
  assert.ok(!render(v, { ...ui, open: new Set(['<x>']) }).includes('<x>'))
})

test('formats bytes', () => {
  assert.equal(bytes(270 * 2 ** 20), '270 MB')
  assert.equal(bytes(7.46 * 2 ** 30), '7.5 GB')
  assert.equal(bytes(17.7 * 2 ** 30), '18 GB')
})
