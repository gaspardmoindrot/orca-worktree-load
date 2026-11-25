// The resident worker (the status bar item keeps it running). Every `intervalSeconds` it reads
// every process on the Mac with `ps`, finds where each one runs (`lsof`, only for new PIDs), and
// gives it to a worktree: an Orca worktree first, else any git checkout, else its parent's owner.
// Memory is the footprint Activity Monitor shows (`top`, every 15 s); Docker containers are read
// every 30 s and put under the worktree of their compose folder. Nothing is written to disk:
// history is the last hour, in memory. macOS only.
// Orca transpiles this file when it loads: no build step.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, loadavg, totalmem, cpus, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { planStop, stillSame } from './stop'
import {
  attribute,
  formatBytes,
  parseDockerPs,
  parseDockerStats,
  parseLsof,
  parsePs,
  parseTop,
  record,
  rollUp,
  statusBar,
  totalOf,
  type Container,
  type History,
  type Machine,
  type OrcaWorktree,
  type OwnerKey,
  type Proc,
  type PanelPayload,
  type Resolver,
  type Snapshot
} from './model'

export type Runner = (bin: string, args: string[], opts?: { timeout?: number; allowFail?: boolean }) => Promise<string>

const execRunner: Runner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: opts.timeout ?? 15000, maxBuffer: 64 * 2 ** 20 }, (error, stdout, stderr) =>
      error && !(opts.allowFail && stdout) ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)
    )
  )

/** Swapped in tests so they never shell out. */
let run: Runner = execRunner
export function setRunner(r: Runner): void {
  run = r
}

const find = (names: string[], fallback: string) => names.find(existsSync) ?? fallback
const PS = '/bin/ps'
const TOP = '/usr/bin/top'
const LSOF = '/usr/sbin/lsof'
const SYSCTL = '/usr/sbin/sysctl'
const ORCA = find(['/usr/local/bin/orca', '/opt/homebrew/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca'], 'orca')
const DOCKER = find(['/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.docker/bin/docker')], '')

const BUCKET_MS = 30_000
let firstGapMs = 1000
/** Tests skip the one-second wait between the first two readings. */
export function setFirstGap(ms: number): void {
  firstGapMs = ms
}
const BUCKETS = 120 // one hour

// --- state (module level, so deactivate can reset it) -------------------------------------------
let last: Snapshot | null = null
let history: History = {}
/** Each process's CPU-time readings over the last 30 s: CPU is averaged over that window. */
let readings = new Map<number, { seconds: number; at: number }[]>()
const CPU_WINDOW_MS = 30_000
let cwds = new Map<number, { cwd: string; command: string }>()
let footprints = new Map<number, number>()
let physUsed: number | null = null
let containers: Container[] = []
let orcaWorktrees: OrcaWorktree[] = []
let gitRoots = new Map<string, string | null>()
let lastTop = 0
let lastDocker = 0
let lastOrca = 0
let lastFullLsof = 0
let pressureSince: number | null = null
let normalSince: number | null = null
let ticking: Promise<Snapshot> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
/** The last sample's processes and owners, which Stop works from. */
let lastProcs: Proc[] = []
let lastOwners = new Map<number, OwnerKey>()
let lastResolver: Resolver | null = null

async function setting<T>(orca: OrcaWorkerApi, key: string, fallback: T): Promise<T> {
  const v = await orca.settings.get(key).catch(() => null)
  return typeof v === typeof fallback && v !== null ? (v as T) : fallback
}

function makeResolver(includeOtherCheckouts: boolean): Resolver {
  const orcaPaths = orcaWorktrees.map((w) => w.path).sort((a, b) => b.length - a.length)
  const home = homedir()
  const gitRoot = (dir: string): string | null => {
    if (gitRoots.has(dir)) return gitRoots.get(dir) ?? null
    let root: string | null = null
    if (dir !== '/' && dir !== home && dir.startsWith('/')) {
      root = existsSync(join(dir, '.git')) ? dir : gitRoot(dirname(dir))
    }
    gitRoots.set(dir, root)
    return root
  }
  return {
    rootFor(dir) {
      const orca = orcaPaths.find((p) => dir === p || dir.startsWith(`${p}/`))
      if (orca) return orca
      return includeOtherCheckouts ? gitRoot(dir) : null
    },
    exists: (dir) => existsSync(dir)
  }
}

