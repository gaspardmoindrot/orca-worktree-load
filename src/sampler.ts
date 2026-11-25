// One Sampler per worker activation: it holds what the previous samples learned (CPU readings,
// working directories, footprints, containers) and turns a fresh `ps` into a Snapshot.
//
// Each sample:   ps (every process) → lsof (working directory, only for new PIDs; a full pass
//                every minute) → attribute to worktrees → add up.
// Less often:    top every 15 s (footprints), docker ps + stats every `dockerSeconds`,
//                Orca's worktree list every 15 s.
// Nothing is written to disk.
import { cpus, homedir, totalmem, userInfo } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  attribute,
  parseDockerPs,
  parseDockerStats,
  parseLsof,
  parsePs,
  parseTop,
  rollUp,
  type Container,
  type Machine,
  type OrcaWorktree,
  type OwnerKey,
  type Proc,
  type Resolver,
  type Snapshot
} from './model'
import { planStop, stillSame } from './stop'
import { BIN, PS_ARGS, system } from './system'

export type Settings = { intervalSeconds: number; dockerSeconds: number; includeOtherCheckouts: boolean }
export type StopResult = { processes: number; containers: number; failed: string[] }

type Reading = { seconds: number; at: number }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class Sampler {
  /** Set by the worker on deactivate: a sample still in flight must not publish anything. */
  disposed = false
  last: Snapshot | null = null
  /** The first sample takes two `ps` readings this far apart, to have a CPU figure right away. */
  firstGapMs = 1000
  killAfterMs = 3000

  private readings = new Map<number, Reading[]>()
  private cwds = new Map<number, { cwd: string; command: string }>()
  private footprints = new Map<number, number>()
  private physUsed: number | null = null
  private containers: Container[] = []
  private orcaWorktrees: OrcaWorktree[] = []
  private gitRoots = new Map<string, string | null>()
  private lastProcs: Proc[] = []
  private lastOwners = new Map<number, OwnerKey>()
  private lastResolver: Resolver | null = null
  private at = { top: 0, docker: 0, orca: 0, fullLsof: 0 }

  constructor(private readonly listWorktrees: () => Promise<OrcaWorktree[]>) {}

  async sample(settings: Settings): Promise<Snapshot> {
    const now = Date.now()
    await this.refreshOrca(now)
    let procs = parsePs(await system.run(BIN.ps, PS_ARGS))
    if (this.readings.size === 0) {
      for (const p of procs) this.readings.set(p.pid, [{ seconds: p.cpuSeconds, at: Date.now() }])
      await system.sleep(this.firstGapMs)
      procs = parsePs(await system.run(BIN.ps, PS_ARGS))
    }
    await Promise.all([this.refreshCwds(procs, now), this.refreshTop(now), this.refreshDocker(settings, now)])

    const cpu = this.cpuPerProcess(procs, settings.intervalSeconds)
    const resolver = this.resolver(settings.includeOtherCheckouts)
    const owners = attribute(procs, new Map([...this.cwds].map(([pid, v]) => [pid, v.cwd])), resolver, homedir())
    this.lastProcs = procs
    this.lastOwners = owners
    this.lastResolver = resolver
    this.last = rollUp({
      procs,
      owners,
      cpu,
      memory: this.footprints,
      orcaWorktrees: this.orcaWorktrees,
      containers: this.containers,
      resolver,
      machine: await this.machine(),
      at: now
    })
    return this.last
  }

  /** Stops what the worktrees in `keys` run: SIGTERM, `docker stop` or `compose down`, then
   *  SIGKILL after `killAfterMs` for what is left. Keys must come from the last snapshot. */
  async stop(keys: readonly string[]): Promise<StopResult> {
    const known = new Set(this.last?.worktrees.map((w) => w.key))
    const valid = keys.filter((k) => known.has(k))
    if (!this.lastResolver || valid.length === 0) return { processes: 0, containers: 0, failed: [] }

    const plans = planStop({ keys: valid, procs: this.lastProcs, owners: this.lastOwners, containers: this.containers, resolver: this.lastResolver, protectedPids: this.protectedPids() })
    const planned = plans.flatMap((p) => p.processes)
    const failed: string[] = []

    // Check again right before signalling: a PID can be reused between the sample and the click.
    const targets = stillSame(planned, parsePs(await system.run(BIN.ps, PS_ARGS)))
    for (const pid of targets) system.signal(pid, 'SIGTERM')

    let containers = 0
    const ids = plans.flatMap((p) => p.containers)
    if (ids.length && BIN.docker) {
      await system.run(BIN.docker, ['stop', ...ids], { timeout: 60_000 }).then(
        () => (containers += ids.length),
        (error) => failed.push(`docker stop: ${message(error)}`)
      )
    }
    for (const project of plans.flatMap((p) => p.projects)) {
      if (!BIN.docker) break
      const count = this.containers.filter((c) => c.project === project).length
      await system.run(BIN.docker, ['compose', `--project-name=${project}`, 'down'], { timeout: 120_000 }).then(
        () => (containers += count),
        (error) => failed.push(`${project}: ${message(error)}`)
      )
    }

    if (targets.length) {
      await system.sleep(this.killAfterMs)
      const left = stillSame(planned.filter((p) => targets.includes(p.pid)), parsePs(await system.run(BIN.ps, PS_ARGS)))
      for (const pid of left) system.signal(pid, 'SIGKILL')
    }
    this.at.docker = 0 // read Docker again on the next sample
    return { processes: targets.length, containers, failed }
  }

  /** The Orca worktree at `path`, for `workspace.open`. */
  orcaWorktree(path: string): OrcaWorktree | undefined {
    return this.orcaWorktrees.find((w) => w.path === path)
  }

  // -------------------------------------------------------------------------------------------

  /**
   * CPU in % of one core, averaged over the last 30 s (or 2.5 sample intervals, if longer): the
   * oldest reading kept in that window against the newest. A PID whose CPU time went down was
   * reused, so its old readings are dropped.
   */
  private cpuPerProcess(procs: readonly Proc[], intervalSeconds: number): Map<number, number> {
    const now = Date.now()
    const windowMs = Math.max(30_000, intervalSeconds * 2500)
    const cpu = new Map<number, number>()
    const next = new Map<number, Reading[]>()
    for (const p of procs) {
      const history = (this.readings.get(p.pid) ?? []).filter((r) => r.seconds <= p.cpuSeconds)
      const inWindow = history.filter((r) => r.at >= now - windowMs)
      const kept = inWindow.length ? inWindow : history.slice(-1)
      const oldest = kept[0]
      if (oldest && now > oldest.at) cpu.set(p.pid, ((p.cpuSeconds - oldest.seconds) / ((now - oldest.at) / 1000)) * 100)
      next.set(p.pid, [...kept, { seconds: p.cpuSeconds, at: now }])
    }
    this.readings = next
    return cpu
  }

  private resolver(includeOtherCheckouts: boolean): Resolver {
    const orcaPaths = this.orcaWorktrees.map((w) => w.path).sort((a, b) => b.length - a.length)
    const home = homedir()
    const gitRoot = (dir: string): string | null => {
      const cached = this.gitRoots.get(dir)
      if (cached !== undefined) return cached
      const root = dir !== '/' && dir !== home && dir.startsWith('/') ? (existsSync(join(dir, '.git')) ? dir : gitRoot(dirname(dir))) : null
      this.gitRoots.set(dir, root)
      return root
    }
    return {
      rootFor: (dir) => orcaPaths.find((p) => dir === p || dir.startsWith(`${p}/`)) ?? (includeOtherCheckouts ? gitRoot(dir) : null),
      exists: (dir) => existsSync(dir)
    }
  }

  private async refreshCwds(procs: readonly Proc[], now: number): Promise<void> {
    const full = now - this.at.fullLsof > 60_000
    const missing = new Set(procs.filter((p) => this.cwds.get(p.pid)?.command !== p.command).map((p) => p.pid))
    const found = new Map<number, string>()
    const lsof = async (args: string[]) => {
      const out = await system.run(BIN.lsof, ['-a', '-d', 'cwd', '-Fn', '-w', ...args], { allowFail: true, timeout: 10_000 }).catch(() => '')
      for (const [pid, cwd] of parseLsof(out)) found.set(pid, cwd)
    }
    if (full) {
      this.at.fullLsof = now
      await lsof(['-u', userInfo().username])
    } else {
      const pids = [...missing]
      for (let i = 0; i < pids.length; i += 200) await lsof(['-p', pids.slice(i, i + 200).join(',')])
    }
    const alive = new Set(procs.map((p) => p.pid))
    for (const p of procs) {
      // A process lsof cannot read (root, another user) gets no cwd and inherits its parent's owner.
      if (full || missing.has(p.pid)) this.cwds.set(p.pid, { cwd: found.get(p.pid) ?? '', command: p.command })
    }
    for (const pid of this.cwds.keys()) if (!alive.has(pid)) this.cwds.delete(pid)
  }

  private async refreshTop(now: number): Promise<void> {
    if (now - this.at.top < 15_000) return
    this.at.top = now
    const out = await system.run(BIN.top, ['-l', '1', '-stats', 'pid,mem', '-n', '5000'], { timeout: 10_000 }).catch(() => '')
    if (!out) return
    const parsed = parseTop(out)
    this.footprints = parsed.footprints
    this.physUsed = parsed.physUsed
  }

  private async refreshDocker(settings: Settings, now: number): Promise<void> {
    if (!BIN.docker || settings.dockerSeconds <= 0) {
      this.containers = []
      return
    }
    if (now - this.at.docker < settings.dockerSeconds * 1000) return
    this.at.docker = now
    try {
      const format = '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project"}}\t{{.Names}}'
      const ps = parseDockerPs(await system.run(BIN.docker, ['ps', '--format', format], { timeout: 10_000 }))
      const stats = ps.length
        ? parseDockerStats(await system.run(BIN.docker, ['stats', '--no-stream', '--format', '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}'], { timeout: 20_000 }))
        : new Map<string, { cpu: number; memory: number }>()
      this.containers = ps.map((c) => ({ ...c, cpu: stats.get(c.id)?.cpu ?? 0, memory: stats.get(c.id)?.memory ?? 0 }))
    } catch {
      this.containers = [] // Docker is not running: no containers, not an error.
    }
  }

  private async refreshOrca(now: number): Promise<void> {
    if (now - this.at.orca < 15_000 && this.orcaWorktrees.length) return
    this.at.orca = now
    this.orcaWorktrees = await this.listWorktrees()
    this.gitRoots = new Map()
  }

  private async machine(): Promise<Machine> {
    const level = Number((await system.run(BIN.sysctl, ['-n', 'kern.memorystatus_vm_pressure_level']).catch(() => '1')).trim())
    return {
      memoryTotal: totalmem(),
      memoryUsed: this.physUsed,
      pressure: level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal',
      cores: cpus().length
    }
  }

  /** This worker and every process above it. */
  private protectedPids(): Set<number> {
    const byPid = new Map(this.lastProcs.map((p) => [p.pid, p]))
    const pids = new Set<number>([process.pid])
    for (let pid = process.ppid; pid > 1 && !pids.has(pid); pid = byPid.get(pid)?.ppid ?? 1) pids.add(pid)
    return pids
  }
}
