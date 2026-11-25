import { assert, test } from 'orca/testing'
import { classify, containerOwner, isRunning, mcpName, parseCpuTime, parseDockerPs, parseDockerStats, parseLsof, parsePs, parseTop, DOCKER_VM, ORCA_APP, OTHER } from './model'
import { DOCKER_PS, DOCKER_STATS, LSOF, owners, PS, resolver, snapshot, TOP } from './fixtures'

const MB = 2 ** 20

test('parses ps, top, lsof and docker', () => {
  assert.equal(parseCpuTime('1-02:03:04.50'), 86400 + 7384.5)
  assert.equal(parseCpuTime('5:00.00'), 300)
  const procs = parsePs(PS)
  assert.equal(procs.length, 14)
  assert.deepEqual(procs[4], { pid: 201, ppid: 200, cpuSeconds: 300, rss: 300000 * 1024, command: 'claude' })
  const top = parseTop(TOP)
  assert.equal(top.footprints.get(203), 700 * MB)
  assert.equal(top.physUsed, 19 * 2 ** 30)
  assert.equal(parseLsof(LSOF).get(203), '/w/api')
  assert.equal(parseDockerPs(DOCKER_PS)[0].workingDir, '/w/api/docker')
  assert.equal(parseDockerStats(DOCKER_STATS).get('c1')?.memory, 300 * MB)
})

test('gives each process to its worktree, by working directory then by parent', () => {
  const o = owners()
  assert.equal(o.get(201), '/w/api', 'cwd in a subfolder')
  assert.equal(o.get(202), '/w/api', 'an MCP server with cwd "/" inherits from its agent')
  assert.equal(o.get(203), '/w/api')
  assert.equal(o.get(301), '/Users/me/.worktrees/repo/agent-1', 'a checkout Orca does not manage')
  assert.equal(o.get(100), ORCA_APP)
  assert.equal(o.get(101), ORCA_APP)
  assert.equal(o.get(400), DOCKER_VM)
  assert.equal(o.get(401), DOCKER_VM, "the Virtualization.framework VM, while Docker runs")
  assert.equal(o.get(500), OTHER)
})

test('classifies processes and names MCP servers', () => {
  assert.equal(classify('claude'), 'agent')
  assert.equal(classify('claude mcp serve'), 'agent', 'an agent first, even when it talks about MCP')
  assert.equal(classify('node /Users/me/.claude/local/claude'), 'agent')
  assert.equal(classify('node /x/node_modules/.bin/mcp-server-github'), 'mcp')
  assert.equal(classify('node /w/api/node_modules/.bin/vite'), 'dev-server')
  assert.equal(classify('node /w/api/node_modules/.bin/vitest run'), 'test')
  assert.equal(classify('-zsh'), 'shell')
  assert.equal(classify('/usr/bin/tsc -b'), 'build')
  assert.equal(classify('tmux new -s api'), 'shared')
  assert.equal(classify('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'), 'shared')
  assert.equal(mcpName('node /r/node_modules/.pnpm/@playwright+mcp@0.0.83/node_modules/@playwright/mcp/cli.js'), 'Playwright')
  assert.equal(mcpName('node scripts/playwright/mcp.mts --headless'), 'Playwright')
  assert.equal(mcpName('node /x/.bin/mcp-server-github'), 'Github')
})

test('adds up each worktree: processes by kind, agents and MCP servers by name', () => {
  const api = snapshot().worktrees.find((w) => w.key === '/w/api')!
  assert.equal(api.name, 'api')
  assert.equal(api.orca, true)
  assert.equal(api.processes, 6)
  assert.equal(api.cpu, 70)
  // The footprint when top has it, RSS otherwise.
  assert.equal(api.memory, 5000 * 1024 + 350 * MB + 80000 * 1024 + 700 * MB + 3000 * 1024 + 90000 * 1024)
  assert.deepEqual(api.agents, { Claude: 1 })
  assert.deepEqual(api.mcp, { Github: 1 })
  assert.equal(api.kinds['dev-server']?.memory, 700 * MB)
  const agent = snapshot().worktrees.find((w) => w.key.endsWith('agent-1'))!
  assert.equal(agent.orca, false)
  assert.equal(agent.repo, 'repo')
  assert.ok(snapshot().worktrees.some((w) => w.key === '/w/idle' && !isRunning(w)), 'idle Orca worktrees are listed')
})

test('counts containers under their worktree, once, and leaves the VM overhead in the Docker row', () => {
  const s = snapshot()
  const api = s.worktrees.find((w) => w.key === '/w/api')!
  assert.deepEqual(api.docker.containers.map((c) => c.name), ['api-postgres-1', 'shared-db-2'])
  assert.equal(api.docker.memory, 350 * MB, 'what docker stats says the containers use')
  assert.equal(api.docker.cpu, 2)
  const gone = s.worktrees.find((w) => w.key === 'docker:agent-9')!
  assert.equal(gone.gone, true)
  assert.equal(gone.docker.memory, 100 * MB)
  // 40 MB of helpers + 2000 MB VM − 500 MB counted in container rows.
  assert.equal(s.dockerVm.memory, 1540 * MB)
  assert.deepEqual(containerOwner({ workingDir: '', project: 'x' }, resolver), null, 'no compose folder: stays in the Docker row')
})