async function refreshCwds(procs: ReturnType<typeof parsePs>, now: number): Promise<void> {
  const full = now - lastFullLsof > 60_000
  const missing = procs.filter((p) => cwds.get(p.pid)?.command !== p.command).map((p) => p.pid)
  const fresh = new Map<number, string>()
  if (full) {
    lastFullLsof = now
    const out = await run(LSOF, ['-a', '-u', userInfo().username, '-d', 'cwd', '-Fn', '-w'], { allowFail: true, timeout: 10000 }).catch(() => '')
    for (const [pid, cwd] of parseLsof(out)) fresh.set(pid, cwd)
  } else {
    for (let i = 0; i < missing.length; i += 200) {
      const out = await run(LSOF, ['-a', '-d', 'cwd', '-Fn', '-w', '-p', missing.slice(i, i + 200).join(',')], { allowFail: true, timeout: 10000 }).catch(() => '')
      for (const [pid, cwd] of parseLsof(out)) fresh.set(pid, cwd)
    }
  }
  const alive = new Set(procs.map((p) => p.pid))
  for (const p of procs) {
    const cwd = fresh.get(p.pid)
    // A process we cannot read (root, another user) keeps an empty cwd and inherits its owner.
    if (cwd !== undefined || full || missing.includes(p.pid)) cwds.set(p.pid, { cwd: cwd ?? '', command: p.command })
  }
  for (const pid of cwds.keys()) if (!alive.has(pid)) cwds.delete(pid)
}

async function refreshTop(now: number): Promise<void> {
  if (now - lastTop < 15_000) return
  lastTop = now
  const out = await run(TOP, ['-l', '1', '-stats', 'pid,mem', '-n', '5000'], { timeout: 10000 }).catch(() => '')
  if (!out) return
  const parsed = parseTop(out)
  footprints = parsed.footprints
  physUsed = parsed.physUsed
}

