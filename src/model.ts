// Pure logic, no I/O: parse what ps, top, lsof and docker print, decide which worktree owns each
// process, and add it up per worktree. The sampler feeds it; the tests call it directly.

export type Proc = { pid: number; ppid: number; cpuSeconds: number; rss: number; command: string }

/** A worktree as Orca's `workspace.list` gives it. */
export type OrcaWorktree = { id: string; name: string; project: string | null; path: string; branch: string | null }

/** `shared`: tools that serve more than one worktree (tmux, build daemons, apps). Stop leaves
 *  them and shells alone. */
export type Kind = 'agent' | 'mcp' | 'dev-server' | 'test' | 'build' | 'package-manager' | 'browser' | 'shell' | 'shared' | 'other'

/** A worktree path, `docker:<project>` for a stack outside any worktree, or one of the buckets. */
export type OwnerKey = string
export const ORCA_APP = '@orca'
export const DOCKER_VM = '@docker'
export const OTHER = '@other'

// ---------------------------------------------------------------------------------------------
// Parsers

/** `ps -Ao pid=,ppid=,time=,rss=,command=`: time is [[dd-]hh:]mm:ss.cc, rss in KB. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: parseCpuTime(m[3]), rss: Number(m[4]) * 1024, command: m[5] })
  }
  return procs
}

export function parseCpuTime(t: string): number {
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t]
  return Number(days) * 86400 + rest.split(':').map(Number).reduce((total, part) => total * 60 + part, 0)
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
  const unit = (m[2] ?? 'B')[0].toUpperCase() as 'B' | 'K' | 'M' | 'G' | 'T'
  return Math.round(Number(m[1]) * { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }[unit])
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
    .filter((line) => line.trim())
    .map((line) => {
      const [id, workingDir, project, name] = line.split('\t')
      return { id, workingDir: workingDir ?? '', project: project ?? '', name: name || id }
    })
}

/** `docker stats --no-stream --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}'`. */
export function parseDockerStats(out: string): Map<string, { cpu: number; memory: number }> {
  const stats = new Map<string, { cpu: number; memory: number }>()
  for (const line of out.split('\n')) {
    const [id, cpu, mem] = line.split('\t')
    if (id && mem) stats.set(id, { cpu: Number.parseFloat(cpu) || 0, memory: parseSize(mem.split('/')[0]) })
  }
  return stats
}

// ---------------------------------------------------------------------------------------------
// Classification

// Order matters: `claude mcp serve` is an agent, `node …/mcp-server-github` an MCP server.
const KINDS: [Kind, RegExp][] = [
  ['shared', /\.app\/Contents\/|(^|\/)(tmux|screen|ssh-agent|gpg-agent|watchman)(\s|$)|GradleDaemon|turbo(d|\s+daemon)|nx\/.*daemon/i],
  ['agent', /(^|\/)(claude|codex|gemini|opencode|amp|cursor-agent|aider)(\s|$)|@anthropic-ai\/claude-code|claude-code\/cli|@openai\/codex/i],
  ['mcp', /\bmcp\b|mcp-server|server-[a-z-]+\.js|\bmcp\.m?[jt]s\b/i],
  ['test', /\b(vitest|jest|playwright|mocha|pytest|cypress)\b|\bnode --test\b|\.test\.[jt]sx?\b/],
  ['dev-server', /\b(vite|next(-server)?|nest start|nodemon|webpack(-dev-server)?|astro dev|remix dev|nuxt|storybook|uvicorn|rails s|tsx watch)\b|\b(dev|serve|start:dev)\s*$/],
  ['build', /\b(tsc|turbo|esbuild|rollup|swc|nest build|webpack|biome|eslint|oxlint|prettier|cargo|go build|gradle|xcodebuild|swift-build)\b/],
  ['package-manager', /\b(npm|pnpm|yarn|bun|npx|pip|uv)\b/],
  ['browser', /chrom(e|ium)|headless|Google Chrome for Testing/i],
  ['shell', /(^|\/)-?(zsh|bash|fish|sh)(\s|$)/]
]

export function classify(command: string): Kind {
  return KINDS.find(([, re]) => re.test(command))?.[0] ?? 'other'
}

/** "@playwright/mcp", "scripts/playwright/mcp.mts", "mcp-server-github" → "Playwright", "Github". */
export function mcpName(command: string): string {
  const m =
    /@([\w.-]+)[/+]mcp\b/.exec(command) ??
    /mcp-server-([\w.-]+)/.exec(command) ??
    /([\w.-]+)-mcp(-server)?\b/.exec(command) ??
    /\/([\w.-]+)\/mcp\.m?[jt]s\b/.exec(command)
  const name = m ? m[1].replace(/^\.+/, '').replace(/^modelcontextprotocol$/, '') : ''
  return name ? name[0].toUpperCase() + name.slice(1) : 'MCP'
}

