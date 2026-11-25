# Worktree Load

How heavy each Orca worktree is, live: CPU, RAM, agents, terminals, uncommitted diff and disk size.

- **Status bar**: `CPU total · RAM total · live/total worktrees · N working`. It turns orange when a worktree goes over a threshold and red at twice the RAM threshold. The tooltip shows the 3 heaviest worktrees. Click it to refresh.
- **Right-sidebar panel** "Worktree Load": one row per worktree with CPU, a CPU sparkline over the last 30 polls, RAM, agents (working / waiting / idle), terminals, `git diff --shortstat HEAD`, disk size (`du`) and last activity. Sort by any column. Double-click a row to open the worktree.
- **Notification** when a worktree stays over a threshold for 3 polls in a row, so a short `npm install` doesn't trigger it.

## Where the numbers come from

The plugin host API has no PID, CPU or memory. Orca measures them itself (the process tree of every terminal, plus agent chats), so the worker reads:

| Every | Command | Gives |
|---|---|---|
| `intervalSeconds` (10 s) | `orca diagnostics memory --json` | CPU (% of one core) and RAM (macOS footprint) per worktree, host RAM and load |
| `intervalSeconds` | `orca worktree ps --json` | every worktree, its agents and their state, live terminals, last activity |
| 1 min | `git diff --shortstat HEAD` in each live worktree | files, +/- lines |
| `diskMinutes` (10 min) | `du -sk` per worktree, one at a time | disk size, `node_modules` included |

Limits: a process started outside an Orca terminal (an external terminal or a launchd service) is not counted. The CLI JSON is not part of Orca's stable plugin API, so a future Orca release can change it.

## Settings

Poll interval, CPU threshold (% of one core, default 150), RAM threshold (MB, default 4096), notifications on/off, disk scan interval (0 = off).

## Develop

```sh
orca plugin validate .
orca plugin test .      # src/load.test.ts, src/worker.test.ts (the CLI is mocked)
orca plugin check .     # renders the panel with the real worker
orca plugin dev watch . # load it, stream logs, reload on save
```
