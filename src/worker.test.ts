// Runs src/worker.ts over a mock host, with the CLI calls swapped for canned JSON.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { diag, ps } from './fixtures'

test('polls the CLI, updates the status bar and answers the panel', async () => {
  const calls: string[] = []
  main.setRunner(async (bin, args) => {
    calls.push(`${bin.split('/').pop()} ${args.join(' ')}`)
    if (args[0] === 'diagnostics') return JSON.stringify({ ok: true, result: diag })
    if (args[0] === 'worktree') return JSON.stringify({ ok: true, result: { worktrees: ps } })
    if (args[0] === 'diff') return ' 1 file changed, 2 insertions(+)\n'
    if (args[0] === '-sk') return `2048\t${args[1]}\n`
    throw new Error('unexpected')
  })
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'notifications:show', 'settings:own'],
    settings: { intervalSeconds: 300, diskMinutes: 10 },
    results: { 'workspace.open': { opened: true }, 'workspace.list': { workspaces: [{ id: 'ws-api', kind: 'worktree', name: 'api', path: '/w/api', branch: 'feat/api', hostId: null }], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  try {
  const snap = await worker.request('load.refresh')
  assert.equal(snap.worktrees.length, 3)
  assert.equal(snap.worktrees[0].cpu, 170)
  const bars = worker.host.callsOf('statusBar.update')
  assert.ok(bars.length > 0)
  assert.match(String((bars.at(-1) as { text: string }).text), /180%/)
  assert.ok(calls.some((c) => c.startsWith('orca diagnostics memory')))
  assert.deepEqual(await worker.request('load.open', { path: '/w/api' }), { opened: true })
  assert.deepEqual(worker.host.callsOf('workspace.open').at(-1), { workspaceId: 'ws-api' })
  assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})
