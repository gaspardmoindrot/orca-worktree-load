// The right-sidebar panel. The worker measures and posts a snapshot after every sample; this only
// draws it: the machine, one row per worktree, and the detail of the selected one.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Heading,
  KeyValue,
  plugin,
  read,
  Row,
  set,
  Stack,
  Switch,
  Table,
  Text,
  type PanelContext,
  type TableRow,
  type TableSort
} from 'orca'
import { formatBytes, formatCpu, sparkline, totalOf, type Kind, type OwnerLoad, type PanelPayload } from './model'

const data = atom<PanelPayload | null>(null)
const sort = atom<TableSort>('sort', { column: 'memory', direction: 'desc' }, { persist: 'plugin' })
const runningOnly = atom('runningOnly', true, { persist: 'plugin' })
const selected = atom<string | null>('selected', null, { persist: 'plugin' })

const KIND_LABEL: Record<Kind, string> = {
  agent: 'Agents',
  mcp: 'MCP servers',
  'dev-server': 'Dev servers',
  test: 'Tests',
  build: 'Builds',
  'package-manager': 'Package managers',
  browser: 'Browsers',
  shell: 'Shells',
  other: 'Other'
}

const SORT_KEYS: Record<string, (w: OwnerLoad) => number | string> = {
  name: (w) => w.name.toLowerCase(),
  cpu: (w) => totalOf(w).cpu,
  memory: (w) => totalOf(w).memory,
  docker: (w) => w.docker.memory,
  processes: (w) => w.processes
}

export function sortRows(list: readonly OwnerLoad[], s: TableSort): OwnerLoad[] {
  const key = SORT_KEYS[s.column] ?? SORT_KEYS.memory
  const dir = s.direction === 'asc' ? 1 : -1
  return [...list].sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0))
}

const isRunning = (w: OwnerLoad) => w.processes > 0 || w.docker.containers.length > 0

export function toRow(w: OwnerLoad, trend: number[] | undefined): TableRow {
  const t = totalOf(w)
  return {
    key: w.key,
    cells: {
      name: w.gone ? `${w.name} (deleted)` : w.orca ? w.name : `${w.name} ·`,
      cpu: isRunning(w) ? formatCpu(t.cpu) : '',
      memory: isRunning(w) ? formatBytes(t.memory) : '',
      trend: trend && trend.length > 1 ? sparkline(trend.slice(-40)) : '',
      docker: w.docker.containers.length ? formatBytes(w.docker.memory) : '',
      processes: w.processes || ''
    }
  }
}

const COLUMNS = [
  { key: 'name', label: 'Worktree', sortable: true, minWidth: 'md' as const },
  { key: 'memory', label: 'Memory', align: 'end' as const, sortable: true },
  { key: 'cpu', label: 'CPU', align: 'end' as const, sortable: true },
  { key: 'trend', label: 'Last hour', hideBelow: 'md' as const },
  { key: 'docker', label: 'Docker', align: 'end' as const, sortable: true, hideBelow: 'sm' as const },
  { key: 'processes', label: 'Procs', align: 'end' as const, sortable: true, hideBelow: 'md' as const }
]

function Detail({ w, trend }: { w: OwnerLoad; trend?: PanelPayload['trends'][string] }) {
  const t = totalOf(w)
  const kinds = Object.entries(w.kinds)
    .filter(([, v]) => v && (v.memory > 0 || v.cpu > 0))
    .sort(([, a], [, b]) => (b?.memory ?? 0) - (a?.memory ?? 0))
  return (
    <Card
      title={w.name}
      description={[w.repo, w.branch, w.gone ? 'its folder no longer exists' : w.orca ? null : 'not in Orca'].filter(Boolean).join(' · ')}
    >
      <Stack gap="sm">
        <Text>
          {formatBytes(t.memory)} · {formatCpu(t.cpu)} · {w.processes} processes{w.agentState ? ` · agent ${w.agentState}` : ''}
        </Text>
        {trend && trend.memoryMb.length > 1 ? <Text muted size="xs">Memory, last hour: {sparkline(trend.memoryMb)}</Text> : null}
        <KeyValue
          label="By kind"
          items={[
            ...kinds.map(([kind, v]) => ({
              label: KIND_LABEL[kind as Kind],
              value: `${formatBytes(v!.memory)} · ${formatCpu(v!.cpu)} · ${v!.count}×`
            })),
            ...(w.docker.containers.length
              ? [{ label: 'Docker (share of the VM)', value: `${formatBytes(w.docker.memory)} · ${formatCpu(w.docker.cpu)} · ${w.docker.containers.length} containers` }]
              : [])
          ]}
        />
        {w.top.length ? (
          <Table
            label="Heaviest processes"
            columns={[
              { key: 'name', label: 'Process', minWidth: 'md' },
              { key: 'kind', label: 'Kind', hideBelow: 'sm' },
              { key: 'memory', label: 'Memory', align: 'end' },
              { key: 'cpu', label: 'CPU', align: 'end' },
              { key: 'pid', label: 'PID', align: 'end', hideBelow: 'md' }
            ]}
            rows={w.top.map((p) => ({ key: String(p.pid), cells: { name: p.name, kind: KIND_LABEL[p.kind], memory: formatBytes(p.memory), cpu: formatCpu(p.cpu), pid: p.pid } }))}
            maxHeight="sm"
          />
        ) : null}
        {w.docker.containers.length ? (
          <Table
            label="Containers"
            columns={[
              { key: 'name', label: 'Container', minWidth: 'md' },
              { key: 'memory', label: 'In the VM', align: 'end' },
              { key: 'cpu', label: 'CPU', align: 'end' }
            ]}
            rows={w.docker.containers.map((c) => ({ key: c.name, cells: { name: c.name, memory: formatBytes(c.memory), cpu: formatCpu(c.cpu) } }))}
            maxHeight="sm"
          />
        ) : null}
        {w.orca ? (
          <Button variant="ghost" size="sm" onPress={() => void plugin.request('load.open', { path: w.key })}>
            Open in Orca
          </Button>
        ) : null}
      </Stack>
    </Card>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('load.snapshot', (s) => set(data, s)))
  void plugin.request('load.get').then((s) => set(data, s))
}

