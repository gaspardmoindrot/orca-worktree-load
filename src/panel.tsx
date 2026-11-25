// The right-sidebar panel: one row per worktree, sorted by what you pick. The worker does all
// the measuring and posts a snapshot after every poll; this only draws it.
import {
  atom,
  Badge,
  Button,
  Callout,
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
import { formatBytes, formatCpu, sparkline, type Snapshot, type WorktreeLoad } from './load'

const snapshot = atom<Snapshot | null>(null)
const sort = atom<TableSort>('sort', { column: 'memory', direction: 'desc' }, { persist: 'plugin' })
const liveOnly = atom('liveOnly', true, { persist: 'plugin' })

const SORT_KEYS: Record<string, (w: WorktreeLoad) => number | string> = {
  name: (w) => w.name.toLowerCase(),
  cpu: (w) => w.cpu,
  memory: (w) => w.memory,
  agents: (w) => w.agents.working * 1000 + w.agents.total,
  terminals: (w) => w.terminals,
  diff: (w) => (w.disk.diffAdded ?? 0) + (w.disk.diffRemoved ?? 0),
  disk: (w) => w.disk.diskBytes ?? -1,
  active: (w) => w.lastActivityAt ?? 0
}

export function sortRows(list: readonly WorktreeLoad[], s: TableSort): WorktreeLoad[] {
  const key = SORT_KEYS[s.column] ?? SORT_KEYS.memory
  const dir = s.direction === 'asc' ? 1 : -1
  return [...list].sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0))
}

function agentsCell(w: WorktreeLoad): string {
  if (w.agents.total === 0) return ''
  const parts = []
  if (w.agents.working) parts.push(`${w.agents.working} working`)
  if (w.agents.waiting) parts.push(`${w.agents.waiting} waiting`)
  if (w.agents.done) parts.push(`${w.agents.done} idle`)
  return parts.join(', ')
}

function diffCell(w: WorktreeLoad): string {
  if (w.disk.diffFiles === undefined) return ''
  if (w.disk.diffFiles === 0) return 'clean'
  return `${w.disk.diffFiles}f +${w.disk.diffAdded} -${w.disk.diffRemoved}`
}

export function toRow(w: WorktreeLoad, maxCpu: number): TableRow {
  return {
    key: w.path,
    cells: {
      name: w.name,
      cpu: w.processes ? formatCpu(w.cpu) : '',
      trend: w.processes ? sparkline(w.cpuHistory, maxCpu) : '',
      memory: w.processes ? formatBytes(w.memory) : '',
      agents: agentsCell(w),
      terminals: w.terminals || '',
      diff: diffCell(w),
      disk: w.disk.diskBytes === undefined ? '' : formatBytes(w.disk.diskBytes),
      active: w.lastActivityAt ? { type: 'relative', at: w.lastActivityAt, format: 'short' } : null
    }
  }
}

const COLUMNS = [
  { key: 'name', label: 'Worktree', sortable: true, minWidth: 'md' as const },
  { key: 'cpu', label: 'CPU', align: 'end' as const, sortable: true },
  { key: 'trend', label: 'Trend', hideBelow: 'md' as const },
  { key: 'memory', label: 'RAM', align: 'end' as const, sortable: true },
  { key: 'agents', label: 'Agents', sortable: true, hideBelow: 'sm' as const },
  { key: 'terminals', label: 'Terms', align: 'end' as const, sortable: true, hideBelow: 'md' as const },
  { key: 'diff', label: 'Diff', sortable: true, hideBelow: 'md' as const },
  { key: 'disk', label: 'Disk', align: 'end' as const, sortable: true, hideBelow: 'sm' as const },
  { key: 'active', label: 'Active', sortable: true, hideBelow: 'md' as const }
]

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('load.snapshot', (s) => set(snapshot, s)))
  void plugin.request('load.get').then((s) => set(snapshot, s))
}

export default function Panel() {
  const s = read(snapshot)
  if (!s) return <Text muted>Measuring…</Text>
  const all = s.worktrees
  const live = all.filter((w) => w.processes > 0 || w.terminals > 0 || w.agents.total > 0)
  const shown = read(liveOnly) ? live : all
  const maxCpu = Math.max(100, ...all.flatMap((w) => w.cpuHistory))
  const working = all.reduce((n, w) => n + w.agents.working, 0)
  const heaviest = [...live].sort((a, b) => b.memory - a.memory)[0]
  const ramShare = s.host.totalMemory ? Math.round((100 * s.totalMemory) / s.host.totalMemory) : 0

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Worktree load</Heading>
        <Row gap="xs">
          {working ? <Badge tone="accent">{working} working</Badge> : null}
          <Badge>{live.length}/{all.length} live</Badge>
        </Row>
      </Row>
      {s.error ? (
        <Callout tone="warning" title="Last poll failed">
          {s.error}
        </Callout>
      ) : null}
      <KeyValue
        items={[
          { label: 'Agents + terminals', value: `${formatCpu(s.totalCpu)} CPU · ${formatBytes(s.totalMemory)} (${ramShare}% of RAM)` },
          {
            label: 'Machine',
            value: `${Math.round(s.host.memoryUsagePercent)}% RAM used · load ${s.host.loadAverage1m.toFixed(1)} / ${s.host.cpuCoreCount} cores`,
            tone: s.host.memoryUsagePercent > 85 ? 'danger' : s.host.memoryUsagePercent > 70 ? 'warning' : undefined
          },
          { label: 'Heaviest', value: heaviest ? `${heaviest.name} · ${formatBytes(heaviest.memory)}` : '-' }
        ]}
      />
      <Row justify="between">
        <Switch label="Only live worktrees" checked={read(liveOnly)} onChange={(v: boolean) => set(liveOnly, v)} />
        <Row gap="xs">
          <Button variant="ghost" size="sm" icon="refresh" onPress={() => void plugin.request('load.refresh').then((n) => set(snapshot, n))}>
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onPress={() => void plugin.request('load.scanDisk')}>
            Scan disk
          </Button>
        </Row>
      </Row>
      <Table
        label="Worktrees"
        columns={COLUMNS}
        rows={sortRows(shown, read(sort)).map((w) => toRow(w, maxCpu))}
        sort={read(sort)}
        onSortChange={(next) => set(sort, next)}
        onRowAction={({ key }) => void plugin.request('load.open', { path: key })}
        emptyText="No worktree is running anything."
        maxHeight="lg"
      />
      <Text muted size="xs">
        CPU is % of one core, summed over each terminal's process tree and agent chats, as Orca measures it. Double-click a row to open it.
      </Text>
    </Stack>
  )
}
