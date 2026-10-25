---
title: Agent tasks
description: Give an agent a task on its own branch and worktree, and review its changes before anything lands.
---

# Agent tasks

Give an agent a task on its own branch and worktree, and review its changes before anything lands.

## What you get

- A task for an agent in two fields: a repo and a prompt.
- A fresh branch and a separate working copy for every task, so several agents can work in one repo at once and your own working copy stays untouched.
- The task's changes live: files, diff and commits against the default branch.
- A warning when two tasks in one repo change the same files.
- Tasks that survive a restart of Trackwall, ready to resume.

## How it works

Press "+" in "Sessions", pick a repo and write the prompt. Trackwall creates a branch named after the prompt (`trackwall/<prompt slug>`) from the repo's default branch, in a separate git worktree, and starts Copilot CLI there with your prompt as the first message. The task shows on the list like a session, with the same states.

The "Changes" tab follows the worktree live: the files and diff against the default branch, the task's commits and what the agent has not committed yet. "VS Code" opens the worktree in your editor. When the agent finishes, it leaves a summary above the task's tabs.

When another task in the same repo changes some of the same files, a warning above the tabs names that task and lists the shared files, with "Open that task". Trackwall only warns; both tasks carry on.

"Resume" starts Copilot CLI again with the task's conversation. "End task" removes the worktree and keeps the branch, or removes both; if that would lose changes, Trackwall asks first.

## Use it

1. Open "Sessions" and press "+".
2. Pick a repo, write the prompt and start the task.
3. Watch the agent in the terminal and its work in "Changes".
4. Review the changes in VS Code, then push the branch yourself or end the task.

## Good to know

- Worktrees live in `~/.trackwall/worktrees/<repo>/`.
- Copilot CLI asks to trust every new folder. To stop it asking for every task, add the `worktrees` folder (the new task form shows its full path) to `trustedFolders` in `~/.copilot/config.json`.
- A task's agent stays in its worktree and does not push; the branch is yours to push.
- An agent can also propose a task for you to start: see [Main session and task proposals](/features/main-session).