export default function Panel() {
  const s = read(data)
  if (!s) return <Text muted>Measuring…</Text>
  const running = s.worktrees.filter(isRunning)
  const shown = read(runningOnly) ? running : s.worktrees
  const inWorktrees = running.reduce((acc, w) => ({ cpu: acc.cpu + totalOf(w).cpu, memory: acc.memory + totalOf(w).memory }), { cpu: 0, memory: 0 })
  const dockerAttributed = running.reduce((n, w) => n + w.docker.memory, 0)
  const gone = s.worktrees.filter((w) => w.gone)
  const goneMemory = gone.reduce((n, w) => n + w.docker.memory, 0)
  const m = s.machine
  const pick = s.worktrees.find((w) => w.key === read(selected))
  const total = s.trends['@total']

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Worktree load</Heading>
        <Badge tone={m.pressure === 'critical' ? 'danger' : m.pressure === 'warning' ? 'warning' : 'success'}>pressure {m.pressure}</Badge>
      </Row>
      {gone.length ? (
        <Callout tone="warning" title={`${gone.length} Docker ${gone.length === 1 ? 'stack' : 'stacks'} still running for deleted worktrees`}>
          {`${formatBytes(goneMemory)} of the Docker VM. docker compose -p <name> down stops one.`}
        </Callout>
      ) : null}
      {s.error ? (
        <Callout tone="warning" title="Last sample failed">
          {s.error}
        </Callout>
      ) : null}
      <KeyValue
        items={[
          { label: 'Mac', value: `${m.memoryUsed ? `${formatBytes(m.memoryUsed)} / ` : ''}${formatBytes(m.memoryTotal)} · load ${m.load1.toFixed(1)} on ${m.cores} cores` },
          { label: `In ${running.length} worktrees`, value: `${formatBytes(inWorktrees.memory)} · ${formatCpu(inWorktrees.cpu)}` },
          { label: 'Docker, not in a worktree', value: `${formatBytes(s.dockerVm.memory)}${dockerAttributed ? ` (+ ${formatBytes(dockerAttributed)} counted in worktrees)` : ''}` },
          { label: 'Orca app', value: `${formatBytes(s.orcaApp.memory)} · ${formatCpu(s.orcaApp.cpu)}` },
          { label: 'Everything else', value: `${formatBytes(s.other.memory)} · ${formatCpu(s.other.cpu)}` }
        ]}
      />
      {total && total.memoryMb.length > 1 ? <Text muted size="xs">All processes, last hour: {sparkline(total.memoryMb)}</Text> : null}
      <Row justify="between">
        <Switch label="Only running" checked={read(runningOnly)} onChange={(v) => set(runningOnly, v)} />
        <Button variant="ghost" size="sm" icon="refresh" onPress={() => void plugin.request('load.refresh').then((n) => set(data, n))}>
          Refresh
        </Button>
      </Row>
      <Table
        label="Worktrees"
        columns={COLUMNS}
        rows={sortRows(shown, read(sort)).map((w) => toRow(w, s.trends[w.key]?.memoryMb))}
        sort={read(sort)}
        onSortChange={(next) => set(sort, next)}
        selectionMode="single"
        selected={pick ? [pick.key] : []}
        onSelectionChange={({ keys }) => set(selected, keys[0] ?? null)}
        onRowAction={({ key }) => void plugin.request('load.open', { path: key })}
        emptyText="No worktree is running anything."
        maxHeight="md"
      />
      {pick ? <Detail w={pick} trend={s.trends[pick.key]} /> : <Text muted size="xs">Select a worktree for its processes and containers.</Text>}
      <Text muted size="xs">
        Memory is the footprint Activity Monitor shows; CPU is % of one core. A name ending in · is a git checkout Orca does not manage. Docker is the worktree's share of the Docker VM, split by its compose containers' memory and CPU.
      </Text>
    </Stack>
  )
}
