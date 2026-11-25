import type { PanelPayload } from './model'

// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

declare module 'orca' {
  interface PluginRequests {
    /** The last snapshot, or a fresh one if the worker has none yet. */
    'load.get': { output: PanelPayload }
    /** Samples now. */
    'load.refresh': { output: PanelPayload }
    /** Shows the Orca worktree at `path`. */
    'load.open': { input: { path: string }; output: { opened: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted after every sample. */
    'load.snapshot': PanelPayload
  }
}
