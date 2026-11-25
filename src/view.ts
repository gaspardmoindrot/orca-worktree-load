// What the panel and the status bar show, as plain data and HTML strings. Pure, so tests check it
// without a browser; src/panel.ts only puts it on the page and handles clicks.
import { isRunning, totalOf, type Kind, type OwnerLoad, type Snapshot } from './model'

export function bytes(n: number): string {
  if (n >= 10 * 2 ** 30) return `${Math.round(n / 2 ** 30)} GB`
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`
  return `${Math.max(0, Math.round(n / 2 ** 10))} KB`
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Busy enough to mention, in % of the whole Mac: a full core on a 12-core Mac is 8%. */
const BUSY = 3

/** What a Stop ends, counted the way a person thinks of it. */
export type Stoppable = { agents: Record<string, number>; mcp: number; devServers: number; other: number; containers: number }

export type Group = { label: string; count: number; bytes: number }

export type Row = {
  key: string
  name: string
  /** "3 Claude · 9 MCP servers · 2 containers": what runs there, in a few words. */
  summary: string
  bytes: number
  /** "12% CPU" when the worktree is busy, else null. */
  cpu: string | null
  orca: boolean
  gone: boolean
  /** Where the memory goes, heaviest first. */
  groups: Group[]
  stoppable: Stoppable
}

export type Segment = { id: 'worktrees' | 'docker' | 'orca' | 'other'; label: string; bytes: number }

export type View = {
  used: number | null
  totalMemory: number
  pressure: 'normal' | 'warning' | 'critical'
  segments: Segment[]
  orca: Row[]
  idle: string[]
  other: Row[]
  gone: Row[]
  /** The heaviest row, which the row bars are scaled to. */
  max: number
}

const KIND_LABELS: [Kind, string][] = [
  ['dev-server', 'Dev servers'],
  ['test', 'Tests'],
  ['build', 'Builds'],
  ['mcp', 'MCP servers'],
  ['package-manager', 'Package managers'],
  ['browser', 'Browsers'],
  ['shell', 'Shells'],
  ['shared', 'Shared tools (not stopped)'],
  ['other', 'Other']
]

function summarize(w: OwnerLoad): string {
  const k = w.kinds
  const parts = Object.entries(w.agents)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => `${n} ${tool}`)
  if (k['dev-server']?.count) parts.push(k['dev-server'].count === 1 ? 'dev server' : `${k['dev-server'].count} dev servers`)
  if (k.test?.count) parts.push('tests')
  if (k.build?.count) parts.push('build')
  if (k.mcp?.count) parts.push(plural(k.mcp.count, 'MCP server'))
  if (w.docker.containers.length) parts.push(plural(w.docker.containers.length, 'container'))
  if (parts.length === 0 && w.processes) parts.push(plural(w.processes, 'process', 'processes'))
  return parts.join(' · ')
}

function groupsOf(w: OwnerLoad): Group[] {
  const groups: Group[] = []
  const agents = w.kinds.agent
  if (agents?.count) {
    const tools = Object.keys(w.agents)
    groups.push({ label: tools.length === 1 ? `${tools[0]} sessions` : 'Agent sessions', count: agents.count, bytes: agents.memory })
  }
  for (const [kind, label] of KIND_LABELS) {
    const g = w.kinds[kind]
    if (!g?.count) continue
    if (kind === 'mcp') {
      // Which servers, not how many processes they hold: "MCP · Playwright", "MCP · Github, Linear".
      const servers = Object.entries(w.mcp).sort((a, b) => b[1] - a[1])
      const names = servers.length === 1 ? servers[0][0] : servers.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
      groups.push({ label: `MCP · ${names}`, count: g.count, bytes: g.memory })
    } else groups.push({ label, count: g.count, bytes: g.memory })
  }
  if (w.docker.containers.length) groups.push({ label: 'Docker', count: w.docker.containers.length, bytes: w.docker.memory })
  return groups.sort((a, b) => b.bytes - a.bytes)
}

function toRow(w: OwnerLoad, cores: number): Row {
  const t = totalOf(w)
  const share = t.cpu / Math.max(1, cores)
  return {
    key: w.key,
    name: w.name,
    summary: summarize(w),
    bytes: t.memory,
    cpu: share >= BUSY ? `${Math.round(share)}% CPU` : null,
    orca: w.orca,
    gone: w.gone,
    groups: groupsOf(w),
    stoppable: {
      agents: { ...w.agents },
      mcp: w.kinds.mcp?.count ?? 0,
      devServers: w.kinds['dev-server']?.count ?? 0,
      other: (['test', 'build', 'package-manager', 'browser', 'other'] as const).reduce((n, k) => n + (w.kinds[k]?.count ?? 0), 0),
      containers: w.docker.containers.length
    }
  }
}

export function buildView(s: Snapshot): View {
  const rows = s.worktrees.filter(isRunning).map((w) => toRow(w, s.machine.cores))
  // Two rows with the same name (two checkouts of one repo): add each one's folder.
  const seen = new Map<string, number>()
  for (const r of rows) seen.set(r.name, (seen.get(r.name) ?? 0) + 1)
  for (const r of rows) {
    const folder = r.key.split('/').filter(Boolean).at(-1) ?? r.key
    if ((seen.get(r.name) ?? 0) > 1 && folder !== r.name) r.summary = [r.summary, folder].filter(Boolean).join(' · ')
  }
  const byBytes = (a: Row, b: Row) => b.bytes - a.bytes
  const sum = (list: Row[]) => list.reduce((n, r) => n + r.bytes, 0)
  const gone = rows.filter((r) => r.gone).sort(byBytes)
  const live = rows.filter((r) => !r.gone)
  const inWorktrees = sum(live)
  const docker = s.dockerVm.memory + sum(gone)
  const used = s.machine.memoryUsed
  const rest = used !== null ? Math.max(0, used - inWorktrees - docker - s.orcaApp.memory) : s.other.memory
  return {
    used,
    totalMemory: s.machine.memoryTotal,
    pressure: s.machine.pressure,
    segments: [
      { id: 'worktrees', label: 'Worktrees', bytes: inWorktrees },
      { id: 'docker', label: 'Docker', bytes: docker },
      { id: 'orca', label: 'Orca', bytes: s.orcaApp.memory },
      { id: 'other', label: 'Other apps', bytes: rest }
    ],
    orca: live.filter((r) => r.orca).sort(byBytes),
    idle: s.worktrees.filter((w) => w.orca && !isRunning(w)).map((w) => w.name).sort(),
    other: live.filter((r) => !r.orca).sort(byBytes),
    gone,
    max: Math.max(1, ...rows.map((r) => r.bytes))
  }
}

/** "3 Claude sessions, 9 MCP servers and 2 containers": what a stop of these rows ends. */
export function stopText(rows: readonly Row[]): string {
  const agents: Record<string, number> = {}
  const n = { mcp: 0, devServers: 0, other: 0, containers: 0 }
  for (const r of rows) {
    for (const [tool, count] of Object.entries(r.stoppable.agents)) agents[tool] = (agents[tool] ?? 0) + count
    n.mcp += r.stoppable.mcp
    n.devServers += r.stoppable.devServers
    n.other += r.stoppable.other
    n.containers += r.stoppable.containers
  }
  const parts = [
    ...Object.entries(agents).map(([tool, count]) => plural(count, `${tool} session`)),
    n.mcp ? plural(n.mcp, 'MCP server') : '',
    n.devServers ? plural(n.devServers, 'dev server') : '',
    n.other ? plural(n.other, 'other process', 'other processes') : '',
    n.containers ? plural(n.containers, 'container') : ''
  ].filter(Boolean)
  if (parts.length === 0) return 'nothing'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** The status bar item: memory of the running worktrees, coloured by macOS memory pressure. */
export function statusBar(v: View, error?: string): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  if (error && v.used === null) return { text: 'Worktrees: ?', tone: 'warning', tooltip: error }
  const live = [...v.orca, ...v.other]
  const heaviest = [...live].sort((a, b) => b.bytes - a.bytes)[0]
  // Orca shows the tooltip on one line: keep it short.
  const tooltip = [
    heaviest ? `Heaviest: ${heaviest.name} ${bytes(heaviest.bytes)}` : null,
    v.used !== null ? `Mac: ${bytes(v.used)} of ${bytes(v.totalMemory)} used` : null,
    'Click for details'
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    text: `${bytes(live.reduce((n, r) => n + r.bytes, 0))} in ${plural(live.length, 'worktree')}`,
    tone: v.pressure === 'critical' ? 'danger' : v.pressure === 'warning' ? 'warning' : 'neutral',
    tooltip
  }
}

// ---------------------------------------------------------------------------------------------
// HTML, styled after Orca's own sidebar panels: grey, 11-12px, actions shown on hover, red only
// when a Stop button is hovered.

const pct = (part: number, whole: number) => `${Math.max(0, Math.min(100, (100 * part) / Math.max(1, whole))).toFixed(1)}%`

const ICONS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  open: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'
}
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

export type UiState = {
  open: ReadonlySet<string>
  showGone: boolean
  showIdle: boolean
  /** The id of the Stop button whose stop is running. */
  busy: string | null
  notice: string | null
}

/** A "Stop" button: it stops on click and shows a spinner until the worker is done. */
function stopButton(attr: string, id: string, ui: UiState, label: string, title: string): string {
  const busy = ui.busy === id
  const inner = busy ? '<span class="spin" aria-label="Stopping"></span>' : esc(label)
  return `<button class="btn stop${busy ? ' busy' : ''}" ${attr} title="${esc(busy ? 'Stopping…' : title)}" ${ui.busy ? 'disabled' : ''}>${inner}</button>`
}

function detail(r: Row): string {
  const groups = r.groups
    .map(
      (g) => `<div class="g">
        <span class="g-name">${esc(g.label)}</span><span class="g-count num">${g.count > 1 ? `×${g.count}` : ''}</span><span class="g-val num">${bytes(g.bytes)}</span>
        <span class="g-bar"><i style="width:${pct(g.bytes, r.bytes)}"></i></span>
      </div>`
    )
    .join('')
  const open = r.orca ? `<div class="detail-actions"><button class="btn" data-open="${esc(r.key)}">${icon('open')}Open in Orca</button></div>` : ''
  return `<div class="detail"><div class="groups">${groups}</div>${open}</div>`
}

function row(r: Row, max: number, ui: UiState): string {
  const open = ui.open.has(r.key)
  const id = `row:${r.key}`
  return `<div class="row${open ? ' open' : ''}">
    <div class="head">
      <button class="toggle" data-toggle="${esc(r.key)}" aria-expanded="${open}" title="${esc(r.key)}">
        <span class="chev">${icon('chevron')}</span>
        <span class="name">${esc(r.name)}</span>
        <span class="val num">${bytes(r.bytes)}</span>
        <span class="summary">${esc(r.summary)}${r.cpu ? ` · <span class="num">${r.cpu}</span>` : ''}</span>
        <span class="bar"><i style="width:${pct(r.bytes, max)}"></i></span>
      </button>
      <span class="actions${ui.busy === id ? ' busy' : ''}">${stopButton(`data-stop="${esc(r.key)}"`, id, ui, 'Stop', `Stop what ${r.name} runs`)}</span>
    </div>
    ${open ? detail(r) : ''}
  </div>`
}

function section(id: string, title: string, rows: Row[], max: number, ui: UiState, extra = ''): string {
  if (rows.length === 0 && !extra) return ''
  const total = rows.reduce((n, r) => n + r.bytes, 0)
  const stopAll = rows.length > 1 ? stopButton(`data-stop-section="${id}"`, `section:${id}`, ui, 'Stop all', `Stop all ${title.toLowerCase()}`) : ''
  return `<section>
    <div class="sec-head">
      <span class="sec-title">${esc(title)}</span>
      <span class="sec-val num">${rows.length ? bytes(total) : ''}</span>
      <span class="sec-act">${stopAll}</span>
    </div>
    ${rows.map((r) => row(r, max, ui)).join('')}
    ${extra}
  </section>`
}

function goneBanner(v: View, ui: UiState): string {
  if (v.gone.length === 0) return ''
  const total = v.gone.reduce((n, r) => n + r.bytes, 0)
  const list = ui.showGone
    ? `<div class="gone-list">${v.gone.map((r) => `<div class="gone"><span class="name">${esc(r.name)}</span><span class="num">${bytes(r.bytes)}</span></div>`).join('')}</div>`
    : ''
  return `<div class="banner">
    <div class="banner-head">
      <span class="warn-dot"></span>
      <button class="banner-title" data-show-gone aria-expanded="${ui.showGone}">${plural(v.gone.length, 'Docker stack')} left running · <span class="num">${bytes(total)}</span></button>
      ${stopButton('data-stop-section="gone"', 'section:gone', ui, 'Stop all', 'docker compose down each stack')}
    </div>
    <div class="banner-sub">Their worktrees were deleted.</div>
    ${list}
  </div>`
}

function idleLink(v: View, ui: UiState): string {
  if (v.idle.length === 0) return ''
  const list = ui.showIdle ? `<div class="idle-list">${v.idle.map(esc).join(' · ')}</div>` : ''
  return `<button class="idle" data-show-idle aria-expanded="${ui.showIdle}">${ui.showIdle ? 'Hide' : plural(v.idle.length, 'idle worktree')}</button>${list}`
}

export function render(v: View, ui: UiState): string {
  const used = v.used ?? v.segments.reduce((n, s) => n + s.bytes, 0)
  const shown = v.segments.filter((s) => s.bytes > 0)
  const bar = shown.map((s) => `<i class="seg ${s.id}" style="width:${pct(s.bytes, v.totalMemory)}"></i>`).join('')
  const legend = shown.map((s) => `<span class="key"><i class="sw ${s.id}"></i>${esc(s.label)} <b class="num">${bytes(s.bytes)}</b></span>`).join('')
  const pressure = v.pressure === 'normal' ? '' : `<span class="pressure ${v.pressure}">${v.pressure === 'critical' ? 'Critical' : 'High'} pressure</span>`
  return `<header>
      <div class="top">
        <span class="label">Memory</span>${pressure}
        <span class="used"><b class="num">${bytes(used)}</b> / ${bytes(v.totalMemory)}</span>
      </div>
      <div class="stack">${bar}</div>
      <div class="legend">${legend}</div>
    </header>
    ${ui.notice ? `<div class="notice">${esc(ui.notice)}</div>` : ''}
    ${goneBanner(v, ui)}
    ${section('orca', 'Orca worktrees', v.orca, v.max, ui, idleLink(v, ui))}
    ${section('other', 'Other checkouts', v.other, v.max, ui)}
    ${v.orca.length + v.other.length === 0 ? '<p class="empty">No worktree is running anything.</p>' : ''}`
}

export function renderError(error: string): string {
  return `<p class="empty">Could not read the processes.<br><span class="num">${esc(error)}</span></p>`
}

export const CSS = `
:root{
  --bg:var(--orca-background,#0a0a0a);--fg:var(--orca-foreground,#f0f0f0);
  --muted:var(--orca-muted-foreground,#acacac);--line:var(--orca-border,rgb(255 255 255/.07));
  --accent:var(--orca-accent,#404040);--danger:var(--orca-destructive,#ff6568);
  --track:color-mix(in srgb,var(--fg) 7%,transparent);
  --fill:color-mix(in srgb,var(--fg) 38%,transparent);
  --hover:color-mix(in srgb,var(--accent) 45%,transparent);
  --warn:#eab308;
}
html.light{--warn:#ca8a04}
*{box-sizing:border-box;min-width:0}
html,body{overflow-x:hidden}
body{margin:0;padding:0 0 20px;font:12px/1.35 var(--orca-font-sans,-apple-system),-apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.01em;-webkit-font-smoothing:antialiased;color:var(--fg);background:var(--bg)}
.num{font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left}
button:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--orca-ring,#737373) 60%,transparent);border-radius:4px}
svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}

header{padding:12px;border-bottom:1px solid var(--line)}
.top{display:flex;align-items:baseline;gap:8px}
.label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.used{margin-left:auto;color:var(--muted)}
.used b{color:var(--fg);font-weight:500}
.pressure{font-size:11px;color:var(--warn)}
.pressure.critical{color:var(--danger)}
.stack{display:flex;gap:1px;height:6px;margin-top:8px;border-radius:999px;overflow:hidden;background:var(--track)}
.seg{display:block;height:100%}
.seg.worktrees,.sw.worktrees{background:color-mix(in srgb,var(--fg) 72%,transparent)}
.seg.docker,.sw.docker{background:color-mix(in srgb,var(--fg) 46%,transparent)}
.seg.orca,.sw.orca{background:color-mix(in srgb,var(--fg) 28%,transparent)}
.seg.other,.sw.other{background:color-mix(in srgb,var(--fg) 14%,transparent)}
.legend{display:flex;flex-wrap:wrap;gap:3px 12px;margin-top:8px;font-size:11px;color:var(--muted)}
.key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.key b{font-weight:500;color:var(--fg)}
.sw{display:inline-block;width:6px;height:6px;border-radius:2px}

.notice{margin:8px 12px 0;padding:6px 8px;border-radius:6px;font-size:11px;color:var(--muted);background:var(--hover)}

.banner{margin:10px 8px 0;padding:6px 8px 8px;border-radius:6px;background:color-mix(in srgb,var(--warn) 8%,transparent)}
.banner-head{display:flex;align-items:center;gap:6px}
.warn-dot{width:6px;height:6px;border-radius:50%;background:var(--warn);flex:none}
.banner-title{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.banner-sub{margin:1px 0 0 12px;font-size:11px;color:var(--muted)}
.gone-list{margin:6px 0 0 12px;display:grid;gap:2px;font-size:11px}
.gone{display:flex;justify-content:space-between;gap:8px;color:var(--muted)}
.gone .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

section{padding:0 4px}
.sec-head{display:grid;grid-template-columns:minmax(0,1fr) auto 52px;align-items:center;column-gap:6px;height:28px;margin-top:10px;padding:0 6px 0 8px}
.sec-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.sec-val{font-size:11px;color:var(--muted);text-align:right;padding-right:2px}
.sec-act{display:flex;justify-content:flex-end}

.btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:500;white-space:nowrap;color:var(--fg);transition:background-color .15s,color .15s}
.btn:hover{background:var(--accent)}
.btn:disabled{opacity:.5;pointer-events:none}
.btn.stop{color:var(--muted)}
.btn.stop:hover{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger)}
.btn.stop:disabled{opacity:1}
.btn.stop.busy{min-width:34px;justify-content:center}
.spin{width:11px;height:11px;border:1.5px solid color-mix(in srgb,var(--muted) 35%,transparent);border-top-color:var(--muted);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.row{border-radius:6px}
.row+.row{margin-top:1px}
.row.open{background:color-mix(in srgb,var(--accent) 22%,transparent)}
.head{position:relative;border-radius:6px;transition:background-color .15s}
.head:hover{background:var(--hover)}
.toggle{display:grid;width:100%;grid-template-columns:12px minmax(0,1fr) auto 52px;column-gap:6px;padding:6px 8px 7px 6px}
.chev{grid-row:1;display:flex;align-items:center;color:var(--muted);transition:transform .15s}
.chev svg{width:11px;height:11px}
.open .chev{transform:rotate(90deg)}
.name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.val{grid-column:3;text-align:right}
.summary{grid-column:2/4;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{grid-column:2/4;height:2px;margin-top:5px;border-radius:999px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;min-width:2px;border-radius:999px;background:var(--fill);transition:width .4s}
.actions{position:absolute;right:6px;top:4px;opacity:0;transition:opacity .15s}
.head:hover .actions,.head:focus-within .actions,.open .actions,.actions.busy{opacity:1}

.detail{padding:0 36px 8px 24px}
.groups{display:grid;gap:5px}
.g{display:grid;grid-template-columns:minmax(0,1fr) auto 56px;column-gap:8px;align-items:baseline;font-size:11px}
.g-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g-count{color:var(--muted);text-align:right}
.g-val{text-align:right}
.g-bar{grid-column:1/-1;height:2px;margin-top:2px;border-radius:999px;background:var(--track);overflow:hidden}
.g-bar i{display:block;height:100%;background:color-mix(in srgb,var(--fg) 28%,transparent)}
.detail-actions{margin:8px 0 0 -7px}
.detail-actions svg{width:11px;height:11px;color:var(--muted)}

.idle{display:block;margin:6px 8px 0 26px;font-size:11px;color:var(--muted)}
.idle:hover{color:var(--fg)}
.idle-list{margin:3px 8px 0 26px;font-size:11px;color:var(--muted)}
.empty{color:var(--muted);text-align:center;margin:24px 12px}
`
