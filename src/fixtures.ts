// Canned CLI output shared by the tests.
import type { Diagnostics, PsWorktree } from './load'

export const HOST = { totalMemory: 24 * 2 ** 30, availableMemory: 8 * 2 ** 30, memoryUsagePercent: 66, cpuCoreCount: 18, loadAverage1m: 4.2 }

export const diag: Diagnostics = {
  host: HOST,
  totalCpu: 180,
  totalMemory: 5 * 2 ** 30,
  collectedAt: 1,
  worktrees: [
    { worktreeId: 'r::/w/api', worktreeName: 'api', repoName: 'demo', cpu: 170, memory: 4.5 * 2 ** 30, sessions: [{ sessionId: 's1', pid: 10, cpu: 170, memory: 4.5 * 2 ** 30 }], chats: [] },
    { worktreeId: 'r::/w/docs', worktreeName: 'docs', repoName: 'demo', cpu: 10, memory: 300 * 2 ** 20, sessions: [{ sessionId: 's2', pid: 11, cpu: 10, memory: 300 * 2 ** 20 }] }
  ]
}

export const ps: PsWorktree[] = [
  { worktreeId: 'r::/w/api', displayName: 'api', repo: 'demo', path: '/w/api', branch: 'refs/heads/feat/api', isArchived: false, isMainWorktree: false, liveTerminalCount: 2, agents: [{ state: 'working' }, { state: 'blocked' }] },
  { worktreeId: 'r::/w/docs', displayName: 'docs', repo: 'demo', path: '/w/docs', branch: 'docs', isArchived: false, isMainWorktree: false, liveTerminalCount: 1, agents: [{ state: 'done' }] },
  { worktreeId: 'r::/w/idle', displayName: 'idle', repo: 'demo', path: '/w/idle', branch: null, isArchived: false, isMainWorktree: true, liveTerminalCount: 0 },
  { worktreeId: 'r::/w/old', displayName: 'old', repo: 'demo', path: '/w/old', branch: null, isArchived: true, isMainWorktree: false, liveTerminalCount: 0 }
]
