// Runs src/worker.ts over a mock host, with ps/top/lsof/docker swapped for canned output.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { DOCKER_PS, DOCKER_STATS, LSOF, PS, TOP } from './fixtures'

test('samples, updates the status bar and answers the panel', async () => {
  const seen: string[] = []
  main.setRunner(async (bin, args) => {
    const name = bin.split('/').pop()!
    seen.push(name)
    if (name === 'ps') return PS
    if (name === 'top') return TOP
    if (name === 'lsof') return LSOF
    if (name === 'sysctl') return '2\n'
    if (name === 'docker') return args[0] === 'ps' ? DOCKER_PS : args[0] === 'stats' ? DOCKER_STATS : ''
    throw new Error(`unexpected ${bin}`)
  })
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'notifications:show', 'settings:own'],
    settings: { intervalSeconds: 300 },
    results: {
      'workspace.open': { opened: true },
      'notifications.show': { delivered: true },
      'workspace.list': {
        workspaces: [{ id: 'ws-api', kind: 'worktree', name: 'api', project: 'demo', path: '/w/api', branch: 'feat/api', hostId: null, status: { state: 'working', unread: false, terminalCount: 1, lastActivityAt: null } }],
        truncated: false
      }
    }
  })
  main.setFirstGap(0)
  main.setKillAfter(0)
  const signals: string[] = []
  main.setSignal((pid, sig) => (signals.push(`${sig} ${pid}`), true))
  const worker = await mountWorker(main, { host })
  try {
    const s = await worker.request('load.refresh')
    const api = s.worktrees.find((w) => w.key === '/w/api')
    assert.ok(api, 'the Orca worktree is there')
    assert.equal(api!.agentState, 'working')
    assert.equal(s.machine.pressure, 'warning')
    assert.ok(seen.includes('lsof') && seen.includes('top'))
    assert.match(String((worker.host.callsOf('statusBar.update').at(-1) as { text: string }).text), /worktrees/)
    assert.equal(worker.host.callsOf('notifications.show').length, 1, 'one alert for the pressure episode')
    assert.deepEqual(await worker.request('load.open', { path: '/w/api' }), { opened: true })
    assert.deepEqual(worker.host.callsOf('workspace.open').at(-1), { workspaceId: 'ws-api' })
    const result = await worker.request('load.stop', { keys: ['/w/api'] })
    assert.equal(result.processes, 3, 'claude, its MCP server and vite; never the shell')
    assert.deepEqual(signals.filter((s) => s.startsWith('SIGTERM')).sort(), ['SIGTERM 201', 'SIGTERM 202', 'SIGTERM 203'])
    assert.ok(seen.includes('docker'))
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})
