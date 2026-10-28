---
title: Local config backup
description: Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.
---

# Local config backup

Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.

## What you get

- mise tasks that never reach the repo: write them in `mise.local.toml`, or keep a whole `mise.toml` out of git when the repo has none of its own.
- A backup a few seconds after you or an agent save the file, with every earlier version kept.
- Your files back by themselves when Trackwall clones a repo again, so a deleted folder costs you nothing.
- "Ignore locally", so the file never slips into a commit or a merge request.
- The same tasks on a second computer, through a private repo you choose as the remote.

## How it works

Some teams do not want mise configuration in their repos. Then the tasks you work out for a repo, by hand or with an agent, go into `mise.local.toml` in the repo root. mise reads it on top of `mise.toml`, so the [mise tasks](/features/mise-tasks) tab, the [Batch command](/features/batch-command), [Services](/features/services) and agents run these tasks like any other.

Trackwall watches `mise.toml`, `mise.local.toml` and `.worktreeinclude` in every repo of your projects folder. A few seconds after one of them changes, it copies the file into the local config store: the folder `.trackwall-local` in your projects folder, a git repo with one folder per repo. Each copy is a commit, so an older version is always there. A file that disappears from a repo stays in the store. A file the repo's own commits already have is the team's, and Trackwall leaves it alone: a `mise.toml` the repo commits is never copied, one you keep out of git is.

The "mise tasks" tab of a repo shows a "Local config" section with each file's state. When you clone a repo with the "+" button above the [repo list](/features/repos), its files come back from the store before the clone shows as done. In a repo cloned another way the state is "only in the store", and "Restore from the store" puts the files back. A file git does not ignore shows a warning: anyone working in the repo could commit it, an agent too. "Ignore locally" adds it to the clone's `.git/info/exclude`, which git never pushes. Restore does this by itself.

"Settings > Workspace" shows where the store is, the last backup, and whether it was pushed. Without a remote the backups stay on this computer. With one, an HTTPS or SSH address of a private repo on a repo host, Trackwall pushes after every backup, and on another computer you clone the store into its projects folder; repos you then clone with Trackwall get their files back by themselves, and a repo already there gets them with "Restore from the store".

## Use it

1. Write your tasks in `mise.local.toml` in the repo root, under `[tasks]` as in `mise.toml`.
2. If the repo's agent tasks should get the file too, add the line `mise.local.toml` to `.worktreeinclude` in the repo root.
3. Open the repo's "mise tasks" tab and press "Ignore locally" if the section shows a warning.
4. For a copy off this computer, create an empty private repo on your repo host and add it to the store with git: `git -C <projects folder>/.trackwall-local remote add origin <HTTPS or SSH address>`.

## Good to know

- Only `mise.toml`, `mise.local.toml` and `.worktreeinclude` are backed up, and only real files of up to 256 KB, never a link.
- Values in `[env]` of a backed-up `mise.toml` or `mise.local.toml` go into the store and to its remote. Keep secrets out of the file, or keep the remote private.
- The store's commits are made by "Trackwall", without your git hooks and signing.
- Trackwall pushes the store only to an HTTPS or SSH address. A remote in a local or shared folder is never pushed to, and "Settings" says so.
- When another computer pushed to the remote first, the push fails and "Settings" says so. Pull in the store yourself; Trackwall never pulls or forces a push. After a pull, each computer's own file wins: where it differs, Trackwall commits it on top, and the other version stays in the history.
- Trackwall checks the store before it uses it. If its `.git/config` has a setting git did not write itself, such as a filter, the backup stops and "Settings" names the setting to remove.
- Restore never overwrites a file: a repo that already has its own `mise.local.toml` keeps it, and the next backup takes that one, with the old version kept in the store's history.
- A repo whose mise tasks are only in these files does not get the `no-mise` [tag](/features/repo-card); it gets `local-mise` instead, so the repo list shows which repos have tasks only your clone has.
- On the "mise tasks" tab every task is marked "local" when it comes from one of these files, "repo" when it comes from the repo's git, and "outside repo" when it comes from your global mise config.
