---
title: Container work backup
description: Keep the commits, stashes and changes that exist only in your dev container in one small file on your computer.
---

# Container work backup

Keep the commits, stashes and changes that exist only in your dev container in one small file on your computer.

## What you get

- One click puts every commit you have not pushed, every stash and every uncommitted change, a task's included, into one file.
- Your tasks and their history, the board, knowledge, routines and task templates go in too.
- The backup takes seconds and your sessions keep running: work a remote already has is not copied again.
- The file is yours to keep on your computer, where the agents in the container cannot reach it.

## How it works

When Trackwall runs in a [dev container](/guide/dev-container), your repos live in a Docker volume. Removing the volume, resetting Docker or a broken virtual disk deletes it, and with it everything you have not pushed: a task's branch, an agent's uncommitted changes, a stash from last week. "Only in this container" on [Home](/features/home) lists what is at stake; the backup keeps it.

"Back up now" in Settings › Workspace › Container work backup reads the same repos. For each one it writes a git bundle of its branches and stashes, and of the changed and new files of each of its worktrees, without touching the repo: your staged files stay staged and nothing new appears in it. It leaves out what a remote already has, so the file stays small, and puts Trackwall's own files beside the bundles. The section then says when the backup was made, how large it is and what it holds, and names any repo git could not read.

"Download backup" saves the file, `trackwall-backup-<date>-<time>.tar.gz`, through your browser or the desktop app. Trackwall keeps only the last backup in the container; the copies you download are the ones to keep.

## Use it

1. Open "Settings", choose "Workspace" and open "Container work backup".
2. Click "Back up now".
3. Click "Download backup" and keep the file on your computer.

## Good to know

- Only where Trackwall runs in a dev container. On your own computer the repos are on its own disk, and the section says so.
- Files git ignores, such as a local `.env`, stay out, and so do your sign-ins, builds and Copilot CLI's conversations. To keep those too, copy the whole volume as [Run in a dev container](/guide/dev-container#copy-the-whole-volume) describes.
- The file holds the code of those repos and is not encrypted, so keep it where you would keep the repos themselves.
- Each bundle is a plain git bundle. `tar xzf` unpacks the file, `manifest.json` says which bundle belongs to which repo and where each worktree's changes are, and `git fetch <bundle> "refs/*:refs/restored/*"` in a new clone of the repo brings the branches, stashes and changes back. Restoring from Trackwall is not there yet.
- Agents cannot make or download a backup: there is no tool for it.
