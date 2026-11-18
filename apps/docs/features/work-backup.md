---
title: Container work backup
description: Keep the commits, stashes and changes that exist only in your dev container in one small file on your computer, and bring them back.
status: preview
---

# Container work backup

Keep the commits, stashes and changes that exist only in your dev container in one small file on your computer, and bring them back.

::: warning Preview
The backup and its restore are new, so what the file holds and what a restore brings back can still change.
:::

## What you get

- One click puts every commit you have not pushed, every stash and every uncommitted change, a task's included, into one file.
- Your tasks and their history, the board, knowledge, routines and task templates go in too.
- The backup takes seconds and your sessions keep running: work a remote already has is not copied again.
- The file is yours to keep on your computer, where the agents in the container cannot reach it.
- In a new container, "Restore from a backup…" shows what comes back to each repo before anything changes, then brings it back without touching what you already have.

## How it works

When Trackwall runs in a [dev container](/guide/dev-container), your repos live in a Docker volume. Removing the volume, resetting Docker or a broken virtual disk deletes it, and with it everything you have not pushed: a task's branch, an agent's uncommitted changes, a stash from last week. "Only in this container" on [Home](/features/home) lists what is at stake; the backup keeps it.

"Back up now" in Settings › Workspace › Container work backup reads the same repos. For each one it writes a git bundle of its branches and stashes, and of the changed and new files of each of its worktrees, without touching the repo: your staged files stay staged and nothing new appears in it. It leaves out what a remote already has, so the file stays small, and puts Trackwall's own files beside the bundles. The section then says when the backup was made, how large it is and what it holds, and names any repo git could not read.

"Download backup" saves the file, `trackwall-backup-<date>-<time>.tar.gz`, through your browser or the desktop app. Trackwall keeps only the last backup in the container; the copies you download are the ones to keep.

To bring the work back, clone the repos into the new container first, then pick the file with "Restore from a backup…". Trackwall lists, repo by repo, what it would do: a branch you lack is made, one the backup is ahead of moves forward, stashes join your stash list, and each worktree's uncommitted changes come back as a branch under `restored/changes/`. A branch of yours that went another way stays as it is, and the backup's version gets its own branch under `restored/`. A repo you have not cloned yet says so; clone it, click "Look again" and restore again. Restoring only adds, so running it twice changes nothing the second time. Files of the board, knowledge, routines and task templates you lack are added; ones you have stay yours.

## Use it

1. Open "Settings", choose "Workspace" and open "Container work backup".
2. Click "Back up now".
3. Click "Download backup" and keep the file on your computer.

To restore, in the new container:

1. Clone the repos you need into the projects folder.
2. Open "Settings", choose "Workspace" and open "Container work backup".
3. Click "Restore from a backup…" and pick the file.
4. Read the list, then click "Restore".

## Good to know

- Only where Trackwall runs in a dev container. On your own computer the repos are on its own disk, and the section says so.
- Files git ignores, such as a local `.env`, stay out, and so do your sign-ins, builds and Copilot CLI's conversations. To keep those too, copy the whole volume as [Run in a dev container](/guide/dev-container#copy-the-whole-volume) describes.
- The file holds the code of those repos and is not encrypted, so keep it where you would keep the repos themselves.
- Uncommitted changes come back as a branch, not into your files: check it out, or cherry-pick it without committing, when you want them.
- Your tasks and their history stay in the file: a restore does not bring the task list back.
- Restore only files you made yourself: what a restore brings is code your agents will work on.
- Each bundle is a plain git bundle. `tar xzf` unpacks the file, `manifest.json` says which bundle belongs to which repo, and `git fetch <bundle> "refs/*:refs/restored/*"` in a clone brings everything back by hand.
- Agents cannot make or download a backup: there is no tool for it.