const AGENT_TOOLS = [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['opencode', 'OpenCode'], ['cursor-agent', 'Cursor'], ['aider', 'Aider'], ['amp', 'Amp']] as const

/** Which coding agent a process is, for "3 Claude · 1 Codex". */
export function agentTool(command: string): string {
  const c = command.toLowerCase()
  return AGENT_TOOLS.find(([needle]) => c.includes(needle))?.[1] ?? 'Agent'
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
 * 2. it is Docker Desktop or its VM;
 * 3. it inherits its parent's owner (a dev server started by a shell in the worktree, an MCP
 *    server started by an agent);
 * 4. it is Orca's app process, or under it;
 * 5. anything else.
 */
export function attribute(procs: readonly Proc[], cwds: ReadonlyMap<number, string>, resolver: Resolver, home: string): Map<number, OwnerKey> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const owners = new Map<number, OwnerKey>()
  const orcaPid = procs.find((p) => /\/Orca\.app\/Contents\/MacOS\/Orca$/.test(p.command))?.pid
  const dockerRunning = procs.some((p) => /\/Docker\.app\//.test(p.command))

  const own = (p: Proc): OwnerKey | null => {
    const cwd = cwds.get(p.pid)
    const root = cwd && cwd !== '/' && cwd !== home ? resolver.rootFor(cwd) : null
    if (root) return root
    if (/\/Docker\.app\/|com\.docker\./.test(p.command) || (dockerRunning && isDockerVmProcess(p.command))) return DOCKER_VM
    if (p.pid === orcaPid) return ORCA_APP
    return null
  }

  const resolve = (pid: number, depth = 0): OwnerKey => {
    const known = owners.get(pid)
    if (known) return known
    const p = byPid.get(pid)
    if (!p || depth > 64) return OTHER
    const owner = own(p) ?? (p.ppid > 1 ? resolve(p.ppid, depth + 1) : OTHER)
    owners.set(pid, owner)
    return owner
  }

  for (const p of procs) resolve(p.pid)
  return owners
}

/**
 * Where a Docker container is counted: the worktree around its compose folder, or a
 * `docker:<project>` row of its own, `gone` when that folder no longer exists. A container
 * started without compose has no folder and is left in the Docker row.
 */
export function containerOwner(c: Pick<Container, 'workingDir' | 'project'>, resolver: Resolver): { key: OwnerKey; gone: boolean } | null {
  if (!c.workingDir) return null
  const root = resolver.rootFor(c.workingDir)
  if (root) return { key: root, gone: false }
  return { key: `docker:${c.project || c.workingDir}`, gone: !resolver.exists(c.workingDir) }
}

// ---------------------------------------------------------------------------------------------
// Roll-up

export type Usage = { cpu: number; memory: number }

export type OwnerLoad = {
  key: OwnerKey
  name: string
  repo: string | null
  branch: string | null
  /** In Orca's sidebar, as opposed to a git checkout found on disk. */
  orca: boolean
  /** A Docker stack still running for a folder that no longer exists. */
  gone: boolean
  /** CPU in % of one core, memory in bytes, of its processes (Docker is in `docker`). */
  cpu: number
  memory: number
  processes: number
  /** `count` is how many separate things run (a process whose parent is not of the same kind),
   *  `processes` how many processes they hold: one Playwright MCP server is about 5 processes. */
  kinds: Partial<Record<Kind, Usage & { count: number; processes: number }>>
  /** Agent sessions by tool: { Claude: 3, Codex: 1 }. */
  agents: Record<string, number>
  /** MCP servers by name: { Playwright: 9, Github: 1 }. */
  mcp: Record<string, number>
  /** Its containers, and its share of the Docker VM. */
  docker: Usage & { containers: (Usage & { name: string })[] }
}

export type Machine = { memoryTotal: number; memoryUsed: number | null; pressure: 'normal' | 'warning' | 'critical'; cores: number }

export type Snapshot = {
  at: number
  machine: Machine
  worktrees: OwnerLoad[]
  orcaApp: OwnerLoad
  dockerVm: OwnerLoad
  other: OwnerLoad
  error?: string
}

export const totalOf = (o: OwnerLoad): Usage => ({ cpu: o.cpu + o.docker.cpu, memory: o.memory + o.docker.memory })

/** Kinds Stop never ends. */
export const KEPT_ON_STOP: readonly Kind[] = ['shell', 'shared']

/** Running something Stop would end: a worktree with only shells and shared tools counts as idle. */
export const isRunning = (o: OwnerLoad): boolean =>
  o.processes - KEPT_ON_STOP.reduce((n, k) => n + (o.kinds[k]?.processes ?? 0), 0) > 0 || o.docker.containers.length > 0

