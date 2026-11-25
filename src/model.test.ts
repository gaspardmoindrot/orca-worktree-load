import { assert, test } from 'orca/testing'
import { attribute, classify, parseCpuTime, parseDockerPs, parseDockerStats, parseLsof, parsePs, parseTop, record, rollUp, sparkline, statusBar, DOCKER_VM, ORCA_APP, OTHER, type Resolver } from './model'
import { DOCKER_PS, DOCKER_STATS, LSOF, PS, TOP } from './fixtures'

const resolver: Resolver = {
  rootFor: (dir) => (dir.startsWith('/w/api') ? '/w/api' : dir.startsWith('/Users/me/.worktrees/repo/agent-1') ? '/Users/me/.worktrees/repo/agent-1' : null),
  exists: (dir) => !dir.startsWith('/gone')
}
const orcaWorktrees = [{ id: 'ws-api', name: 'api', project: 'demo', path: '/w/api', branch: 'feat/api', state: 'working' }, { id: 'ws-idle', name: 'idle', project: 'demo', path: '/w/idle', branch: null, state: null }]

test('parses ps, top, lsof and docker', () => {
  assert.equal(parseCpuTime('1-02:03:04.50'), 86400 + 7384.5)
  assert.equal(parseCpuTime('5:00.00'), 300)
  const procs = parsePs(PS)
  assert.equal(procs.length, 12)
  assert.deepEqual(procs[4], { pid: 201, ppid: 200, cpuSeconds: 300, rss: 300000 * 1024, command: 'claude' })
  const top = parseTop(TOP)
  assert.equal(top.footprints.get(203), 700 * 2 ** 20)
  assert.equal(top.physUsed, 19 * 2 ** 30)
  assert.equal(parseLsof(LSOF).get(203), '/w/api')
  assert.equal(parseDockerPs(DOCKER_PS)[0].workingDir, '/w/api/docker')
  assert.equal(parseDockerStats(DOCKER_STATS).get('c1')?.memory, 300 * 2 ** 20)
})

test('gives each process to its worktree, by cwd then by parent', () => {
  const owners = attribute(parsePs(PS), parseLsof(LSOF), resolver, '/Users/me')
  assert.equal(owners.get(201), '/w/api') // cwd in a subfolder
  assert.equal(owners.get(202), '/w/api') // MCP server with cwd "/" inherits from claude
  assert.equal(owners.get(203), '/w/api')
  assert.equal(owners.get(301), '/Users/me/.worktrees/repo/agent-1') // a checkout Orca does not manage
  assert.equal(owners.get(100), ORCA_APP)
  assert.equal(owners.get(101), ORCA_APP)
  assert.equal(owners.get(400), DOCKER_VM)
  assert.equal(owners.get(401), DOCKER_VM) // the Virtualization.framework VM, while Docker runs
  assert.equal(owners.get(500), OTHER)
})

test('classifies processes', () => {
  assert.equal(classify('claude'), 'agent')
  assert.equal(classify('node /Users/me/.claude/local/claude'), 'agent')
  assert.equal(classify('node /x/node_modules/.bin/mcp-server-github'), 'mcp')
  assert.equal(classify('node /w/api/node_modules/.bin/vite'), 'dev-server')
  assert.equal(classify('node /w/api/node_modules/.bin/vitest run'), 'test')
  assert.equal(classify('-zsh'), 'shell')
  assert.equal(classify('/usr/bin/tsc -b'), 'build')
})

test('rolls up memory, CPU and Docker per worktree, without counting containers twice', () => {
  const procs = parsePs(PS)
  const owners = attribute(procs, parseLsof(LSOF), resolver, '/Users/me')
  const stats = parseDockerStats(DOCKER_STATS)
  const containers = parseDockerPs(DOCKER_PS).map((c) => ({ ...c, ...stats.get(c.id)! }))
  const s = rollUp({
    procs,
    owners,
    cpu: new Map([[201, 50], [203, 20], [401, 40]]),
    memory: parseTop(TOP).footprints,
    orcaWorktrees,
    containers,
    resolver,
    machine: { memoryTotal: 24 * 2 ** 30, memoryUsed: 19 * 2 ** 30, pressure: 'warning', cores: 18, load1: 6.5, cpu: 70 },
    at: 1_000_000
  })
  const api = s.worktrees.find((w) => w.key === '/w/api')!
  assert.equal(api.name, 'api')
  assert.equal(api.orca, true)
  assert.equal(api.processes, 4)
  assert.equal(api.cpu, 70)
  // footprint when top has it, RSS otherwise
  assert.equal(api.memory, 350 * 2 ** 20 + 700 * 2 ** 20 + 5000 * 1024 + 80000 * 1024)
  assert.equal(api.kinds.agent?.count, 1)
  assert.equal(api.kinds['dev-server']?.memory, 700 * 2 ** 20)
  assert.equal(api.docker.containers.length, 1)
  assert.equal(api.top[0].name, 'node vite')
  const agent = s.worktrees.find((w) => w.key.endsWith('agent-1'))!
  assert.equal(agent.orca, false)
  assert.equal(agent.repo, 'repo')
  assert.ok(s.worktrees.some((w) => w.key === '/w/idle' && w.processes === 0), 'idle Orca worktrees are listed')
  // The VM's 2000 MB footprint is split 3:1 by container memory; its 40% CPU 3:1 by container CPU.
  assert.equal(api.docker.memory, 1500 * 2 ** 20)
  assert.equal(api.docker.cpu, 30)
  const gone = s.worktrees.find((w) => w.gone)!
  assert.equal(gone.name, 'agent-9')
  assert.equal(gone.docker.memory, 500 * 2 ** 20)
  // What is left in the Docker row: the helper process (40 MB), not the 2000 MB already shared out.
  assert.equal(s.dockerVm.memory, 40 * 2 ** 20)

  const bar = statusBar(s)
  assert.equal(bar.tone, 'warning')
  assert.match(bar.text, /in 3 worktrees$/)

  let h = record({}, s, 30_000, 120)
  h = record(h, { ...s, at: 1_010_000 }, 30_000, 120)
  assert.equal(h['/w/api'].length, 1, 'two samples in one 30 s bucket are averaged')
  h = record(h, { ...s, at: 1_040_000 }, 30_000, 120)
  assert.equal(h['/w/api'].length, 2)
  assert.equal(sparkline([0, 50, 100], 100), '▁▅█')
})
