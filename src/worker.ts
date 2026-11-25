// The resident worker. It stays up because the manifest declares a status bar item, and polls:
// - every `intervalSeconds`: `orca diagnostics memory` (CPU and memory per worktree, which Orca
//   already attributes from each terminal's process tree) and `orca worktree ps` (every worktree,
//   its agents and terminals). The plugin host API has no PID, CPU or memory, so the CLI it is.
// - every minute: `git diff --shortstat HEAD` per live worktree.
// - every `diskMinutes`: `du -sk` per worktree, one at a time (node_modules makes it slow).
// Orca transpiles this file when it loads: no build step.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  crossings,
  formatBytes,
  formatCpu,
  merge,
  parseShortstat,
  statusBar,
  type Diagnostics,
  type DiskInfo,
  type PsWorktree,
  type Snapshot,
  type Thresholds
} from './load'

const ORCA_BIN = ['/usr/local/bin/orca', '/opt/homebrew/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca'].find(existsSync) ?? 'orca'
const GIT_BIN = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find(existsSync) ?? 'git'
const DU_BIN = existsSync('/usr/bin/du') ? '/usr/bin/du' : 'du'

export type Runner = (bin: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<string>

const execRunner: Runner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: opts.timeout ?? 15000, cwd: opts.cwd, maxBuffer: 32 * 2 ** 20 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)
    )
  )

/** Swapped in tests so they never shell out. */
let run: Runner = execRunner
export function setRunner(r: Runner): void {
  run = r
}

const EMPTY_HOST = { totalMemory: 0, availableMemory: 0, memoryUsagePercent: 0, cpuCoreCount: 0, loadAverage1m: 0 }

let last: Snapshot | null = null
let history: Record<string, { cpu: number[]; mem: number[] }> = {}
let streaks: Record<string, number> = {}
let disk: Record<string, DiskInfo> = {}
let ticking = false
let diskRunning = false
let lastDiff = 0
let lastDisk = 0
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

async function orcaJson<T>(args: string[]): Promise<T> {
  const parsed = JSON.parse(await run(ORCA_BIN, [...args, '--json']))
  if (!parsed.ok) throw new Error(parsed.error?.message ?? `orca ${args.join(' ')} failed`)
  return parsed.result as T
}

async function setting<T>(orca: OrcaWorkerApi, key: string, fallback: T): Promise<T> {
  const v = await orca.settings.get(key).catch(() => null)
  return typeof v === typeof fallback && v !== null ? (v as T) : fallback
}

async function thresholds(orca: OrcaWorkerApi): Promise<Thresholds> {
  return { cpu: await setting(orca, 'cpuThreshold', 150), memoryMb: await setting(orca, 'memoryThresholdMb', 4096) }
}

async function probeDiffs(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const out = await run(GIT_BIN, ['diff', '--shortstat', 'HEAD'], { cwd: path, timeout: 10000 })
      disk[path] = { ...disk[path], ...parseShortstat(out) }
    } catch {
      // Not a git checkout any more, or no HEAD yet: keep what we had.
    }
  }
}

async function probeDisk(paths: string[]): Promise<void> {
  diskRunning = true
  try {
    for (const path of paths) {
      if (stopped) return
      try {
        const out = await run(DU_BIN, ['-sk', path], { timeout: 120000 })
        disk[path] = { ...disk[path], diskBytes: Number(out.split(/\s/)[0]) * 1024 }
      } catch {
        // du can time out on a huge tree; the next round tries again.
      }
    }
  } finally {
    diskRunning = false
  }
}

async function tick(orca: OrcaWorkerApi): Promise<Snapshot> {
  if (ticking && last) return last
  ticking = true
  try {
    const [diag, ps] = await Promise.all([
      orcaJson<Diagnostics>(['diagnostics', 'memory']),
      orcaJson<{ worktrees: PsWorktree[] }>(['worktree', 'ps', '--limit', '500'])
    ])
    const worktrees = merge(diag, ps.worktrees, disk, history)
    history = Object.fromEntries(worktrees.map((w) => [w.id, { cpu: w.cpuHistory, mem: w.memHistory }]))
    last = { at: diag.collectedAt ?? Date.now(), host: diag.host, totalCpu: diag.totalCpu, totalMemory: diag.totalMemory, worktrees }

    const now = Date.now()
    if (now - lastDiff > 60_000) {
      lastDiff = now
      void probeDiffs(worktrees.filter((w) => w.processes > 0 || w.terminals > 0).map((w) => w.path))
    }
    const diskEvery = (await setting(orca, 'diskMinutes', 10)) * 60_000
    if (diskEvery > 0 && !diskRunning && now - lastDisk > diskEvery) {
      lastDisk = now
      void probeDisk(worktrees.map((w) => w.path))
    }

    const c = crossings(worktrees, await thresholds(orca), streaks, 3)
    streaks = c.streaks
    if (c.alert.length > 0 && (await setting(orca, 'notify', true))) {
      for (const w of c.alert) {
        await orca.host
          .call('notifications.show', {
            title: `${w.name} is heavy`,
            body: `${formatCpu(w.cpu)} CPU · ${formatBytes(w.memory)} for 3 samples in a row (${w.processes} processes)`
          })
          .catch(() => undefined)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    orca.log(`poll failed: ${message}`)
    last = { ...(last ?? { at: Date.now(), host: EMPTY_HOST, totalCpu: 0, totalMemory: 0, worktrees: [] }), error: message }
  } finally {
    ticking = false
  }
  const bar = statusBar(last, await thresholds(orca))
  await orca.host.call('statusBar.update', { id: 'worktree-load', ...bar }).catch(() => undefined)
  orca.panels.post('load.snapshot', last)
  return last
}

async function loop(orca: OrcaWorkerApi): Promise<void> {
  await tick(orca)
  const seconds = Math.min(300, Math.max(3, await setting(orca, 'intervalSeconds', 10)))
  if (stopped) return
  timer = setTimeout(() => void loop(orca), seconds * 1000)
  // The IPC channel keeps the worker alive; the timer alone should not (tests exit cleanly).
  timer.unref?.()
}

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  orca.panels.handle('load.get', async () => last ?? (await tick(orca)))
  orca.panels.handle('load.refresh', async () => tick(orca))
  orca.panels.handle('load.open', async ({ path }) => {
    // workspace.open wants Orca's workspace id, which is not always the CLI's worktreeId.
    const { workspaces } = await orca.host.call('workspace.list')
    const target = workspaces.find((w) => w.path === path)
    if (!target) return { opened: false }
    await orca.host.call('workspace.open', { workspaceId: target.id })
    return { opened: true }
  })
  orca.panels.handle('load.scanDisk', async () => {
    if (!diskRunning && last) {
      lastDisk = Date.now()
      void probeDisk(last.worktrees.map((w) => w.path))
    }
    return { started: !diskRunning }
  })

  orca.commands.register('worktreeLoad.refresh', async () => {
    const s = await tick(orca)
    const top = [...s.worktrees].sort((a, b) => b.memory - a.memory)[0]
    return top ? `Heaviest: ${top.name} (${formatCpu(top.cpu)} · ${formatBytes(top.memory)})` : 'No live worktree.'
  })

  void loop(orca)
}

export function deactivate(): void {
  stopped = true
  clearTimeout(timer)
  last = null
  history = {}
  streaks = {}
  disk = {}
}
