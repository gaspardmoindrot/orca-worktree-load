# Changelog

## 0.5.0

First public release.

- Right-sidebar panel: the Mac's memory split between worktrees, Docker, Orca and other apps; one row per worktree with what runs there; open a row to see where its memory goes.
- Every process goes to a worktree by its working directory, else its parent's. Docker containers go to the worktree of their compose folder.
- Docker stacks left running by deleted worktrees get their own warning.
- Stop a worktree, a section, or the leftover Docker stacks in one click. Shells, apps and shared tools (tmux, build daemons) are never stopped.
- Status bar item, and one notification per episode of memory pressure.

Asks for `workspace:read`, `workspace:write`, `notifications:show` and `settings:own`. 14 tests.
