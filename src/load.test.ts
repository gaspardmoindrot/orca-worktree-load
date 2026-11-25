import { assert, test } from 'orca/testing'
import { crossings, merge, parseShortstat, sparkline, statusBar } from './load'
import { diag, HOST, ps } from './fixtures'

test('merges CPU/RAM from diagnostics into every non-archived worktree', () => {
  const rows = merge(diag, ps, { '/w/api': { diskBytes: 1024 } }, { 'r::/w/api': { cpu: [50], mem: [1] } })
  assert.deepEqual(rows.map((r) => r.name), ['api', 'docs', 'idle'])
  const api = rows[0]
  assert.equal(api.branch, 'feat/api')
  assert.equal(api.cpu, 170)
  assert.deepEqual(api.agents, { working: 1, waiting: 1, done: 0, total: 2 })
  assert.deepEqual(api.cpuHistory, [50, 170])
  assert.equal(api.disk.diskBytes, 1024)
  assert.equal(rows[2].processes, 0)
  assert.equal(rows[2].cpu, 0)
})

test('status bar sums the load and warns on a heavy worktree', () => {
  const s = { at: 1, host: HOST, totalCpu: 180, totalMemory: 5 * 2 ** 30, worktrees: merge(diag, ps, {}, {}) }
  const bar = statusBar(s, { cpu: 150, memoryMb: 4096 })
  assert.equal(bar.text, '180% · 5.0 GB · 2/3 live · 1 working')
  assert.equal(bar.tone, 'warning')
  assert.match(bar.tooltip, /api: 170% · 4\.5 GB/)
})

test('notifies once, on the third heavy poll in a row', () => {
  const rows = merge(diag, ps, {}, {})
  const t = { cpu: 150, memoryMb: 4096 }
  let streaks = {}
  const alerts: string[][] = []
  for (let i = 0; i < 5; i++) {
    const c = crossings(rows, t, streaks, 3)
    streaks = c.streaks
    alerts.push(c.alert.map((w) => w.name))
  }
  assert.deepEqual(alerts, [[], [], ['api'], [], []])
})

test('parses git shortstat and draws a sparkline', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 120 insertions(+), 7 deletions(-)\n'), { diffFiles: 3, diffAdded: 120, diffRemoved: 7 })
  assert.deepEqual(parseShortstat(''), { diffFiles: 0, diffAdded: 0, diffRemoved: 0 })
  assert.equal(sparkline([0, 50, 100], 100), '▁▅█')
})
