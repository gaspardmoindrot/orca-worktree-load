import { assert, test } from 'orca/testing'
import { attribute, parseLsof, parsePs, parseTop, rollUp, type Resolver } from './model'
import { buildView, bytes, render, stopText } from './view'
import { LSOF, PS, TOP } from './fixtures'

const resolver: Resolver = {
  rootFor: (dir) => (dir.startsWith('/w/api') ? '/w/api' : dir.startsWith('/Users/me/.worktrees/repo/agent-1') ? '/Users/me/.worktrees/repo/agent-1' : null),
  exists: (dir) => !dir.startsWith('/gone')
}

function payload() {
  const procs = parsePs(PS)
  const s = rollUp({
    procs,
    owners: attribute(procs, parseLsof(LSOF), resolver, '/Users/me'),
    cpu: new Map([[201, 300], [203, 20]]),
    memory: parseTop(TOP).footprints,
    orcaWorktrees: [
      { id: 'ws-api', name: 'api', project: 'demo', path: '/w/api', branch: 'feat/api', state: 'working' },
      { id: 'ws-idle', name: 'idle one', project: 'demo', path: '/w/idle', branch: null, state: null }
    ],
    containers: [
      { id: 'c1', name: 'api-postgres-1', project: 'api', workingDir: '/w/api/docker', cpu: 1, memory: 300 * 2 ** 20 },
      { id: 'c2', name: 'agent-9-redis-1', project: 'agent-9', workingDir: '/gone/agent-9/docker', cpu: 1, memory: 100 * 2 ** 20 }
    ],
    resolver,
    machine: { memoryTotal: 24 * 2 ** 30, memoryUsed: 19 * 2 ** 30, pressure: 'normal', cores: 10, load1: 2, cpu: 300 },
    at: 1
  })
  return { ...s, trends: {} }
}

test('splits worktrees into Orca, other checkouts and leftover Docker', () => {
  const v = buildView(payload())
  assert.deepEqual(v.orca.map((r) => r.name), ['api'])
  assert.deepEqual(v.other.map((r) => r.name), ['agent-1'])
  assert.deepEqual(v.gone.map((r) => r.name), ['agent-9'])
  assert.deepEqual(v.idle, ['idle one'])
  const api = v.orca[0]
  assert.equal(api.summary, '1 Claude · dev server · 1 MCP server · 1 container')
  assert.equal(api.cpu, '32% CPU', 'busy: 320% of one core on 10 cores')
  assert.equal(v.other[0].cpu, null, 'quiet worktrees show no CPU')
  assert.equal(api.groups[0].label, 'Docker')
  const sum = v.segments.reduce((n, s) => n + s.bytes, 0)
  assert.equal(sum, 19 * 2 ** 30, 'the bar adds up to the memory macOS reports as used')
})

test('renders rows, the leftover Docker warning, an open row and a stop to confirm', () => {
  const v = buildView(payload())
  const base = { open: new Set<string>(), showGone: false, showIdle: false, confirm: null, busy: null, notice: null }
  const closed = render(v, base)
  assert.match(closed, /1 Docker stack left running/)
  assert.match(closed, /Orca worktrees/)
  assert.ok(!closed.includes('Open in Orca'))
  const opened = render(v, { ...base, open: new Set(['/w/api']), showGone: true, showIdle: true })
  assert.match(opened, /Open in Orca/)
  assert.match(opened, /Claude sessions/)
  assert.match(opened, /idle one/)
  const api = v.orca[0]
  assert.equal(stopText([api]), '1 Claude session, 1 MCP server, 1 dev server and 1 container', 'never the shell')
  const asking = render(v, { ...base, confirm: { id: 'row:/w/api', keys: ['/w/api'], text: 'Stop api: 3 processes and 1 container?' } })
  assert.match(asking, /data-confirm/)
  assert.ok(!render(v, { ...base, open: new Set(['<x>']) }).includes('<x>'))
})

test('formats bytes', () => {
  assert.equal(bytes(270 * 2 ** 20), '270 MB')
  assert.equal(bytes(7.46 * 2 ** 30), '7.5 GB')
  assert.equal(bytes(17.7 * 2 ** 30), '18 GB')
})
