// Pure logic, no I/O: parse what ps, top, lsof and docker print, decide which worktree owns each
// process, and roll it up. The worker feeds it; the tests call it directly.

export type Proc = { pid: number; ppid: number; cpuSeconds: number; rss: number; command: string }

/** A worktree as Orca's `workspace.list` gives it. */
export type OrcaWorktree = {
  id: string
  name: string
  project: string | null
  path: string
  branch: string | null
  state: string | null
}

export type Kind = 'agent' | 'mcp' | 'dev-server' | 'test' | 'build' | 'package-manager' | 'browser' | 'shell' | 'other'

export type OwnerKey = string // a worktree path, or one of the buckets below
export const ORCA_APP = '@orca'
export const DOCKER_VM = '@docker'
export const OTHER = '@other'

// ---------------------------------------------------------------------------------------------
// Parsers

/** `ps -Ao pid=,ppid=,time=,rss=,command=`; time is [[dd-]hh:]mm:ss.cc, rss in KB. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: parseCpuTime(m[3]), rss: Number(m[4]) * 1024, command: m[5] })
  }
  return procs
}

export function parseCpuTime(t: string): number {
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t]
  const parts = rest.split(':').map(Number)
  let seconds = 0
  for (const p of parts) seconds = seconds * 60 + p
  return Number(days) * 86400 + seconds
}

/** `top -l 1 -stats pid,mem`: MEM is the footprint Activity Monitor shows ("19M", "8081K", "1.2G+"). */
export function parseTop(out: string): { footprints: Map<number, number>; physUsed: number | null } {
  const footprints = new Map<number, number>()
  let physUsed: number | null = null
  for (const line of out.split('\n')) {
    const phys = /^PhysMem:\s+([\d.]+[KMGT]?) used/.exec(line)
    if (phys) physUsed = parseSize(phys[1])
    const m = /^(\d+)\s+([\d.]+[BKMGT]?)[+-]?\s*$/.exec(line)
    if (m) footprints.set(Number(m[1]), parseSize(m[2]))
  }
  return { footprints, physUsed }
}

export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([BKMGT]i?B?)?$/i.exec(s.trim())
  if (!m) return 0
  const unit = (m[2] ?? 'B')[0].toUpperCase()
  const mult = { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }[unit] ?? 1
  return Math.round(Number(m[1]) * mult)
}

/** `lsof -a -d cwd -Fn ...`: lines "p<pid>", "fcwd", "n<path>". */
export function parseLsof(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

export type Container = { id: string; name: string; project: string; workingDir: string; cpu: number; memory: number }

/** `docker ps --format '{{.ID}}\t{{.Label "…working_dir"}}\t{{.Label "…project"}}\t{{.Names}}'`. */
export function parseDockerPs(out: string): Omit<Container, 'cpu' | 'memory'>[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [id, workingDir, project, name] = l.split('\t')
      return { id, workingDir: workingDir ?? '', project: project ?? '', name: name ?? id }
    })
}

/** `docker stats --no-stream --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}'`. */
export function parseDockerStats(out: string): Map<string, { cpu: number; memory: number }> {
  const stats = new Map<string, { cpu: number; memory: number }>()
  for (const l of out.split('\n')) {
    const [id, cpu, mem] = l.split('\t')
    if (!id || !mem) continue
    stats.set(id, { cpu: Number.parseFloat(cpu) || 0, memory: parseSize(mem.split('/')[0]) })
  }
  return stats
}

// ---------------------------------------------------------------------------------------------
// Classification

const KINDS: [Kind, RegExp][] = [
  ['mcp', /\bmcp\b|mcp-server|server-[a-z-]+\.js|\bmcp\.m?[jt]s\b/i],
  ['agent', /(^|\/)(claude|codex|gemini|opencode|amp|cursor-agent|aider)(\s|$)|@anthropic-ai\/claude-code|claude-code\/cli|@openai\/codex/i],
  ['test', /\b(vitest|jest|playwright|mocha|pytest|cypress)\b|\bnode --test\b|\.test\.[jt]sx?\b/],
  ['dev-server', /\b(vite|next(-server)?|nest start|nodemon|webpack(-dev-server)?|astro dev|remix dev|nuxt|storybook|uvicorn|rails s|tsx watch)\b|\b(dev|serve|start:dev)\s*$/],
  ['build', /\b(tsc|turbo|esbuild|rollup|swc|nest build|webpack|biome|eslint|oxlint|prettier|cargo|go build|gradle|xcodebuild|swift-build)\b/],
  ['package-manager', /\b(npm|pnpm|yarn|bun|npx|pip|uv)\b/],
  ['browser', /chrom(e|ium)|headless|Google Chrome for Testing|playwright.*browser/i],
  ['shell', /(^|\/)-?(zsh|bash|fish|sh)(\s|$)/]
]

