// Canned system output shared by the tests: an Orca worktree (/w/api) running an agent, an MCP
// server, a dev server, tmux and a Gradle daemon; a checkout Orca does not manage; Orca itself;
// Docker with a live stack and stacks whose folders are gone; and an unrelated app.
import { attribute, parseDockerPs, parseDockerStats, parseLsof, parsePs, parseTop, rollUp, type OrcaWorktree, type Resolver, type Snapshot } from './model'

export const PS = `
    1     0   10:00.00  10000 /sbin/launchd
  100     1    1:00.00 400000 /Applications/Orca.app/Contents/MacOS/Orca
  101   100    0:10.00  50000 /Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper
  200   100    0:01.00   5000 -zsh
  201   200    5:00.00 300000 claude
  202   201    0:30.00  80000 node /Users/me/.npm/_npx/x/node_modules/.bin/mcp-server-github
  203   200    2:00.00 600000 node /w/api/node_modules/.bin/vite
  210   200    0:01.00   3000 tmux new -s api
  211     1    0:10.00  90000 /usr/bin/java -cp gradle.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.5
  300   100    0:01.00   5000 -zsh
  301   300    0:05.00 200000 node /Users/me/.claude/local/claude
  400     1    3:00.00  17000 /Applications/Docker.app/Contents/MacOS/com.docker.virtualization --kernel x
  401     1   60:00.00 3000000 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
  500     1    0:20.00  90000 /Applications/Slack.app/Contents/MacOS/Slack
`
export const LSOF = [
  [200, '/w/api'],
  [201, '/w/api/src'],
  [202, '/'],
  [203, '/w/api'],
  [210, '/w/api'],
  [211, '/w/api'],
  [300, '/Users/me/.worktrees/repo/agent-1'],
  [301, '/Users/me/.worktrees/repo/agent-1'],
  [100, '/'],
  [500, '/']
]
  .map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}\n`)
  .join('')
export const TOP = `Processes: 14 total
PhysMem: 19G used (4012M wired, 3820M compressor), 280M unused.

PID    MEM
100    500M
201    350M
203    700M+
400    40M
401    2000M
`
// c3 and c4 share the compose project "shared": c3's folder is gone, c4's is in /w/api.
export const DOCKER_PS = [
  'c1\t/w/api/docker\tapi\tapi-postgres-1',
  'c2\t/gone/agent-9/docker\tagent-9\tagent-9-redis-1',
  'c3\t/gone/shared\tshared\tshared-db-1',
  'c4\t/w/api/shared\tshared\tshared-db-2'
].join('\n')
export const DOCKER_STATS = ['c1\t1.50%\t300MiB / 3.824GiB', 'c2\t0.50%\t100MiB / 3.824GiB', 'c3\t0.50%\t50MiB / 3.824GiB', 'c4\t0.50%\t50MiB / 3.824GiB'].join('\n')

export const resolver: Resolver = {
  rootFor: (dir) => ['/w/api', '/Users/me/.worktrees/repo/agent-1'].find((root) => dir === root || dir.startsWith(`${root}/`)) ?? null,
  exists: (dir) => !dir.startsWith('/gone')
}

export const orcaWorktrees: OrcaWorktree[] = [
  { id: 'ws-api', name: 'api', project: 'demo', path: '/w/api', branch: 'feat/api' },
  { id: 'ws-idle', name: 'idle one', project: 'demo', path: '/w/idle', branch: null }
]

export const procs = () => parsePs(PS)
export const owners = () => attribute(procs(), parseLsof(LSOF), resolver, '/Users/me')
export function containers() {
  const stats = parseDockerStats(DOCKER_STATS)
  return parseDockerPs(DOCKER_PS).map((c) => ({ ...c, ...stats.get(c.id)! }))
}

/** CPU in % of one core per PID: claude 50, vite 20, the Docker VM 40. */
export function snapshot(cores = 10): Snapshot {
  return rollUp({
    procs: procs(),
    owners: owners(),
    cpu: new Map([[201, 50], [203, 20], [401, 40]]),
    memory: parseTop(TOP).footprints,
    orcaWorktrees,
    containers: containers(),
    resolver,
    machine: { memoryTotal: 24 * 2 ** 30, memoryUsed: 19 * 2 ** 30, pressure: 'warning', cores },
    at: 1
  })
}
