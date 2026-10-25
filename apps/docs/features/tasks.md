# Agent tasks

Give an agent a task on its own branch and worktree, and review its changes.

The "+" button in the "Sessions" view opens the new task form: a repo and a prompt for the agent. Trackwall creates a new branch `trackwall/<prompt slug>` from the repo's default branch in a separate worktree in `~/.trackwall/worktrees/<repo>/` and runs Copilot CLI in it with the prompt as the first message (ADR-31), so several tasks in one repo run at once without collisions, and your working directory stays untouched. The "Changes" tab shows live the files and diff of the worktree against the default branch, with the task's commits and what the agent has not committed yet.

Buttons: "VS Code" opens the worktree, "Resume" runs Copilot CLI with the task's conversation (`--resume`), and "End task" removes the worktree and keeps the branch or removes both; changes that would be lost doing so are deleted by Trackwall only after confirmation. Tasks survive a daemon restart. Copilot CLI asks for trust in every new folder; so that it does not ask for every task, add the `worktrees` directory (the form gives the full path) to `trustedFolders` in `~/.copilot/config.json`.

## Tasks that touch the same files

When another task of the same repo changes the same files, a warning above the task's tabs names the other task and lists the shared files (refreshed every 5 s), with an "Open that task" button; Trackwall only warns and stops nothing (ADR-44).

## Decisions

Why it works this way: [ADR-31](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-44](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
