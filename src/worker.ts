// The plugin's worker. Orca keeps it running because the manifest declares a status bar item.
// Every `intervalSeconds` it samples (src/sampler.ts), updates the status bar, posts the snapshot
// to the panel, and notifies once per episode of high memory pressure.
// Orca transpiles this file when it loads: no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { totalOf, type OrcaWorktree, type Snapshot } from './model'
import { Sampler, type Settings } from './sampler'
import { BIN, system } from './system'
import { buildView, bytes, statusBar } from './view'

const DEFAULTS = { intervalSeconds: 5, dockerSeconds: 30, includeOtherCheckouts: true, notify: true }

let sampler: Sampler | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<Snapshot> | null = null
let pressure: { since: number | null; normalSince: number | null } = { since: null, normalSince: null }

/** Tests only: no wait between the first two readings, nor before SIGKILL. */
export const testing = { fast: false }

async function readSettings(orca: OrcaWorkerApi): Promise<Settings & { notify: boolean }> {
  const read = async <K extends keyof typeof DEFAULTS>(key: K): Promise<(typeof DEFAULTS)[K]> => {
    const value = await orca.settings.get(key).catch(() => null)
    return typeof value === typeof DEFAULTS[key] ? (value as (typeof DEFAULTS)[K]) : DEFAULTS[key]
  }
  const [intervalSeconds, dockerSeconds, includeOtherCheckouts, notify] = await Promise.all([
    read('intervalSeconds'),
    read('dockerSeconds'),
    read('includeOtherCheckouts'),
    read('notify')
  ])
  return { intervalSeconds: Math.min(300, Math.max(2, intervalSeconds)), dockerSeconds, includeOtherCheckouts, notify }
}

async function listWorktrees(orca: OrcaWorkerApi): Promise<OrcaWorktree[]> {
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces
      .filter((w) => w.kind === 'worktree' && w.path)
      .map((w) => ({ id: w.id, name: w.name, project: w.project ?? null, path: w.path, branch: w.branch }))
  } catch (error) {
    orca.log(`workspace.list failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** One notification per episode of high memory pressure; an episode ends after a minute of normal. */
async function notifyPressure(orca: OrcaWorkerApi, s: Snapshot, enabled: boolean): Promise<void> {
  const now = Date.now()
  if (s.machine.pressure === 'normal') {
    pressure.normalSince ??= now
    if (now - pressure.normalSince > 60_000) pressure.since = null
    return
  }
  pressure.normalSince = null
  if (pressure.since !== null) return
  pressure.since = now
  if (!enabled) return
  const heaviest = [...s.worktrees].sort((a, b) => totalOf(b).memory - totalOf(a).memory)[0]
  await orca.host
    .call('notifications.show', {
      title: `Memory pressure ${s.machine.pressure === 'critical' ? 'critical' : 'high'}`,
      body: heaviest ? `Heaviest worktree: ${heaviest.name} (${bytes(totalOf(heaviest).memory)})` : 'No worktree is running anything.'
    })
    .catch(() => undefined)
}

/** Samples once (or joins the sample in flight), then publishes it unless the worker stopped. */
async function tick(orca: OrcaWorkerApi, own: Sampler): Promise<Snapshot> {
  const settings = await readSettings(orca)
  inFlight ??= own
    .sample(settings)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      orca.log(`sample failed: ${message}`)
      if (!own.last) throw error
      return { ...own.last, error: message }
    })
    .finally(() => {
      inFlight = null
    })
  const s = await inFlight
  if (own.disposed) return s
  await orca.host.call('statusBar.update', { id: 'worktree-load', ...statusBar(buildView(s), s.error) }).catch(() => undefined)
  orca.panels.post('load.snapshot', s)
  await notifyPressure(orca, s, settings.notify)
  return s
}

async function loop(orca: OrcaWorkerApi, own: Sampler): Promise<void> {
  await tick(orca, own).catch(() => undefined)
  const { intervalSeconds } = await readSettings(orca)
  if (own.disposed) return
  timer = setTimeout(() => void loop(orca, own), intervalSeconds * 1000)
  // The IPC channel keeps the worker alive; the timer alone must not (tests exit cleanly).
  ;(timer as { unref?: () => void }).unref?.()
}

export default function activate(orca: OrcaWorkerApi): void {
  const own = new Sampler(() => listWorktrees(orca))
  if (testing.fast) own.firstGapMs = own.killAfterMs = 0
  sampler = own

  orca.panels.handle('load.get', async () => own.last ?? (await tick(orca, own)))
  orca.panels.handle('load.stop', async ({ keys }) => {
    const result = await own.stop(keys)
    orca.log(`stopped ${keys.join(', ')}: ${result.processes} processes, ${result.containers} containers${result.failed.length ? `; failed: ${result.failed.join('; ')}` : ''}`)
    await tick(orca, own).catch(() => undefined)
    return result
  })
  orca.panels.handle('load.open', async ({ path }) => {
    const target = own.orcaWorktree(path)
    if (!target) return { opened: false }
    await orca.host.call('workspace.open', { workspaceId: target.id })
    return { opened: true }
  })
  orca.commands.register('worktreeLoad.show', async () => {
    // The host API cannot open a panel; Orca's CLI can. The key is `local.worktree-load` for a
    // development folder and `<owner>.worktree-load` once installed, so look it up.
    try {
      const { result } = JSON.parse(await system.run(BIN.orca, ['plugin', 'list', '--json'])) as { result: { plugins: { pluginKey: string }[] } }
      const key = result.plugins.find((p) => p.pluginKey.endsWith('.worktree-load'))?.pluginKey
      if (key) await system.run(BIN.orca, ['plugin', 'open', key, '--panel', 'worktree-load', '--json'])
    } catch (error) {
      orca.log(`opening the panel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  })
  void loop(orca, own)
}

export function deactivate(): void {
  if (sampler) sampler.disposed = true
  sampler = null
  clearTimeout(timer)
  inFlight = null
  pressure = { since: null, normalSince: null }
}
