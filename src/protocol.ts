// The panel <-> worker contract. The worker's handlers are typed by it; src/panel.ts uses the
// same names.
import type { Snapshot } from './model'

declare module 'orca' {
  interface PluginRequests {
    /** The last snapshot, or a fresh one if the worker has none yet. */
    'load.get': { output: Snapshot }
    /** Stops what these worktrees run (processes but their shells, and their containers). */
    'load.stop': { input: { keys: string[] }; output: { processes: number; containers: number; failed: string[] } }
    /** Shows the Orca worktree at `path`. */
    'load.open': { input: { path: string }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted after every sample. */
    'load.snapshot': Snapshot
  }
}
