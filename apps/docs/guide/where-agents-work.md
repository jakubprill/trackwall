---
title: Where agents work
description: How Trackwall layers your projects folder, each repo, your local config and a task's worktree, and what every agent sees in each place.
---

# Where agents work

How Trackwall layers your projects folder, each repo, your local config and a task's worktree, and what every agent sees in each place.

Every agent works in a real folder on your disk, and what it finds there is built in layers. Your projects folder sets what every repo shares. A repo adds the team's config from git and your own config that never leaves your computer. An [agent task](/features/tasks) adds its own copy of the repo, its worktree, on a branch of its own. Each layer adds to the one above it, and the lower one wins where both set the same thing.

## The folders on your disk

Everything Trackwall keeps beside your repos lives in one folder of your projects folder, `.trackwall`. Its name starts with a dot, so the [Repos](/features/repos) list skips it and it never shows up as a repo.

```text
<projects folder>/
├── mise.toml                    your tokens and settings for every repo
├── orders-api/                  a repo: your own working copy
│   ├── mise.toml                the team's tasks, committed in git
│   ├── mise.local.toml          your tasks, only on this computer
│   └── .worktreeinclude         which ignored files a task's worktree gets
└── .trackwall/
    ├── local/                   the local config store, a git repo of its own
    │   └── orders-api/
    │       ├── mise.local.toml  every version of your file, one commit each
    │       └── .worktreeinclude
    ├── worktrees/               the agent tasks' worktrees
    │   └── orders-api/
    │       └── fix-login/       one task: its branch, plus your copied files
    ├── lsp/                     the Java language server's index of each task with Java navigation
    ├── scratch/                 git's scratch files while Trackwall reads changes
    └── removed/                 repos the supervisor removed, until you delete them
```

Keeping them all in the projects folder is deliberate. They sit on the same disk as your repos, so git is as fast in a worktree as in the repo, and an antivirus exclusion for the projects folder covers them too. One folder is also one thing to back up. "Settings > Files" lists each of them with its state; see [Config files](/features/config-files).

Earlier versions kept these folders side by side as `.trackwall-local`, `.trackwall-worktrees` and so on. Trackwall moves them into `.trackwall` when it starts. An agent task you started before keeps its worktree in `.trackwall-worktrees` until you end it, and the old folder goes once it is empty.

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
                           + SERVER_PORT and PORT for mise tasks run there
                           ← an agent task works here
```

## What each agent sees

| Where it works | Projects folder `mise.toml` | The repo's committed `mise.toml` | Your own `mise.local.toml`, or a `mise.toml` git ignores | Task port in mise tasks |
|---|---|---|---|---|
| [Supervisor](/features/supervisor), free session | yes | no | no | no |
| [Session](/features/sessions) in a repo; "mise tasks" tab, [Services](/features/services) and [Batch command](/features/batch-command) in the repo | yes | yes | yes | no |
| [Agent task](/features/tasks), and services and mise tasks in its worktree | yes | as on the task's branch | only the files `.worktreeinclude` lists | yes |

When mise cannot give the environment of a place, a session gets the one of the place above it, and the line under its header says why: a repo whose config you have not trusted yet gives the projects folder's, and a worktree whose mise files the agent changed gives the repo root's until you press "Trust this config". [Environment from mise](/features/mise-environment) tells how secrets in these files stay hidden from the agent's tools, and [Environment variables](/guide/environment-variables) lists every variable involved.

## A task's worktree

A worktree is a second checkout of the same repo, sharing its history. Trackwall creates it from your repo's default branch, on a new branch named after the task, so the agent's changes never touch your working copy and you review them before anything lands.

A checkout has only the files git tracks. Your `.env`, a local Spring profile or your `mise.local.toml` are not tracked, so a fresh worktree lacks them, and a service that reads them does not start there. `.worktreeinclude` in the repo root fixes that: it lists those files with the patterns of `.gitignore`, and Trackwall copies the matching files from the repo root into each new worktree.

```text
# orders-api/.worktreeinclude
.env
mise.local.toml
src/main/resources/application-local.yml
```

Only files git ignores are copied, and a file you ignore with "Ignore locally" counts, since a repo's ignore list applies to its worktrees too. The copy is made once, when the task starts. [Agent tasks](/features/tasks) has the limits, and how the worktree's mise config is trusted.

## Your local config and the store

Some teams keep mise config out of their repos. Then your own tasks go into `mise.local.toml`, or into a whole `mise.toml` that git ignores. These files live only in your clone: delete the folder, and they are gone.

The local config store keeps them safe: Trackwall copies each of them, and `.worktreeinclude`, to `.trackwall/local/<repo>/` a few seconds after it changes, with every version kept, and puts them back when you clone the repo again.

The store and the worktrees never meet. The store backs up and restores your repo's own folder; a worktree gets its files from the repo root through `.worktreeinclude`. So the path of a file is always store → repo → worktree, and you only ever edit the one in the repo. [Local config backup](/features/local-config) has the details, including a private remote for a second computer.

## Good to know

- Moving worktrees with "Task worktrees folder" in Settings to a folder outside your projects folder also moves them out from under its `mise.toml`: tasks there no longer get the tokens set in it.
- A worktree has only what is on its branch and what `.worktreeinclude` copied when the task started. A file you add to the repo later does not reach it; copy it yourself, or start a new task.
- mise also reads config in the folders above your projects folder and its global config, so a variable set there reaches every agent too.
