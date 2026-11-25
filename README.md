# Worktree Load

What each worktree costs your Mac, in Orca's sidebar, and a Stop button for each one.

**macOS only.** It reads processes with `ps`, `lsof` and `top`.

- **The Mac's memory** at the top: how much the worktrees, Docker, Orca and other apps use.
- **One row per worktree** with its memory and what runs there: "3 Claude · 9 MCP servers", "2 containers". The CPU only shows when a worktree is busy.
- **Open a row** to see where the memory goes: MCP servers by name (Playwright ×9), Claude sessions, dev servers, shells, Docker.
- **Stop** a worktree, a whole section, or the Docker stacks left behind by deleted worktrees, in one click.
- **Status bar**: `7.8 GB in 19 worktrees`. A click opens the panel.

## How a process gets its worktree

Every 5 seconds the worker reads every process with `ps`, and its working directory with `lsof`. A process belongs to:

1. the worktree that holds its working directory: an Orca worktree, or any other git checkout (turn this off in settings);
2. Docker Desktop, if it is Docker's VM or helpers;
3. otherwise its parent's worktree: an MCP server started by an agent counts for that agent's worktree.

Memory is the footprint Activity Monitor shows. Docker's VM is one process for macOS, so each worktree gets a share of it in proportion to its compose containers' memory, read every 30 s with `docker stats`.

## What Stop does

Only when you click it:

- **A worktree**: SIGTERM to every process it runs except its shells, so its terminal tabs stay open, then SIGKILL 3 s later for what is left. `docker stop` on its containers. Each PID is checked again right before the signal, and Orca's own processes are never touched.
- **Docker stacks of deleted worktrees**: `docker compose -p <project> down`.

## Privacy

Nothing leaves your Mac: no network, no telemetry. Nothing is written to disk; the last hour of history stays in memory.

## Settings

Sample interval, Docker interval (0 turns Docker off), count git checkouts Orca does not manage, notify on memory pressure.

## Develop

```sh
orca plugin validate .
orca plugin test .
orca plugin dev watch .
```

## License

MIT
