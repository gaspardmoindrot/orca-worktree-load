// What Stop stops, decided without I/O so it can be tested.
//
// For a worktree: every process it owns except its shells (the terminal tabs stay open, back at
// their prompt), anything inside an app bundle (Orca, editors, the terminal app), shared daemons
// that serve other worktrees too (tmux, screen, agents, build daemons) and this worker. Its
// containers get `docker stop`.
// For a Docker stack whose folder is gone: `docker compose down`, but only when every container of
// that compose project is in a missing folder; otherwise just `docker stop` its own containers.
import { classify, containerOwner, KEPT_ON_STOP, type Container, type OwnerKey, type Proc, type Resolver } from './model'

export type StopPlan = {
  key: OwnerKey
  /** Processes to signal, with the command they had, checked again right before the signal. */
  processes: { pid: number; command: string }[]
  /** Containers to `docker stop`. */
  containers: string[]
  /** Compose projects to `docker compose down`. */
  projects: string[]
}

export function stoppable(p: Proc, protectedPids: ReadonlySet<number>): boolean {
  return !protectedPids.has(p.pid) && !KEPT_ON_STOP.includes(classify(p.command))
}

export function planStop(input: {
  keys: readonly OwnerKey[]
  procs: readonly Proc[]
  owners: ReadonlyMap<number, OwnerKey>
  containers: readonly Container[]
  resolver: Resolver
  /** This worker and its parents. */
  protectedPids: ReadonlySet<number>
}): StopPlan[] {
  const ownerOf = new Map(input.containers.map((c) => [c.id, containerOwner(c, input.resolver)]))
  // A project can be taken down whole only if none of its containers lives in an existing folder.
  const projectGone = (project: string) => input.containers.filter((c) => c.project === project).every((c) => ownerOf.get(c.id)?.gone)

  return input.keys.map((key) => {
    const processes = input.procs
      .filter((p) => input.owners.get(p.pid) === key && stoppable(p, input.protectedPids))
      .map((p) => ({ pid: p.pid, command: p.command }))
    const mine = input.containers.filter((c) => ownerOf.get(c.id)?.key === key)
    const downs = new Set(mine.filter((c) => ownerOf.get(c.id)?.gone && c.project && projectGone(c.project)).map((c) => c.project))
    return {
      key,
      processes,
      containers: mine.filter((c) => !downs.has(c.project)).map((c) => c.id),
      projects: [...downs]
    }
  })
}

/** The planned PIDs that may still be signalled: same PID, same command as when planned. */
export function stillSame(planned: readonly { pid: number; command: string }[], now: readonly Proc[]): number[] {
  const live = new Map(now.map((p) => [p.pid, p.command]))
  return planned.filter((p) => live.get(p.pid) === p.command).map((p) => p.pid)
}