export function classify(command: string): Kind {
  for (const [kind, re] of KINDS) if (re.test(command)) return kind
  return 'other'
}

/** A short process name: the binary, or the script for node/python/bun. */
export function shortName(command: string): string {
  const parts = command.split(/\s+/)
  const base = (s: string) => s.split('/').pop() ?? s
  const bin = base(parts[0])
  if (/^(node|bun|python3?|deno)$/.test(bin)) {
    const script = parts.slice(1).find((p) => !p.startsWith('-'))
    if (script) return `${bin} ${base(script)}`
  }
  return bin.length > 40 ? `${bin.slice(0, 39)}…` : bin
}

// ---------------------------------------------------------------------------------------------
// Attribution

export type Resolver = {
  /** The worktree that holds `dir`: an Orca worktree, else the nearest git checkout, else null. */
  rootFor(dir: string): string | null
  /** Whether `dir` is still on disk (a Docker stack can outlive its worktree). */
  exists(dir: string): boolean
}

/** Docker Desktop's VM: the Virtualization.framework process holds the guest's memory. */
export const isDockerVmProcess = (command: string) => /com\.apple\.Virtualization\.VirtualMachine|com\.docker\.hyperkit|qemu-system/.test(command)

/**
 * Who owns each process, in this order:
 * 1. its working directory lies in a worktree (an Orca one first, any git checkout otherwise);
 * 2. it is Docker Desktop's VM or its helpers;
 * 3. it inherits its parent's owner (a dev server started by a shell in the worktree, an MCP
 *    server started by an agent);
 * 4. it is under Orca's app process (Orca itself and its helpers);
 * 5. anything else.
 */
export function attribute(
  procs: readonly Proc[],
  cwds: ReadonlyMap<number, string>,
  resolver: Resolver,
  home: string
): Map<number, OwnerKey> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const owners = new Map<number, OwnerKey>()
  const orcaPid = procs.find((p) => /\/Orca\.app\/Contents\/MacOS\/Orca$/.test(p.command))?.pid
  const dockerRunning = procs.some((p) => /\/Docker\.app\//.test(p.command))

  const own = (p: Proc): OwnerKey | null => {
    const cwd = cwds.get(p.pid)
    if (cwd && cwd !== '/' && cwd !== home) {
      const root = resolver.rootFor(cwd)
      if (root) return root
    }
    if (/\/Docker\.app\/|com\.docker\./.test(p.command) || (dockerRunning && isDockerVmProcess(p.command))) return DOCKER_VM
    if (p.pid === orcaPid) return ORCA_APP
    return null
  }

  const resolve = (pid: number, depth = 0): OwnerKey => {
    const known = owners.get(pid)
    if (known) return known
    const p = byPid.get(pid)
    if (!p || depth > 64) return OTHER
    const direct = own(p)
    const owner = direct ?? (p.ppid > 1 ? resolve(p.ppid, depth + 1) : OTHER)
    owners.set(pid, owner)
    return owner
  }

  for (const p of procs) resolve(p.pid)
  return owners
}

// ---------------------------------------------------------------------------------------------
// Roll-up

export type ProcLoad = { pid: number; name: string; kind: Kind; cpu: number; memory: number }

export type OwnerLoad = {
  key: OwnerKey
  name: string
  repo: string | null
  branch: string | null
  /** Known to Orca (in its sidebar), or a git checkout found on disk. */
  orca: boolean
  /** A Docker stack still running for a folder that no longer exists. */
  gone: boolean
  agentState: string | null
  cpu: number
  memory: number
  processes: number
  kinds: Partial<Record<Kind, { cpu: number; memory: number; count: number }>>
  top: ProcLoad[]
  /** The worktree's share of the Docker VM, split by its containers' memory and CPU. */
  docker: { cpu: number; memory: number; containers: { name: string; cpu: number; memory: number }[] }
}

export type Machine = {
  memoryTotal: number
  memoryUsed: number | null
  pressure: 'normal' | 'warning' | 'critical'
  cores: number
  load1: number
  /** Sum of every process we can read, in % of one core. */
  cpu: number
}

