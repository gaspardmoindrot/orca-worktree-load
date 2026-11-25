// What the panel shows, as plain data and an HTML string. Pure, so tests can check it without a
// browser; src/panel.ts only puts it on the page and handles clicks.
import { type Kind, type OwnerLoad, type PanelPayload } from './model'

export function bytes(n: number): string {
  if (n >= 10 * 2 ** 30) return `${Math.round(n / 2 ** 30)} GB`
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`
  return `${Math.max(0, Math.round(n / 2 ** 10))} KB`
}

/** CPU as a share of the whole Mac; `cpu` is in % of one core. */
export function cpuShare(cpu: number, cores: number): number {
  return cpu / Math.max(1, cores)
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const total = (w: OwnerLoad) => ({ cpu: w.cpu + w.docker.cpu, memory: w.memory + w.docker.memory })
const running = (w: OwnerLoad) => w.processes > 0 || w.docker.containers.length > 0

/** Busy enough to mention: 3% of the whole Mac is a full core on most machines. */
const BUSY = 3

export type Group = { label: string; count: number; bytes: number }

export type Row = {
  key: string
  name: string
  /** "3 Claude · 45 MCP · Docker": what runs there, in a few words. */
  summary: string
  bytes: number
  /** "12% CPU" when the worktree is busy, else null. */
  cpu: string | null
  orca: boolean
  gone: boolean
  where: string
  groups: Group[]
  processes: { name: string; pid: number; bytes: number }[]
  containers: { name: string; bytes: number }[]
  trendMb: number[]
}

export type View = {
  used: number | null
  totalMemory: number
  pressure: 'normal' | 'warning' | 'critical'
  segments: { id: 'worktrees' | 'docker' | 'orca' | 'other'; label: string; bytes: number }[]
  orca: Row[]
  idle: string[]
  other: Row[]
  gone: Row[]
  max: number
}

const KIND_ORDER: [Kind, string][] = [
  ['dev-server', 'Dev servers'],
  ['test', 'Tests'],
  ['build', 'Builds'],
  ['mcp', 'MCP servers'],
  ['package-manager', 'Package managers'],
  ['browser', 'Browsers'],
  ['shell', 'Shells'],
  ['other', 'Other']
]

function summarize(w: OwnerLoad): string {
  const parts: string[] = []
  for (const [tool, n] of Object.entries(w.agents).sort((a, b) => b[1] - a[1])) parts.push(`${n} ${tool}`)
  const k = w.kinds
  if (k['dev-server']?.count) parts.push(k['dev-server'].count === 1 ? 'dev server' : `${k['dev-server'].count} dev servers`)
  if (k.test?.count) parts.push('tests')
  if (k.build?.count) parts.push('build')
  if (k.mcp?.count) parts.push(k.mcp.count === 1 ? '1 MCP server' : `${k.mcp.count} MCP servers`)
  if (w.docker.containers.length) parts.push(w.docker.containers.length === 1 ? '1 container' : `${w.docker.containers.length} containers`)
  if (parts.length === 0 && w.processes) parts.push(w.processes === 1 ? '1 process' : `${w.processes} processes`)
  return parts.join(' · ')
}

function toRow(w: OwnerLoad, cores: number, trendMb: number[] | undefined): Row {
  const t = total(w)
  const share = cpuShare(t.cpu, cores)
  const groups: Group[] = []
  const agents = w.kinds.agent
  if (agents?.count) {
    const tools = Object.keys(w.agents)
    groups.push({ label: tools.length === 1 ? `${tools[0]} sessions` : 'Agent sessions', count: agents.count, bytes: agents.memory })
  }
  for (const [kind, label] of KIND_ORDER) {
    const g = w.kinds[kind]
    if (!g?.count) continue
    if (kind === 'mcp') {
      // "MCP: playwright ×9, github": which servers, not how many processes they hold.
      const entries = Object.entries(w.mcp).sort((a, b) => b[1] - a[1])
      const names = entries.length === 1 ? entries[0][0] : entries.map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
      groups.push({ label: `MCP · ${names}`, count: g.count, bytes: g.memory })
    } else groups.push({ label, count: g.count, bytes: g.memory })
  }
  if (w.docker.containers.length) groups.push({ label: 'Docker', count: w.docker.containers.length, bytes: w.docker.memory })
  return {
    key: w.key,
    name: w.name,
    summary: summarize(w),
    bytes: t.memory,
    cpu: share >= BUSY ? `${Math.round(share)}% CPU` : null,
    orca: w.orca,
    gone: w.gone,
    where: [w.repo, w.branch].filter(Boolean).join(' · '),
    groups: groups.sort((a, b) => b.bytes - a.bytes),
    processes: w.top.slice(0, 5).map((p) => ({ name: p.name, pid: p.pid, bytes: p.memory })),
    containers: w.docker.containers.map((c) => ({ name: c.name, bytes: c.memory })),
    trendMb: trendMb ?? []
  }
}

export function buildView(p: PanelPayload): View {
  const cores = p.machine.cores
  const rows = p.worktrees.filter(running).map((w) => toRow(w, cores, p.trends[w.key]?.memoryMb))
  // Two rows with the same name (two checkouts of one repo): add each one's folder to tell them apart.
  const seen = new Map<string, number>()
  for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1)
  for (const r of rows) {
    if ((seen.get(r.name) ?? 0) > 1) {
      const folder = r.key.split('/').filter(Boolean).at(-1) ?? r.key
      if (folder !== r.name) r.summary = [r.summary, folder].filter(Boolean).join(' · ')
    }
  }
  const byBytes = (a: Row, b: Row) => b.bytes - a.bytes
  const inWorktrees = rows.reduce((n, r) => n + r.bytes, 0)
  const used = p.machine.memoryUsed
  const docker = p.dockerVm.memory
  const orcaApp = p.orcaApp.memory
  const rest = used !== null ? Math.max(0, used - inWorktrees - docker - orcaApp) : p.other.memory
  return {
    used,
    totalMemory: p.machine.memoryTotal,
    pressure: p.machine.pressure,
    segments: [
      { id: 'worktrees', label: 'Worktrees', bytes: inWorktrees },
      { id: 'docker', label: 'Docker', bytes: docker },
      { id: 'orca', label: 'Orca', bytes: orcaApp },
      { id: 'other', label: 'Other apps', bytes: rest }
    ],
    orca: rows.filter((r) => r.orca).sort(byBytes),
    idle: p.worktrees.filter((w) => w.orca && !running(w)).map((w) => w.name).sort(),
    other: rows.filter((r) => !r.orca && !r.gone).sort(byBytes),
    gone: rows.filter((r) => r.gone).sort(byBytes),
    max: Math.max(1, ...rows.map((r) => r.bytes))
  }
}

// ---------------------------------------------------------------------------------------------
// HTML

const pct = (part: number, whole: number) => `${Math.max(0, Math.min(100, (100 * part) / Math.max(1, whole))).toFixed(1)}%`

function trendSvg(mb: number[]): string {
  if (mb.length < 3) return ''
  const w = 240
  const h = 32
  const lo = Math.min(...mb)
  const hi = Math.max(...mb)
  const span = Math.max(1, hi - lo)
  const pts = mb.map((v, i) => `${((i / (mb.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`)
  return `<div class="trend">
    <div class="label"><span>Memory, last ${Math.max(1, Math.round((mb.length * 30) / 60))} min</span><span class="num">${bytes(lo * 2 ** 20)} – ${bytes(hi * 2 ** 20)}</span></div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="0,${h} ${pts.join(' ')} ${w},${h}" class="area"/>
      <polyline points="${pts.join(' ')}" class="line"/>
    </svg>
  </div>`
}

function detail(r: Row): string {
  const groups = r.groups
    .map(
      (g) => `<div class="g">
        <span class="g-name">${esc(g.label)}</span><span class="g-count num">${g.count}</span><span class="g-val num">${bytes(g.bytes)}</span>
        <span class="g-bar"><i style="width:${pct(g.bytes, r.bytes)}"></i></span>
      </div>`
    )
    .join('')
  const procs = r.processes.length
    ? `<div class="sub-h">Biggest processes</div>${r.processes
        .map((p) => `<div class="p"><span class="p-name">${esc(p.name)}</span><span class="p-pid num">${p.pid}</span><span class="num">${bytes(p.bytes)}</span></div>`)
        .join('')}`
    : ''
  const containers = r.containers.length
    ? `<div class="sub-h">Containers</div>${r.containers.map((c) => `<div class="p"><span class="p-name">${esc(c.name)}</span><span></span><span class="num">${bytes(c.bytes)}</span></div>`).join('')}`
    : ''
  const actions = r.orca ? `<div class="actions"><button class="link" data-open="${esc(r.key)}">Open in Orca</button></div>` : ''
  return `<div class="detail">
    ${r.where ? `<div class="where">${esc(r.where)}</div>` : ''}
    <div class="groups">${groups}</div>
    ${trendSvg(r.trendMb)}
    ${procs}${containers}${actions}
  </div>`
}

function row(r: Row, max: number, open: boolean): string {
  return `<div class="row${open ? ' open' : ''}">
    <button class="head" data-toggle="${esc(r.key)}" aria-expanded="${open}">
      <span class="chev" aria-hidden="true"></span>
      <span class="name" title="${esc(r.key)}">${esc(r.name)}</span>
      <span class="val num">${bytes(r.bytes)}</span>
      <span class="summary">${esc(r.summary)}</span>
      <span class="cpu num">${r.cpu ?? ''}</span>
      <span class="bar"><i style="width:${pct(r.bytes, max)}"></i></span>
    </button>
    ${open ? detail(r) : ''}
  </div>`
}

function section(title: string, rows: Row[], max: number, open: ReadonlySet<string>, extra = ''): string {
  if (rows.length === 0 && !extra) return ''
  const sum = rows.reduce((n, r) => n + r.bytes, 0)
  return `<section>
    <h2><span>${esc(title)}</span><span class="num">${rows.length ? bytes(sum) : ''}</span></h2>
    ${rows.map((r) => row(r, max, open.has(r.key))).join('')}
    ${extra}
  </section>`
}

export type UiState = { open: ReadonlySet<string>; showGone: boolean; showIdle: boolean; stale: boolean }

export function render(v: View, ui: UiState): string {
  const used = v.used ?? v.segments.reduce((n, s) => n + s.bytes, 0)
  const bar = v.segments
    .filter((s) => s.bytes > 0)
    .map((s) => `<i class="seg ${s.id}" style="width:${pct(s.bytes, v.totalMemory)}" title="${esc(s.label)}: ${bytes(s.bytes)}"></i>`)
    .join('')
  const legend = v.segments
    .filter((s) => s.bytes > 0)
    .map((s) => `<span class="key"><i class="dot ${s.id}"></i>${esc(s.label)} <span class="num">${bytes(s.bytes)}</span></span>`)
    .join('')
  const goneBytes = v.gone.reduce((n, r) => n + r.bytes, 0)
  const gone = v.gone.length
    ? `<div class="alert">
        <div class="alert-head">
          <span><b>${v.gone.length} Docker ${v.gone.length === 1 ? 'stack' : 'stacks'} left running</b> · <span class="num">${bytes(goneBytes)}</span></span>
          <button class="link" data-show-gone>${ui.showGone ? 'Hide' : 'Show'}</button>
        </div>
        <div class="alert-sub">Their worktrees were deleted, their containers were not.</div>
        ${
          ui.showGone
            ? `<div class="gone-list">${v.gone
                .map((r) => `<div class="gone"><span class="p-name">${esc(r.name)}</span><span class="num">${bytes(r.bytes)}</span><code>docker compose -p ${esc(r.name)} down</code></div>`)
                .join('')}</div>`
            : ''
        }
      </div>`
    : ''
  const idle = v.idle.length
    ? `<button class="idle link" data-show-idle>${ui.showIdle ? 'Hide' : 'Show'} ${v.idle.length} idle ${v.idle.length === 1 ? 'worktree' : 'worktrees'}</button>${
        ui.showIdle ? `<div class="idle-list">${v.idle.map(esc).join(' · ')}</div>` : ''
      }`
    : ''
  return `<header>
      <div class="title"><span>Memory</span><span class="live${ui.stale ? ' stale' : ''}" title="${ui.stale ? 'No new reading' : 'Live'}"></span>${
        v.pressure !== 'normal' ? `<span class="pressure ${v.pressure}">${v.pressure === 'critical' ? 'Critical' : 'High'} pressure</span>` : ''
      }</div>
      <div class="big"><span class="num">${bytes(used)}</span><span class="of">of ${bytes(v.totalMemory)} used</span></div>
      <div class="stack">${bar}</div>
      <div class="legend">${legend}</div>
    </header>
    ${gone}
    ${section('Orca worktrees', v.orca, v.max, ui.open, idle)}
    ${section('Other checkouts', v.other, v.max, ui.open)}
    ${v.orca.length + v.other.length === 0 ? '<p class="empty">No worktree is running anything.</p>' : ''}`
}

export const CSS = `
:root{
  --bg:var(--orca-background,#111);--fg:var(--orca-foreground,#eee);
  --muted:var(--orca-muted-foreground,color-mix(in srgb,var(--fg) 60%,var(--bg)));
  --line:var(--orca-border,color-mix(in srgb,var(--fg) 14%,var(--bg)));
  --hover:color-mix(in srgb,var(--fg) 6%,var(--bg));
  --track:color-mix(in srgb,var(--fg) 9%,var(--bg));
  --radius:var(--orca-radius,8px);
  --c-worktrees:#60a5fa;--c-docker:#22d3ee;--c-orca:#a78bfa;--c-other:color-mix(in srgb,var(--fg) 28%,var(--bg));
  --warn:#eab308;--warn-bg:color-mix(in srgb,#eab308 10%,var(--bg));--danger:var(--orca-destructive,#f87171);
}
html.light{--c-worktrees:#2563eb;--c-docker:#0891b2;--c-orca:#7c3aed;--warn:#a16207;--warn-bg:color-mix(in srgb,#ca8a04 12%,var(--bg))}
*{box-sizing:border-box;min-width:0}
html,body{overflow-x:hidden}
main,section,.row,.detail{width:100%;max-width:100%}
body{margin:0;padding:14px 12px 24px;font:12px/1.4 var(--orca-font-sans,system-ui),system-ui,sans-serif;color:var(--fg);background:var(--bg)}
.num{font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.link{color:var(--muted);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
.link:hover{color:var(--fg)}
header{margin-bottom:14px}
.title{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.live{width:6px;height:6px;border-radius:50%;background:#22c55e}
.live.stale{background:var(--muted)}
.pressure{margin-left:auto;text-transform:none;letter-spacing:0;font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid}
.pressure.warning{color:var(--warn);border-color:var(--warn)}
.pressure.critical{color:var(--danger);border-color:var(--danger)}
.big{display:flex;align-items:baseline;gap:6px;margin:4px 0 8px}
.big .num{font-size:22px;font-weight:600;letter-spacing:-.01em}
.big .of{color:var(--muted)}
.stack{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--track);gap:1px}
.seg{display:block;height:100%}
.seg.worktrees,.dot.worktrees{background:var(--c-worktrees)}
.seg.docker,.dot.docker{background:var(--c-docker)}
.seg.orca,.dot.orca{background:var(--c-orca)}
.seg.other,.dot.other{background:var(--c-other)}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;color:var(--muted)}
.key{display:inline-flex;align-items:center;gap:5px}
.key .num{color:var(--fg)}
.dot{width:7px;height:7px;border-radius:2px;display:inline-block}
.alert{border:1px solid color-mix(in srgb,var(--warn) 45%,var(--bg));background:var(--warn-bg);border-radius:var(--radius);padding:8px 10px;margin-bottom:14px}
.alert-head{display:flex;justify-content:space-between;gap:8px;color:var(--warn)}
.alert-head .link{color:var(--warn)}
.alert-sub{color:var(--muted);margin-top:2px}
.gone-list{margin-top:8px;display:grid;gap:6px}
.gone{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px}
.gone code{grid-column:1/-1;white-space:normal;word-break:break-all;font:11px var(--orca-font-mono,ui-monospace),monospace;color:var(--muted);user-select:all;overflow-wrap:anywhere}
section{margin-top:6px}
h2{display:flex;justify-content:space-between;margin:12px 0 4px;padding:0 6px;font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.row{border-radius:var(--radius)}
.row.open{background:var(--hover)}
.head{display:grid;width:100%;max-width:100%;grid-template-columns:10px minmax(0,1fr) auto;column-gap:6px;row-gap:0;padding:6px 6px 7px;border-radius:var(--radius)}
.head:hover{background:var(--hover)}
.chev{grid-row:1;align-self:center;width:0;height:0;border-left:4px solid var(--muted);border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;transition:transform .12s}
.open .chev{transform:rotate(90deg)}
.name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.val{font-weight:500}
.summary{grid-column:2;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpu{grid-column:3;color:var(--warn);text-align:right}
.bar{grid-column:2/4;height:2px;margin-top:5px;border-radius:999px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;min-width:2px;border-radius:999px;background:var(--c-worktrees);transition:width .4s}
.detail{padding:2px 8px 10px 22px}
.where{color:var(--muted);margin-bottom:8px;overflow-wrap:anywhere}
.groups{display:grid;gap:6px}
.g{display:grid;grid-template-columns:minmax(0,1fr) 28px 56px;column-gap:6px;align-items:baseline}
.g-count{color:var(--muted);text-align:right}
.g-val{text-align:right}
.g-bar{grid-column:1/-1;height:2px;border-radius:999px;background:var(--track);overflow:hidden}
.g-bar i{display:block;height:100%;background:color-mix(in srgb,var(--c-worktrees) 70%,var(--bg))}
.sub-h{margin:12px 0 4px;color:var(--muted);font-size:11px}
.p{display:grid;grid-template-columns:minmax(0,1fr) auto 56px;column-gap:8px;padding:1px 0}
.p .num:last-child{text-align:right}
.p-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p-pid{color:var(--muted)}
.trend{margin-top:12px}
.trend .label{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-bottom:3px}
.trend svg{display:block;width:100%;height:32px}
.trend .line{fill:none;stroke:var(--c-worktrees);stroke-width:1.5;vector-effect:non-scaling-stroke}
.trend .area{fill:color-mix(in srgb,var(--c-worktrees) 14%,transparent);stroke:none}
.actions{margin-top:10px}
.idle{display:block;margin:6px 6px 0;font-size:11px}
.idle-list{margin:4px 6px 0;color:var(--muted);font-size:11px}
.empty{color:var(--muted);text-align:center;margin-top:24px}
`