async function refreshDocker(orca: OrcaWorkerApi, now: number): Promise<void> {
  const every = (await setting(orca, 'dockerSeconds', 30)) * 1000
  if (!DOCKER || every <= 0 || now - lastDocker < every) return
  lastDocker = now
  try {
    const ps = parseDockerPs(
      await run(DOCKER, ['ps', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project"}}\t{{.Names}}'], { timeout: 10000 })
    )
    const stats = ps.length ? parseDockerStats(await run(DOCKER, ['stats', '--no-stream', '--format', '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}'], { timeout: 20000 })) : new Map()
    containers = ps.map((c) => ({ ...c, cpu: stats.get(c.id)?.cpu ?? 0, memory: stats.get(c.id)?.memory ?? 0 }))
  } catch {
    // Docker not running: no containers, not an error.
    containers = []
  }
}

async function refreshOrca(orca: OrcaWorkerApi, now: number): Promise<void> {
  if (now - lastOrca < 15_000 && orcaWorktrees.length) return
  lastOrca = now
  try {
    const { workspaces } = await orca.host.call('workspace.list', { includeStatus: true })
    orcaWorktrees = workspaces
      .filter((w) => w.kind === 'worktree' && w.path)
      .map((w) => ({ id: w.id, name: w.name, project: w.project ?? null, path: w.path, branch: w.branch, state: w.status?.state ?? null }))
    gitRoots = new Map()
  } catch (error) {
    orca.log(`workspace.list failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readMachine(cpuSum: number): Promise<Machine> {
  const level = Number((await run(SYSCTL, ['-n', 'kern.memorystatus_vm_pressure_level']).catch(() => '1')).trim())
  return {
    memoryTotal: totalmem(),
    memoryUsed: physUsed,
    pressure: level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal',
    cores: cpus().length,
    load1: loadavg()[0],
    cpu: cpuSum
  }
}

async function alertOnPressure(orca: OrcaWorkerApi, s: Snapshot, now: number): Promise<void> {
  // One notification per episode of high pressure; an episode ends after a minute back to normal.
  if (s.machine.pressure === 'normal') {
    normalSince ??= now
    if (now - normalSince > 60_000) pressureSince = null
    return
  }
  normalSince = null
  if (pressureSince !== null) return
  pressureSince = now
  if (!(await setting(orca, 'notify', true))) return
  const heaviest = [...s.worktrees].sort((a, b) => totalOf(b).memory - totalOf(a).memory)[0]
  await orca.host
    .call('notifications.show', {
      title: `Memory pressure ${s.machine.pressure}`,
      body: heaviest ? `Heaviest worktree: ${heaviest.name} (${formatBytes(totalOf(heaviest).memory)})` : 'No worktree is running anything.'
    })
    .catch(() => undefined)
}

async function sample(orca: OrcaWorkerApi): Promise<Snapshot> {
  const now = Date.now()
  try {
    await refreshOrca(orca, now)
    let procs = parsePs(await run(PS, ['-Ao', 'pid=,ppid=,time=,rss=,command=']))
    if (readings.size === 0) {
      // CPU is a difference between two readings: take a second one a second later.
      for (const p of procs) readings.set(p.pid, [{ seconds: p.cpuSeconds, at: Date.now() }])
      await new Promise((r) => setTimeout(r, firstGapMs))
      procs = parsePs(await run(PS, ['-Ao', 'pid=,ppid=,time=,rss=,command=']))
    }
    await Promise.all([refreshCwds(procs, now), refreshTop(now), refreshDocker(orca, now)])

    const readAt = Date.now()
    const cpu = new Map<number, number>()
    const next = new Map<number, { seconds: number; at: number }[]>()
    for (const p of procs) {
      // Drop readings older than the window, but keep the oldest one inside it, and drop them all
      // if the PID was reused (its CPU time went down).
      const kept = (readings.get(p.pid) ?? []).filter((r) => r.at >= readAt - CPU_WINDOW_MS && r.seconds <= p.cpuSeconds)
      const oldest = kept[0]
      if (oldest && readAt > oldest.at) cpu.set(p.pid, ((p.cpuSeconds - oldest.seconds) / ((readAt - oldest.at) / 1000)) * 100)
      else if (last) cpu.set(p.pid, Math.min(100 * cpus().length, (p.cpuSeconds / Math.max(1, (readAt - last.at) / 1000)) * 100))
      next.set(p.pid, [...kept, { seconds: p.cpuSeconds, at: readAt }])
    }
    readings = next

    const resolver = makeResolver(await setting(orca, 'includeOtherCheckouts', true))
    const owners = attribute(procs, new Map([...cwds].map(([pid, v]) => [pid, v.cwd])), resolver, homedir())
    lastProcs = procs
    lastOwners = owners
    lastResolver = resolver
    const cpuSum = [...cpu.values()].reduce((a, b) => a + b, 0)
    last = rollUp({ procs, owners, cpu, memory: footprints, orcaWorktrees, containers, resolver, machine: await readMachine(cpuSum), at: now })
    history = record(history, last, BUCKET_MS, BUCKETS)
    await alertOnPressure(orca, last, now)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    orca.log(`sample failed: ${message}`)
    last = last ? { ...last, error: message } : null
    if (!last) throw error
  }
  return last
}


function payload(s: Snapshot): PanelPayload {
  const trends: PanelPayload['trends'] = {}
  for (const [key, points] of Object.entries(history)) {
    trends[key] = { memoryMb: points.map((p) => Math.round(p.memory / 2 ** 20)), cpu: points.map((p) => Math.round(p.cpu)) }
  }
  return { ...s, trends }
}

async function tick(orca: OrcaWorkerApi): Promise<Snapshot> {
  ticking ??= sample(orca).finally(() => {
    ticking = null
  })
  const s = await ticking
  await orca.host.call('statusBar.update', { id: 'worktree-load', ...statusBar(s) }).catch(() => undefined)
  orca.panels.post('load.snapshot', payload(s))
  return s
}

async function loop(orca: OrcaWorkerApi): Promise<void> {
  await tick(orca).catch(() => undefined)
  const seconds = Math.min(300, Math.max(2, await setting(orca, 'intervalSeconds', 5)))
  if (stopped) return
  timer = setTimeout(() => void loop(orca), seconds * 1000)
  // The IPC channel keeps the worker alive; the timer alone should not (tests exit cleanly).
  ;(timer as { unref?: () => void }).unref?.()
}

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  orca.panels.handle('load.get', async () => payload(last ?? (await tick(orca))))
  orca.panels.handle('load.refresh', async () => payload(await tick(orca)))
  orca.panels.handle('load.stop', async ({ keys }) => stop(orca, keys))
  orca.panels.handle('load.open', async ({ path }) => {
    const target = orcaWorktrees.find((w) => w.path === path)
    if (!target) return { opened: false }
    await orca.host.call('workspace.open', { workspaceId: target.id })
    return { opened: true }
  })
  orca.commands.register('worktreeLoad.show', async () => {
    // The host API cannot open a panel; Orca's CLI can. The key is `local.<id>` for a development
    // folder and `<owner>.<id>` once installed, so look it up.
    try {
      const list = JSON.parse(await run(ORCA, ['plugin', 'list', '--json']))
      const key = list.result.plugins.find((p: { pluginKey: string }) => p.pluginKey.endsWith('.orca-worktree-load'))?.pluginKey
      if (key) await run(ORCA, ['plugin', 'open', key, '--panel', 'worktree-load', '--json'])
    } catch (error) {
      orca.log(`opening the panel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  })
  void loop(orca)
}

/** This worker and every process above it: Stop never signals them. */
function protectedPids(procs: readonly Proc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const out = new Set<number>([process.pid])
  let pid = process.ppid
  while (pid > 1 && !out.has(pid)) {
    out.add(pid)
    pid = byPid.get(pid)?.ppid ?? 1
  }
  return out
}

type Signal = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => boolean
const realSignal: Signal = (pid, sig) => {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}
let signal: Signal = realSignal
/** Tests swap it: their process list is fake, a real signal would hit a real PID. */
export function setSignal(s: Signal): void {
  signal = s
}

export type StopResult = { processes: number; containers: number; failed: string[] }

/** Stops what the worktrees in `keys` run: SIGTERM, then SIGKILL 3 s later for what is left. */
async function stop(orca: OrcaWorkerApi, keys: string[]): Promise<StopResult> {
  if (!lastResolver) await tick(orca)
  const plans = planStop({ keys, procs: lastProcs, owners: lastOwners, containers, resolver: lastResolver!, protectedPids: protectedPids(lastProcs) })
  const failed: string[] = []
  const planned = plans.flatMap((p) => p.processes)
  // Check again right before signalling: a PID can be reused between the sample and the click.
  const now = parsePs(await run(PS, ['-Ao', 'pid=,ppid=,time=,rss=,command=']))
  const targets = stillSame(planned, now)
  for (const pid of targets) signal(pid, 'SIGTERM')

  let stoppedContainers = 0
  const ids = plans.flatMap((p) => p.containers)
  if (ids.length && DOCKER) {
    await run(DOCKER, ['stop', ...ids], { timeout: 60000 }).then(
      () => (stoppedContainers += ids.length),
      (e) => failed.push(`docker stop: ${e instanceof Error ? e.message : String(e)}`)
    )
  }
  for (const project of plans.flatMap((p) => p.projects)) {
    if (!DOCKER) break
    const count = containers.filter((c) => c.project === project).length
    await run(DOCKER, ['compose', '-p', project, 'down'], { timeout: 120000 }).then(
      () => (stoppedContainers += count),
      (e) => failed.push(`${project}: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  if (targets.length) {
    await new Promise((r) => setTimeout(r, killAfterMs))
    const after = parsePs(await run(PS, ['-Ao', 'pid=,ppid=,time=,rss=,command=']))
    for (const pid of stillSame(planned.filter((p) => targets.includes(p.pid)), after)) signal(pid, 'SIGKILL')
  }
  orca.log(`stopped ${keys.join(', ')}: ${targets.length} processes, ${stoppedContainers} containers${failed.length ? `, failed: ${failed.join('; ')}` : ''}`)
  lastDocker = 0 // read Docker again on the next sample
  await tick(orca).catch(() => undefined)
  return { processes: targets.length, containers: stoppedContainers, failed }
}

let killAfterMs = 3000
/** Tests do not wait 3 s before SIGKILL. */
export function setKillAfter(ms: number): void {
  killAfterMs = ms
}

export function deactivate(): void {
  stopped = true
  clearTimeout(timer)
  last = null
  history = {}
  readings = new Map()
  cwds = new Map()
  footprints = new Map()
  physUsed = null
  containers = []
  orcaWorktrees = []
  gitRoots = new Map()
  lastTop = lastDocker = lastOrca = lastFullLsof = 0
  pressureSince = normalSince = null
  firstGapMs = 1000
  killAfterMs = 3000
  signal = realSignal
  lastProcs = []
  lastOwners = new Map()
  lastResolver = null
  ticking = null
}
