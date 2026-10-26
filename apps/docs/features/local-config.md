---
title: Local config backup
description: Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.
---

# Local config backup

Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.

## What you get

- mise tasks that never reach the repo: write them in `mise.local.toml` instead of `mise.toml`.
- A backup a few seconds after you or an agent save the file, with every earlier version kept.
- "Restore from the store" in a fresh clone, so a deleted folder costs you nothing.
- "Ignore locally", so the file never slips into a commit or a merge request.
- The same tasks on a second computer, through a remote you choose.

## How it works

Some teams do not want mise configuration in their repos. Then the tasks you work out for a repo, by hand or with an agent, go into `mise.local.toml` in the repo root. mise reads it on top of `mise.toml`, so the [mise tasks](/features/mise-tasks) tab, the [Batch command](/features/batch-command), [Services](/features/services) and agents run these tasks like any other.

Trackwall watches `mise.local.toml` and `.worktreeinclude` in every repo of your projects folder. A few seconds after one of them changes, it copies the file into the local config store: the folder `.trackwall-local` in your projects folder, a git repo with one folder per repo. Each copy is a commit, so an older version is always there. A file that disappears from a repo stays in the store. A file the repo's own commits already have is the team's, and Trackwall leaves it alone.

The "mise tasks" tab of a repo shows a "Local config" section with each file's state. In a fresh clone the state is "only in the store", and "Restore from the store" puts the files back. A file git does not ignore shows a warning: anyone working in the repo could commit it, an agent too. "Ignore locally" adds it to the clone's `.git/info/exclude`, which git never pushes. Restore does this by itself.

"Settings" shows where the store is, the last backup, and whether it was pushed. Without a remote the backups stay on this computer. With one, Trackwall pushes after every backup, and on another computer you clone the store into its projects folder and press "Restore from the store" in each repo.

## Use it

1. Write your tasks in `mise.local.toml` in the repo root, under `[tasks]` as in `mise.toml`.
2. If the repo's agent tasks should get the file too, add the line `mise.local.toml` to `.worktreeinclude` in the repo root.
3. Open the repo's "mise tasks" tab and press "Ignore locally" if the section shows a warning.
4. For a copy off this computer, add a remote to the store with git: `git -C <projects folder>/.trackwall-local remote add origin <address>`.

## Good to know

- Only `mise.local.toml` and `.worktreeinclude` are backed up, and only real files of up to 1 MB, never a link.
- Values in `[env]` of `mise.local.toml` go into the store and to its remote. Keep secrets out of the file, or keep the remote private.
- The store's commits are made by "Trackwall", without your git hooks and signing.
- When another computer pushed to the remote first, the push fails and "Settings" says so. Pull and merge in the store yourself; Trackwall never pulls or forces a push.
- Restore never overwrites a file: a repo that already has its own `mise.local.toml` keeps it, and the next backup takes that one, with the old version kept in the store's history.
- A repo whose only mise tasks are in `mise.local.toml` does not get the `no-mise` [tag](/features/repo-card).
