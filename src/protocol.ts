// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Snapshot } from './load'

declare module 'orca' {
  interface PluginRequests {
    /** The last snapshot, or a fresh one if the worker has none yet. */
    'load.get': { output: Snapshot }
    /** Polls now. */
    'load.refresh': { output: Snapshot }
    /** Shows the worktree at `path` in Orca. */
    'load.open': { input: { path: string }; output: { opened: boolean } }
    /** Starts a `du` pass over every worktree now. */
    'load.scanDisk': { output: { started: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted after every poll. */
    'load.snapshot': Snapshot
  }
}
