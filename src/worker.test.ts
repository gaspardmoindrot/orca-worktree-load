// Runs src/worker.ts over a mock host, with every system call replaced: commands return canned
// output and signals are recorded, never sent.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { useSystem } from './system'
import { DOCKER_PS, DOCKER_STATS, LSOF, PS, TOP } from './fixtures'

test('samples, updates the status bar, answers the panel and stops a worktree', async () => {
  const ran: string[] = []
  const signals: string[] = []
  useSystem({
    run: async (bin, args) => {
      const name = bin.split('/').pop()!
      ran.push(`${name} ${args[0]}`)
      if (name === 'ps') return PS
      if (name === 'top') return TOP
      if (name === 'lsof') return LSOF
      if (name === 'sysctl') return '2\n'
      if (name === 'docker') return args[0] === 'ps' ? DOCKER_PS : args[0] === 'stats' ? DOCKER_STATS : ''
      throw new Error(`unexpected ${bin}`)
    },
    signal: (pid, sig) => (signals.push(`${sig} ${pid}`), true),
    sleep: async () => undefined
  }, { docker: '/usr/local/bin/docker' })
  main.testing.fast = true
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'settings:own'],
    settings: { intervalSeconds: 300 },
    results: {
      'workspace.open': { opened: true },
      'workspace.list': { workspaces: [{ id: 'ws-api', kind: 'worktree', name: 'api', project: 'demo', path: '/w/api', branch: 'feat/api', hostId: null }], truncated: false }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    const s = await worker.request('load.get')
    assert.ok(s.worktrees.some((w) => w.key === '/w/api' && w.orca), 'the Orca worktree is there')
    assert.equal(s.machine.pressure, 'warning')
    assert.match(String((worker.host.callsOf('statusBar.update').at(-1) as { text: string }).text), / in \d+ worktrees?$/)
    assert.equal(worker.host.callsOf('notifications.show').length, 0, 'no notification, even under memory pressure')

    assert.deepEqual(await worker.request('load.open', { path: '/w/api' }), { opened: true })
    assert.deepEqual(worker.host.callsOf('workspace.open').at(-1), { workspaceId: 'ws-api' })

    assert.deepEqual(await worker.request('load.stop', { keys: ['@other'] }), { processes: 0, containers: 0, failed: [] }, 'only worktree keys are accepted')
    const result = await worker.request('load.stop', { keys: ['/w/api'] })
    assert.equal(result.processes, 3, 'claude, its MCP server and vite')
    assert.deepEqual(signals.filter((x) => x.startsWith('SIGTERM')).sort(), ['SIGTERM 201', 'SIGTERM 202', 'SIGTERM 203'])
    assert.ok(ran.includes('docker stop'))
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    useSystem()
    main.testing.fast = false
  }
})
