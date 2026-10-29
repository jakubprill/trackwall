---
title: Where agents work
description: How Trackwall layers your projects folder, each repo, your local config and a task's worktree, and what every agent sees in each place.
---

# Where agents work

How Trackwall layers your projects folder, each repo, your local config and a task's worktree, and what every agent sees in each place.

Every agent works in a real folder on your disk, and what it finds there is built in layers. Your projects folder sets what every repo shares. A repo adds the team's config from git and your own config that never leaves your computer. An [agent task](/features/tasks) adds its own copy of the repo, its worktree, on a branch of its own. Each layer adds to the one above it, and the lower one wins where both set the same thing.

## The folders on your disk

Everything Trackwall keeps beside your repos lives in your projects folder, in folders whose names start with a dot. The [Repos](/features/repos) list skips them, so they never show up as repos.

```text
<projects folder>/
├── mise.toml                    your tokens and settings for every repo
├── orders-api/                  a repo: your own working copy
│   ├── mise.toml                the team's tasks, committed in git
│   ├── mise.local.toml          your tasks, only on this computer
│   └── .worktreeinclude         which ignored files a task's worktree gets
├── .trackwall-local/            the local config store, a git repo of its own
│   └── orders-api/
│       ├── mise.local.toml      every version of your file, one commit each
│       └── .worktreeinclude
├── .trackwall-worktrees/        the agent tasks' worktrees
│   └── orders-api/
│       └── fix-login/           one task: its branch, plus your copied files
├── .trackwall-scratch/          git's scratch files while Trackwall reads changes
└── .trackwall-removed/          repos the supervisor removed, until you delete them
```

Keeping them all in one folder is deliberate. They sit on the same disk as your repos, so git is as fast in a worktree as in the repo, and an antivirus exclusion for the projects folder covers them too. One folder is also one thing to back up. "Settings > Files" lists each of them with its state; see [Config files](/features/config-files).

## How the layers stack

mise reads every config from the folder an agent works in up to the top of your disk. That is why a layer inherits everything above it: a task's worktree lies inside the projects folder, so it gets the projects folder's `mise.toml` as well as its own.

```text
 Your environment          variables of your sign-in · global mise config
   │
   ▼
 Projects folder           mise.toml: tokens and settings for every repo
   │                       ← the supervisor and free sessions work here
   ▼
 Repo root                 mise.toml from git (the team's)
   │                       mise.local.toml, or a mise.toml git ignores (yours)
   │                       ← a session in the repo and the "mise tasks" tab work here
   │
   │   git worktree + copy of the files .worktreeinclude names
   ▼
 Task worktree             the files of the task's branch
                           + your ignored files, copied once when the task starts
                           + SERVER_PORT and PORT: the task's own port
                           ← an agent task works here
```

## What each agent sees

| Where it works | Projects folder `mise.toml` | Repo `mise.toml` | Your `mise.local.toml` | Task port |
|---|---|---|---|---|
| [Supervisor](/features/supervisor), free session | yes | no | no | no |
| [Session](/features/sessions) in a repo | yes | yes | yes | no |
| "mise tasks" tab, [Services](/features/services), [Batch command](/features/batch-command) | yes | yes | yes | no |
| [Agent task](/features/tasks) | yes | as on the task's branch | only when `.worktreeinclude` lists it | yes |

A session gets its environment when it starts: change a `mise.toml` and the session sees it after you resume or start it again. [Environment from mise](/features/mise-environment) tells how secrets in these files stay hidden from the agent's tools, and [Environment variables](/guide/environment-variables) lists every variable involved.

## A task's worktree

A worktree is a second checkout of the same repo, sharing its history. Trackwall creates it from your repo's default branch, on a new branch named after the task, so the agent's changes never touch your working copy and you review them before anything lands.

A checkout has only the files git tracks. Your `.env`, a local Spring profile or your `mise.local.toml` are not tracked, so a fresh worktree lacks them, and a service that reads them does not start there. `.worktreeinclude` in the repo root fixes that: it lists those files with the patterns of `.gitignore`, and Trackwall copies the matching files from the repo root into each new worktree.

```text
# orders-api/.worktreeinclude
.env
mise.local.toml
src/main/resources/application-local.yml
```

Trackwall copies a file only when git ignores it, so a copy never overwrites a file of the branch and the agent cannot commit it by accident. A file you ignore with "Ignore locally" counts: the repo's own ignore list applies to its worktrees too. The copy happens once, when the task starts; a later change in the repo does not reach the worktree. The task panel lists what it copied and what it left out, and [Agent tasks](/features/tasks) has the limits.

The worktree runs mise tasks only with config you agreed to: the repo root's config must be trusted, and the worktree's mise files must be the ones it started with. When the agent changes one, nothing runs there until you read the change and press "Trust this config".

## Your local config and the store

Some teams keep mise config out of their repos. Then your own tasks go into `mise.local.toml`, or into a whole `mise.toml` that git ignores. These files live only in your clone: delete the folder, and they are gone.

The local config store keeps them safe. A few seconds after `mise.toml`, `mise.local.toml` or `.worktreeinclude` changes in a repo, Trackwall copies it to `.trackwall-local/<repo>/` and commits it there, so every version stays. A `mise.toml` the repo commits is the team's and is never copied. When you clone the repo again with Trackwall, the files come back before the clone shows as done, and git is told to ignore them.

The store and the worktrees never meet. The store backs up and restores your repo's own folder; a worktree gets its files from the repo root through `.worktreeinclude`. So the path of a file is always store → repo → worktree, and you only ever edit the one in the repo. [Local config backup](/features/local-config) has the details, including a private remote for a second computer.

## Good to know

- Moving worktrees with "Task worktrees folder" in Settings to a folder outside your projects folder also moves them out from under its `mise.toml`: tasks there no longer get the tokens set in it.
- A worktree has only what is on its branch and what `.worktreeinclude` copies. A file you add to the repo after the task started does not reach it; end the task and start a new one, or copy the file yourself.
- `.worktreeinclude` itself can stay untracked, and the store backs it up like your mise files.
- mise also reads config in the folders above your projects folder and its global config, so a variable set there reaches every agent too.
- Tasks created before worktrees moved into the projects folder keep theirs in `~/.trackwall/worktrees/<repo>/` until they end.
