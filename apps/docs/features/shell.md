---
title: Shell
description: Open your own shell in a repo or a task's worktree from its "Shell" tab, already in the right folder, also when Trackwall runs in a container.
---

# Shell

Open your own shell in a repo or a task's worktree from its "Shell" tab, already in the right folder, also when Trackwall runs in a container.

## What you get

- A shell in the repo's folder, or in a task's worktree, one click away, without looking up the path.
- The same shell in the desktop app and in the browser page, where Trackwall runs: in a [dev container](/guide/dev-container), a shell in the container.
- Your shell keeps running while you look at other views, and shows what it printed when you come back.
- One shell per repo and per task, so you never wonder which window was the right one.

## How it works

Every repo in "Repos" and every task in "Sessions" has a "Shell" tab. Opening it starts your shell in that folder: the repo's own folder, or the task's worktree, where the agent works. It is the shell you use in your terminal app, with your settings, so `git`, `mise` and your tools work as usual.

The shell keeps running when you switch tabs or views, and Trackwall keeps its screen, so you come back to where you left it, also in a second window. Opening the tab again shows the same shell. Type `exit`, and the tab says the shell has ended and shows what was left on its screen; "Start again" opens a new one in the same place. "Close" ends the shell and everything it runs.

A task's "Terminal" tab is still the agent's session; "Shell" is yours. Ending a task closes its shell first, since nothing may run in a worktree that goes away.

## Use it

1. Open a repo in "Repos", or a task in "Sessions".
2. Choose the "Shell" tab.
3. Type. Choose "Close" when you are done.

## Good to know

- The shell is the one your system names: on Windows the command prompt (`cmd.exe`, or whatever `ComSpec` names), on macOS your login shell, on Linux `$SHELL`. To use PowerShell on Windows, type `powershell` in it.
- It runs as you, with your environment, but without the mise environment of the repo; run `mise` commands as you would in any terminal.
- Shells end when Trackwall stops or restarts. Up to 16 can be open at once; close one to open another.
- A shell runs whatever your shell's own setup runs when it starts, also a per-folder config an agent may have written into a task's worktree (such as a `.envrc` with direnv).
- Removing a repo is refused while its shell runs; close the shell first.
- Agents cannot see or type into your shell.
