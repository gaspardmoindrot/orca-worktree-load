// Canned system output shared by the tests: two worktrees, a Docker stack, Orca, and a stranger.
export const PS = `
    1     0   10:00.00  10000 /sbin/launchd
  100     1    1:00.00 400000 /Applications/Orca.app/Contents/MacOS/Orca
  101   100    0:10.00  50000 /Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper
  200   100    0:01.00   5000 -zsh
  201   200    5:00.00 300000 claude
  202   201    0:30.00  80000 node /Users/me/.npm/_npx/x/node_modules/.bin/mcp-server-github
  203   200    2:00.00 600000 node /w/api/node_modules/.bin/vite
  300   100    0:01.00   5000 -zsh
  301   300    0:05.00 200000 node /Users/me/.claude/local/claude
  400     1    3:00.00  17000 /Applications/Docker.app/Contents/MacOS/com.docker.virtualization --kernel x
  401     1   60:00.00 3000000 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
  500     1    0:20.00  90000 /Applications/Slack.app/Contents/MacOS/Slack
`
export const LSOF = 'p200\nfcwd\nn/w/api\np201\nfcwd\nn/w/api/src\np202\nfcwd\nn/\np203\nfcwd\nn/w/api\np300\nfcwd\nn/Users/me/.worktrees/repo/agent-1\np301\nfcwd\nn/Users/me/.worktrees/repo/agent-1\np100\nfcwd\nn/\np500\nfcwd\nn/\n'
export const TOP = `Processes: 10 total
PhysMem: 19G used (4012M wired, 3820M compressor), 280M unused.

PID    MEM
100    500M
201    350M
203    700M+
400    40M
401    2000M
`
export const DOCKER_PS = 'c1\t/w/api/docker\tapi\tapi-postgres-1\nc2\t/gone/agent-9/docker\tagent-9\tagent-9-redis-1\n'
export const DOCKER_STATS = 'c1\t1.50%\t300MiB / 3.824GiB\nc2\t0.50%\t100MiB / 3.824GiB\n'