/** What the panel gets: the snapshot and, per worktree, the last hour (memory in MB, CPU in %). */
export type PanelPayload = Snapshot & { trends: Record<string, { memoryMb: number[]; cpu: number[] }> }

export type Snapshot = {
  at: number
  machine: Machine
  worktrees: OwnerLoad[]
  orcaApp: OwnerLoad
  dockerVm: OwnerLoad
  other: OwnerLoad
  error?: string
}

function emptyOwner(key: OwnerKey, name: string): OwnerLoad {
  return { key, name, repo: null, branch: null, orca: false, gone: false, agentState: null, cpu: 0, memory: 0, processes: 0, kinds: {}, top: [], docker: { cpu: 0, memory: 0, containers: [] } }
}

/** "~/.worktrees/repo-abc/agent-123" → name "agent-123", repo "repo-abc". */
function describePath(path: string): { name: string; repo: string | null } {
  const parts = path.split('/').filter(Boolean)
  return { name: parts.at(-1) ?? path, repo: parts.at(-2) ?? null }
}

export function rollUp(input: {
  procs: readonly Proc[]
  owners: ReadonlyMap<number, OwnerKey>
  cpu: ReadonlyMap<number, number>
  memory: ReadonlyMap<number, number>
  orcaWorktrees: readonly OrcaWorktree[]
  containers: readonly Container[]
  resolver: Resolver
  machine: Machine
  at: number
}): Snapshot {
  const orcaByPath = new Map(input.orcaWorktrees.map((w) => [w.path, w]))
  const table = new Map<OwnerKey, OwnerLoad>()
  const get = (key: OwnerKey): OwnerLoad => {
    let o = table.get(key)
    if (!o) {
      if (key === ORCA_APP) o = emptyOwner(key, 'Orca')
      else if (key === DOCKER_VM) o = emptyOwner(key, 'Docker Desktop (VM)')
      else if (key === OTHER) o = emptyOwner(key, 'Everything else')
      else {
        const w = orcaByPath.get(key)
        const d = describePath(key)
        o = { ...emptyOwner(key, w?.name ?? d.name), repo: w?.project ?? d.repo, branch: w?.branch ?? null, orca: !!w, agentState: w?.state ?? null }
      }
      table.set(key, o)
    }
    return o
  }

  for (const p of input.procs) {
    const o = get(input.owners.get(p.pid) ?? OTHER)
    const cpu = input.cpu.get(p.pid) ?? 0
    const memory = input.memory.get(p.pid) ?? p.rss
    const kind = classify(p.command)
    o.cpu += cpu
    o.memory += memory
    o.processes++
    const k = (o.kinds[kind] ??= { cpu: 0, memory: 0, count: 0 })
    k.cpu += cpu
    k.memory += memory
    k.count++
    o.top.push({ pid: p.pid, name: shortName(p.command), kind, cpu, memory })
  }

  // Containers live inside Docker's VM, which macOS sees as one process. Each worktree gets a share
  // of the VM's footprint and CPU, in proportion to its containers' memory and CPU, and that share
  // leaves the Docker VM row, so nothing is counted twice. The rest of the VM stays there.
  const vm = input.procs.filter((p) => input.owners.get(p.pid) === DOCKER_VM && isDockerVmProcess(p.command))
  const vmMemory = vm.reduce((n, p) => n + (input.memory.get(p.pid) ?? p.rss), 0)
  const vmCpu = vm.reduce((n, p) => n + (input.cpu.get(p.pid) ?? 0), 0)
  const used = input.containers.reduce((n, c) => n + c.memory, 0)
  const busy = input.containers.reduce((n, c) => n + c.cpu, 0)
  const memoryShare = (c: Container) => (vmMemory && used ? Math.min(vmMemory, (vmMemory * c.memory) / used) : c.memory)
  const cpuShare = (c: Container) => (vmCpu && busy ? (vmCpu * c.cpu) / busy : c.cpu)
  for (const c of input.containers) {
    if (!c.workingDir) continue
    const root = input.resolver.rootFor(c.workingDir)
    let o: OwnerLoad
    if (root) o = get(root)
    else {
      // No worktree around the compose folder: group by project, and say if the folder is gone.
      o = get(`docker:${c.project || c.workingDir}`)
      o.name = c.project || c.workingDir
      o.repo = null
      o.gone = !input.resolver.exists(c.workingDir)
    }
    const share = { cpu: cpuShare(c), memory: memoryShare(c) }
    o.docker.cpu += share.cpu
    o.docker.memory += share.memory
    o.docker.containers.push({ name: c.name, cpu: c.cpu, memory: c.memory })
  }
  if (vmMemory && used) {
    const dockerVm = get(DOCKER_VM)
    const attributed = [...table.values()].reduce((n, o) => n + o.docker.memory, 0)
    const attributedCpu = [...table.values()].reduce((n, o) => n + o.docker.cpu, 0)
    dockerVm.memory = Math.max(0, dockerVm.memory - attributed)
    dockerVm.cpu = Math.max(0, dockerVm.cpu - attributedCpu)
  }

  // Every Orca worktree shows up, even idle.
  for (const w of input.orcaWorktrees) get(w.path)

  for (const o of table.values()) o.top = o.top.sort((a, b) => b.memory - a.memory).slice(0, 8)

  const buckets = new Set([ORCA_APP, DOCKER_VM, OTHER])
  return {
    at: input.at,
    machine: input.machine,
    worktrees: [...table.values()].filter((o) => !buckets.has(o.key)),
    orcaApp: get(ORCA_APP),
    dockerVm: get(DOCKER_VM),
    other: get(OTHER),
  }
}

