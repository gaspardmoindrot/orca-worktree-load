# Worktree Load

What each worktree costs your Mac, live, in Orca: memory and CPU of every process it started (agents, MCP servers, dev servers, tests, builds) plus its share of Docker, with the last hour.

- **Status bar**: `7.6 GB · 9.2% in 20 worktrees`. Orange or red with macOS memory pressure; the tooltip names the 3 heaviest worktrees. Click to sample now.
- **Right-sidebar panel**: the Mac, then one row per worktree (memory, CPU, last hour, Docker, processes). Select a row for its load by kind, its heaviest processes and its containers. Double-click opens an Orca worktree.
- **Docker stacks of deleted worktrees** get their own warning: containers that kept running after their worktree was removed.
- **One notification per memory pressure episode**, naming the heaviest worktree.

## How a process gets its worktree

Every `intervalSeconds` (5 s) the worker reads every process with `ps`, and its working directory with `lsof` (only for new PIDs, and a full pass every minute). In order:

1. its working directory is inside an Orca worktree, or inside any other git checkout (worktrees made by Claude Code or by hand; turn this off in settings);
2. it is Docker Desktop or its VM;
3. otherwise it belongs to its parent: an MCP server or a dev server started by an agent counts for that agent's worktree;
4. what is left under Orca's app process is "Orca app", the rest "Everything else".

Memory is the footprint Activity Monitor shows (`top`, every 15 s). CPU is the difference between two `ps` readings, in % of one core.

Docker's VM is one process for macOS. Every 30 s the worker reads `docker ps` and `docker stats`, finds each container's worktree from its compose folder (`com.docker.compose.project.working_dir`), and gives that worktree a share of the VM's footprint and CPU in proportion to its containers' memory and CPU. That share leaves the Docker row, so nothing is counted twice.

Nothing is written to disk. History is the last hour in memory, in 30-second buckets, and starts again with Orca.

## Limits

- macOS only (`ps`, `lsof`, `top`, `sysctl`).
- It samples while Orca runs. A process that lives less than one interval can be missed.
- Processes of other users (root) cannot be read with `lsof`; they inherit their parent's owner or land in "Everything else".

## Settings

Sample interval, Docker interval (0 turns Docker off), count git checkouts Orca does not manage, notify on memory pressure.

## Develop

```sh
orca plugin validate .
orca plugin test .      # src/model.test.ts, src/worker.test.ts (system commands are mocked)
orca plugin check .     # renders the panel with the real worker, on this Mac
orca plugin dev watch . # load it, stream logs, reload on save
```
