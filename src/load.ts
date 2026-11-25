// Pure logic: turns Orca's CLI output into one row per worktree. No I/O here, so it is tested
// directly (src/load.test.ts) and shared by the worker and the panel.

/** `orca diagnostics memory --json` → result.worktrees[] (CPU is % of one core, memory in bytes). */
export type DiagWorktree = {
  worktreeId: string
  worktreeName: string
  repoName: string
  cpu: number
  memory: number
  sessions: { sessionId: string; pid: number; cpu: number; memory: number }[]
  chats?: { agentSessionId: string; agent: string; cpu: number; memory: number }[]
}

export type DiagHost = {
  totalMemory: number
  availableMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export type Diagnostics = {
  worktrees: DiagWorktree[]
  host: DiagHost
  totalCpu: number
  totalMemory: number
  collectedAt: number
}

/** `orca worktree ps --json` → result.worktrees[] (only the fields we read). */
export type PsWorktree = {
  worktreeId: string
  displayName: string
  repo: string
  path: string
  branch: string | null
  isArchived: boolean
  isMainWorktree: boolean
  createdAt?: number
  lastActivityAt?: number
  liveTerminalCount: number
  creatorProvenance?: { kind: string }
  agents?: { state: string; agentType?: string | null }[]
}

/** What the slow probes (du, git) last found for a path. */
export type DiskInfo = { diskBytes?: number; diffFiles?: number; diffAdded?: number; diffRemoved?: number }

export type WorktreeLoad = {
  id: string
  name: string
  repo: string
  path: string
  branch: string | null
  isMain: boolean
  createdAt: number | null
  lastActivityAt: number | null
  cpu: number
  memory: number
  processes: number
  terminals: number
  agents: { working: number; waiting: number; done: number; total: number }
  disk: DiskInfo
  /** Last CPU samples, oldest first, for the sparkline. */
  cpuHistory: number[]
  memHistory: number[]
}

export type Snapshot = {
  at: number
  host: DiagHost
  totalCpu: number
  totalMemory: number
  worktrees: WorktreeLoad[]
  error?: string
}

export const HISTORY = 30

export function countAgents(agents: PsWorktree['agents']): WorktreeLoad['agents'] {
  const out = { working: 0, waiting: 0, done: 0, total: 0 }
  for (const a of agents ?? []) {
    out.total++
    if (a.state === 'working') out.working++
    else if (a.state === 'blocked' || a.state === 'waiting' || a.state === 'permission') out.waiting++
    else out.done++
  }
  return out
}

/**
 * One row per live (non-archived) worktree, joined on worktreeId. Worktrees with no process
 * still appear, at 0 CPU, so the list shows everything Orca created.
 */
export function merge(
  diag: Diagnostics,
  ps: PsWorktree[],
  disk: Record<string, DiskInfo>,
  history: Record<string, { cpu: number[]; mem: number[] }>
): WorktreeLoad[] {
  const byId = new Map(diag.worktrees.map((w) => [w.worktreeId, w]))
  return ps
    .filter((w) => !w.isArchived)
    .map((w): WorktreeLoad => {
      const d = byId.get(w.worktreeId)
      const cpu = d?.cpu ?? 0
      const memory = d?.memory ?? 0
      const h = history[w.worktreeId] ?? { cpu: [], mem: [] }
      return {
        id: w.worktreeId,
        name: w.displayName,
        repo: w.repo,
        path: w.path,
        branch: w.branch ? w.branch.replace(/^refs\/heads\//, '') : null,
        isMain: w.isMainWorktree,
        createdAt: w.createdAt ?? null,
        lastActivityAt: w.lastActivityAt ?? null,
        cpu,
        memory,
        processes: (d?.sessions.length ?? 0) + (d?.chats?.length ?? 0),
        terminals: w.liveTerminalCount,
        agents: countAgents(w.agents),
        disk: disk[w.path] ?? {},
        cpuHistory: [...h.cpu, cpu].slice(-HISTORY),
        memHistory: [...h.mem, memory].slice(-HISTORY)
      }
    })
}

const BARS = '▁▂▃▄▅▆▇█'

/** A text sparkline: the panel has no chart component, but Text renders these fine. */
export function sparkline(values: readonly number[], max?: number): string {
  if (values.length === 0) return ''
  const top = max ?? Math.max(...values, 1)
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / top) * (BARS.length - 1)))]).join('')
}

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MB`
  if (bytes >= 2 ** 10) return `${Math.round(bytes / 2 ** 10)} KB`
  return `${bytes} B`
}

export function formatCpu(cpu: number): string {
  return `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`
}

export type Thresholds = { cpu: number; memoryMb: number }

export function isHot(w: Pick<WorktreeLoad, 'cpu' | 'memory'>, t: Thresholds): boolean {
  return w.cpu >= t.cpu || w.memory >= t.memoryMb * 2 ** 20
}

/** The status bar: total load, and the heaviest worktree when one is over a threshold. */
export function statusBar(s: Snapshot, t: Thresholds): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  if (s.error) return { text: 'Load: ?', tone: 'warning', tooltip: s.error }
  const busy = s.worktrees.filter((w) => w.processes > 0)
  const hot = busy.filter((w) => isHot(w, t))
  const working = s.worktrees.reduce((n, w) => n + w.agents.working, 0)
  const top = [...busy].sort((a, b) => b.memory - a.memory).slice(0, 3)
  const text = `${formatCpu(s.totalCpu)} · ${formatBytes(s.totalMemory)} · ${busy.length}/${s.worktrees.length} live${working ? ` · ${working} working` : ''}`
  const tooltip = [
    `Host: ${Math.round(s.host.memoryUsagePercent)}% RAM used, load ${s.host.loadAverage1m.toFixed(1)} on ${s.host.cpuCoreCount} cores`,
    ...top.map((w) => `${w.name}: ${formatCpu(w.cpu)} · ${formatBytes(w.memory)}`)
  ].join('\n')
  const tone = hot.length === 0 ? 'neutral' : hot.some((w) => w.memory >= t.memoryMb * 2 * 2 ** 20) ? 'danger' : 'warning'
  return { text, tone, tooltip }
}

/**
 * Which worktrees just crossed a threshold for `streak` samples in a row, so a short spike
 * (an install, a build) does not notify. Returns the ids to alert and the new streak counts.
 */
export function crossings(
  worktrees: readonly WorktreeLoad[],
  t: Thresholds,
  streaks: Record<string, number>,
  streak: number
): { alert: WorktreeLoad[]; streaks: Record<string, number> } {
  const next: Record<string, number> = {}
  const alert: WorktreeLoad[] = []
  for (const w of worktrees) {
    if (!isHot(w, t)) continue
    next[w.id] = (streaks[w.id] ?? 0) + 1
    if (next[w.id] === streak) alert.push(w)
  }
  return { alert, streaks: next }
}

/** `git diff --shortstat HEAD` → counts; empty output means a clean tree. */
export function parseShortstat(out: string): Pick<DiskInfo, 'diffFiles' | 'diffAdded' | 'diffRemoved'> {
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0)
  return {
    diffFiles: num(/(\d+) files? changed/),
    diffAdded: num(/(\d+) insertions?/),
    diffRemoved: num(/(\d+) deletions?/)
  }
}
