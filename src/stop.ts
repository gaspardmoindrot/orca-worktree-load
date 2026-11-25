// What "Stop" stops, decided without I/O so it can be tested: every process the worktree owns
// except its shells (the terminal tabs stay open, back at their prompt) and anything of Orca's
// own, plus its Docker containers. A Docker stack whose worktree is gone is taken down whole.
import { classify, type Container, type OwnerKey, type Proc, type Resolver } from './model'

export type StopPlan = {
  key: OwnerKey
  /** Processes to signal, with the command they had, checked again right before the signal. */
  processes: { pid: number; command: string }[]
  /** Containers to `docker stop`. */
  containers: string[]
  /** Compose projects to `docker compose -p <name> down` (their worktree no longer exists). */
  projects: string[]
}

/** The owner key a container is counted under, as rollUp counts it. */
export function containerOwner(c: Pick<Container, 'workingDir' | 'project'>, resolver: Resolver): OwnerKey | null {
  if (!c.workingDir) return null
  return resolver.rootFor(c.workingDir) ?? `docker:${c.project || c.workingDir}`
}

const isOrcaOwn = (command: string) => /\/Orca\.app\//.test(command)

export function planStop(input: {
  keys: readonly OwnerKey[]
  procs: readonly Proc[]
  owners: ReadonlyMap<number, OwnerKey>
  containers: readonly Container[]
  resolver: Resolver
  /** This worker and its parents: never signalled. */
  protectedPids: ReadonlySet<number>
}): StopPlan[] {
  return input.keys.map((key) => {
    const processes = input.procs
      .filter((p) => input.owners.get(p.pid) === key)
      .filter((p) => !input.protectedPids.has(p.pid) && !isOrcaOwn(p.command) && classify(p.command) !== 'shell')
      .map((p) => ({ pid: p.pid, command: p.command }))
    const mine = input.containers.filter((c) => containerOwner(c, input.resolver) === key)
    const gone = key.startsWith('docker:')
    return {
      key,
      processes,
      containers: gone ? [] : mine.map((c) => c.id),
      projects: gone ? [...new Set(mine.map((c) => c.project).filter(Boolean))] : []
    }
  })
}

/** Which planned processes may still be signalled: same PID and same command as when planned. */
export function stillSame(planned: readonly { pid: number; command: string }[], now: readonly Proc[]): number[] {
  const live = new Map(now.map((p) => [p.pid, p.command]))
  return planned.filter((p) => live.get(p.pid) === p.command).map((p) => p.pid)
}
