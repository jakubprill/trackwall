---
title: Shell
description: Open your own shell in the projects folder, a repo or a task's worktree, already in the right folder, also when Trackwall runs in a container.
---

# Shell

Open your own shell in the projects folder, a repo or a task's worktree, already in the right folder, also when Trackwall runs in a container.

## What you get

- A shell in the repo's folder, in a task's worktree, or in the projects folder with all your repos, one click away, without looking up the path.
- The same shell in the desktop app and in the browser page, where Trackwall runs: in a [dev container](/guide/dev-container), a shell in the container.
- Your shell keeps running while you look at other views, and shows what it printed when you come back.
- One shell per repo, per task and for the projects folder, so you never wonder which window was the right one.
- A "Files on disk" panel beside the shell to download a build's JAR, a log or a test report to your computer, and files you drop on the shell land where it runs, also in a container.

## How it works

Every repo in "Repos" and every task in "Sessions" has a "Shell" tab. Opening it starts your shell in that folder: the repo's own folder, or the task's worktree, where the agent works. It is the shell you use in your terminal app, with your settings, so `git`, `mise` and your tools work as usual.

The shell keeps running when you switch tabs or views, and Trackwall keeps its screen, so you come back to where you left it, also in a second window. Opening the tab again shows the same shell. Type `exit`, and the tab says the shell has ended and shows what was left on its screen; "Start again" opens a new one in the same place. "Close" ends the shell and everything it runs.

"Files on disk" above the shell opens a list of the same folder as it is now, with files you have not committed and build output too. Click a folder to open it, and the path above the list to go back up. Click a file to download it: your browser or the app saves it like any other download. The list only reads: nothing in the folder changes. Links are shown but not followed.

For work that is no single repo's, such as cloning a repo by hand or looking across all of them, choose "Shell" next to the projects folder's path at the top of the list in "Repos". It opens a shell in the projects folder itself, which in a dev container is the volume with your repos, with "Files on disk" beside it too.

A task's "Terminal" tab is still the agent's session; "Shell" is yours. Ending a task closes its shell first, since nothing may run in a worktree that goes away.

## Use it

1. Open a repo in "Repos", or a task in "Sessions", and choose its "Shell" tab; or choose "Shell" next to the projects folder in "Repos".
2. Type. Choose "Close" when you are done.
3. To take a file out, choose "Files on disk", open its folder and click the file.
4. To put a file in, drag it from Explorer or Finder onto the shell (or a session's terminal), then use the path that appears, for example `cp <path> .`.

## Good to know

- The shell is the one your system names: on Windows the command prompt (`cmd.exe`, or whatever `ComSpec` names), on macOS your login shell, on Linux `$SHELL`. To use PowerShell on Windows, type `powershell` in it.
- It runs as you, with your environment, but without the mise environment of the repo; run `mise` commands as you would in any terminal.
- Shells end when Trackwall stops or restarts. Up to 16 can be open at once; close one to open another.
- A shell runs whatever your shell's own setup runs when it starts, also a per-folder config an agent may have written into a task's worktree (such as a `.envrc` with direnv).
- Removing a repo is refused while its shell runs; close the shell first.
- Agents cannot see or type into your shell.
- Ctrl+Shift+F (Cmd+F on macOS) finds text in the shell, also in what scrolled away; Ctrl+F stays your shell's own key. Ctrl+click (Cmd+click on macOS) on a web address the shell printed, such as the merge request link from `git push`, opens it in your browser.
- A file of more than 1 GB cannot be downloaded from "Files on disk", since it is held in memory before it is saved; copy it with `docker cp <container name>:<path> .` on your computer instead. A folder with more than 2000 entries shows the first 2000.
- With Trackwall in a container, or in the browser, a dropped file is copied into `.trackwall/drops` of the projects folder and kept for a week; only files can be dropped, up to 256 MB each. A larger file or a folder goes in with `docker cp <path> <container name>:<path>`. With Trackwall on your computer the terminal gets the file's own path and nothing is copied.