// ---------------------------------------------------------------------------------------------
// History: one bucket per `bucketMs`, averaged, kept for `buckets` buckets.

export type Point = { at: number; cpu: number; memory: number }
export type History = Record<OwnerKey, Point[]>

export function record(history: History, s: Snapshot, bucketMs: number, buckets: number): History {
  const at = Math.floor(s.at / bucketMs) * bucketMs
  const next: History = {}
  const all = [...s.worktrees, s.orcaApp, s.dockerVm, s.other]
  const total = { cpu: 0, memory: 0 }
  for (const o of all) {
    total.cpu += o.cpu
    total.memory += o.memory
  }
  const rows: [OwnerKey, { cpu: number; memory: number }][] = [
    ...s.worktrees.map((o): [OwnerKey, { cpu: number; memory: number }] => [o.key, { cpu: o.cpu + o.docker.cpu, memory: o.memory + o.docker.memory }]),
    ['@total', total]
  ]
  for (const [key, v] of rows) {
    const points = [...(history[key] ?? [])]
    const last = points.at(-1)
    if (last && last.at === at) {
      // Running average inside the bucket, weighted by how many samples it holds.
      const n = (last as Point & { n?: number }).n ?? 1
      points[points.length - 1] = { at, cpu: (last.cpu * n + v.cpu) / (n + 1), memory: (last.memory * n + v.memory) / (n + 1), n: n + 1 } as Point
    } else {
      points.push({ at, cpu: v.cpu, memory: v.memory })
    }
    next[key] = points.filter((p) => p.at > at - bucketMs * buckets)
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// Formatting

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[], max?: number): string {
  if (values.length === 0) return ''
  const top = max ?? Math.max(...values, 1)
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.max(0, Math.round((v / top) * (BARS.length - 1))))]).join('')
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

export const totalOf = (o: OwnerLoad) => ({ cpu: o.cpu + o.docker.cpu, memory: o.memory + o.docker.memory })

export function statusBar(s: Snapshot): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  if (s.error && s.worktrees.length === 0) return { text: 'Load: ?', tone: 'warning', tooltip: s.error }
  const live = s.worktrees.filter((w) => w.processes > 0 || w.docker.containers.length > 0)
  const sum = live.reduce((acc, w) => ({ cpu: acc.cpu + totalOf(w).cpu, memory: acc.memory + totalOf(w).memory }), { cpu: 0, memory: 0 })
  const top = [...live].sort((a, b) => totalOf(b).memory - totalOf(a).memory).slice(0, 3)
  const m = s.machine
  const tooltip = [
    `${live.length} worktrees running: ${formatBytes(sum.memory)} · ${formatCpu(sum.cpu)}`,
    `Machine: ${m.memoryUsed ? `${formatBytes(m.memoryUsed)} / ` : ''}${formatBytes(m.memoryTotal)} · pressure ${m.pressure} · load ${m.load1.toFixed(1)}`,
    ...top.map((w) => `${w.name}: ${formatBytes(totalOf(w).memory)} · ${formatCpu(totalOf(w).cpu)}`)
  ].join('\n')
  const tone = m.pressure === 'critical' ? 'danger' : m.pressure === 'warning' ? 'warning' : 'neutral'
  return { text: `${formatBytes(sum.memory)} · ${formatCpu(sum.cpu)} in ${live.length} worktrees`, tone, tooltip }
}
