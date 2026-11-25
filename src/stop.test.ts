import { assert, test } from 'orca/testing'
import { attribute, parseLsof, parsePs, type Resolver } from './model'
import { planStop, stillSame } from './stop'
import { LSOF, PS } from './fixtures'

const resolver: Resolver = {
  rootFor: (dir) => (dir.startsWith('/w/api') ? '/w/api' : null),
  exists: (dir) => !dir.startsWith('/gone')
}
const containers = [
  { id: 'c1', name: 'api-postgres-1', project: 'api', workingDir: '/w/api/docker', cpu: 0, memory: 0 },
  { id: 'c2', name: 'agent-9-redis-1', project: 'agent-9', workingDir: '/gone/agent-9/docker', cpu: 0, memory: 0 }
]

test('stops agents, MCP and dev servers but keeps shells, Orca and this worker', () => {
  const procs = parsePs(PS)
  const owners = attribute(procs, parseLsof(LSOF), resolver, '/Users/me')
  const [api, gone] = planStop({ keys: ['/w/api', 'docker:agent-9'], procs, owners, containers, resolver, protectedPids: new Set([203]) })
  assert.deepEqual(api.processes.map((p) => p.pid), [201, 202], 'claude and its MCP server; not the zsh (200), not the protected 203')
  assert.deepEqual(api.containers, ['c1'])
  assert.deepEqual(api.projects, [])
  assert.deepEqual(gone.processes, [])
  assert.deepEqual(gone.projects, ['agent-9'], 'a stack whose worktree is gone is taken down')
})

test('never signals a PID that now runs something else', () => {
  const planned = [{ pid: 201, command: 'claude' }, { pid: 202, command: 'node mcp' }]
  assert.deepEqual(stillSame(planned, [{ pid: 201, ppid: 1, cpuSeconds: 0, rss: 0, command: 'claude' }, { pid: 202, ppid: 1, cpuSeconds: 0, rss: 0, command: 'vim' }]), [201])
})
