import { assert, test } from 'orca/testing'
import { planStop, stillSame } from './stop'
import { containers, owners, procs, resolver } from './fixtures'

const plan = (keys: string[], protectedPids = new Set<number>()) =>
  planStop({ keys, procs: procs(), owners: owners(), containers: containers(), resolver, protectedPids })

test('stops agents, MCP and dev servers; never shells, tmux, build daemons or protected PIDs', () => {
  const [api] = plan(['/w/api'], new Set([203]))
  assert.deepEqual(api.processes.map((p) => p.pid), [201, 202], 'not zsh 200, tmux 210, the Gradle daemon 211, nor the protected 203')
  assert.deepEqual(api.containers, ['c1', 'c4'])
  assert.deepEqual(api.projects, [])
})

test('takes a stack down only when every container of its project is in a deleted folder', () => {
  const [gone] = plan(['docker:agent-9'])
  assert.deepEqual(gone.projects, ['agent-9'])
  assert.deepEqual(gone.containers, [])
  const [shared] = plan(['docker:shared'])
  assert.deepEqual(shared.projects, [], '"shared" still has a container in /w/api')
  assert.deepEqual(shared.containers, ['c3'], 'so only its own container is stopped')
})

test('never signals a PID that now runs something else', () => {
  const planned = [{ pid: 201, command: 'claude' }, { pid: 202, command: 'node mcp' }]
  const now = [
    { pid: 201, ppid: 1, cpuSeconds: 0, rss: 0, command: 'claude' },
    { pid: 202, ppid: 1, cpuSeconds: 0, rss: 0, command: 'vim' }
  ]
  assert.deepEqual(stillSame(planned, now), [201])
})