function emptyOwner(key: OwnerKey, name: string): OwnerLoad {
  return { key, name, repo: null, branch: null, orca: false, gone: false, cpu: 0, memory: 0, processes: 0, kinds: {}, agents: {}, mcp: {}, docker: { cpu: 0, memory: 0, containers: [] } }
}

/** "~/.worktrees/repo-abc/agent-123" → name "agent-123", repo "repo-abc". */
function describePath(path: string): { name: string; repo: string | null } {
  const parts = path.split('/').filter(Boolean)
  return { name: parts.at(-1) ?? path, repo: parts.at(-2) ?? null }
}

const BUCKET_NAMES: Record<string, string> = { [ORCA_APP]: 'Orca', [DOCKER_VM]: 'Docker', [OTHER]: 'Everything else' }

export function rollUp(input: {
  procs: readonly Proc[]
  owners: ReadonlyMap<number, OwnerKey>
  /** Per PID: CPU in % of one core, footprint in bytes (RSS when missing). */
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
      const w = orcaByPath.get(key)
      const d = describePath(key)
      o = BUCKET_NAMES[key]
        ? emptyOwner(key, BUCKET_NAMES[key])
        : { ...emptyOwner(key, w?.name ?? d.name), repo: w?.project ?? d.repo, branch: w?.branch ?? null, orca: !!w }
      table.set(key, o)
    }
    return o
  }

  const byPid = new Map(input.procs.map((p) => [p.pid, p]))
  const kindOf = new Map(input.procs.map((p) => [p.pid, classify(p.command)]))
  for (const p of input.procs) {
    const ownerKey = input.owners.get(p.pid) ?? OTHER
    const o = get(ownerKey)
    const cpu = input.cpu.get(p.pid) ?? 0
    const memory = input.memory.get(p.pid) ?? p.rss
    const kind = kindOf.get(p.pid)!
    const parent = byPid.get(p.ppid)
    // A new "thing" starts where the kind or the owner changes: the 5 processes of one MCP server
    // count as one server.
    const first = !parent || kindOf.get(parent.pid) !== kind || (input.owners.get(parent.pid) ?? OTHER) !== ownerKey
    o.cpu += cpu
    o.memory += memory
    o.processes++
    const k = (o.kinds[kind] ??= { cpu: 0, memory: 0, count: 0, processes: 0 })
    k.cpu += cpu
    k.memory += memory
    k.processes++
    if (!first) continue
    k.count++
    if (kind === 'agent') o.agents[agentTool(p.command)] = (o.agents[agentTool(p.command)] ?? 0) + 1
    if (kind === 'mcp') o.mcp[mcpName(p.command)] = (o.mcp[mcpName(p.command)] ?? 0) + 1
  }

  // Containers run inside Docker's VM, which macOS sees as one process. A worktree gets what its
  // containers use (docker stats), capped by their share of the VM; that part leaves the Docker row
  // so nothing is counted twice. The VM's own overhead stays in the Docker row.
  const vm = input.procs.filter((p) => input.owners.get(p.pid) === DOCKER_VM && isDockerVmProcess(p.command))
  const vmMemory = vm.reduce((n, p) => n + (input.memory.get(p.pid) ?? p.rss), 0)
  const vmCpu = vm.reduce((n, p) => n + (input.cpu.get(p.pid) ?? 0), 0)
  const used = input.containers.reduce((n, c) => n + c.memory, 0)
  const busy = input.containers.reduce((n, c) => n + c.cpu, 0)
  const counted = { cpu: 0, memory: 0 }
  for (const c of input.containers) {
    const owner = containerOwner(c, input.resolver)
    if (!owner) continue
    const o = get(owner.key)
    if (owner.key.startsWith('docker:')) {
      o.name = c.project || c.workingDir
      o.repo = null
      o.gone = owner.gone
    }
    const memory = vm.length && used ? Math.min(c.memory, (vmMemory * c.memory) / used) : c.memory
    const cpu = vm.length && busy ? Math.min(c.cpu, (vmCpu * c.cpu) / busy) : c.cpu
    o.docker.memory += memory
    o.docker.cpu += cpu
    o.docker.containers.push({ name: c.name, cpu: c.cpu, memory: c.memory })
    counted.memory += memory
    counted.cpu += cpu
  }
  if (vm.length) {
    const dockerVm = get(DOCKER_VM)
    dockerVm.memory = Math.max(0, dockerVm.memory - counted.memory)
    dockerVm.cpu = Math.max(0, dockerVm.cpu - counted.cpu)
  }

  // Every Orca worktree shows up, even idle.
  for (const w of input.orcaWorktrees) get(w.path)

  return {
    at: input.at,
    machine: input.machine,
    worktrees: [...table.values()].filter((o) => !BUCKET_NAMES[o.key]),
    orcaApp: get(ORCA_APP),
    dockerVm: get(DOCKER_VM),
    other: get(OTHER)
  }
}
