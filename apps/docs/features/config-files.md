---
title: Config files
description: See every file and folder Trackwall reads or writes on your computer, what each is for, where it is and whether it is in order.
---

# Config files

See every file and folder Trackwall reads or writes on your computer, what each is for, where it is and whether it is in order.

## What you get

- One list of Trackwall's files and folders, grouped by where they lie, each with a sentence on what it is for and a link to its page here.
- Every key of `workspace.yaml` with its value, whether you set it or Trackwall uses its default, and where to change it, including the keys you can only write by hand.
- A key you typed wrong or misspelled, named with its line in the file, also in the doctor.
- The local config of all your repos at once: which have `mise.local.toml`, a `mise.toml` kept out of git, or `.worktreeinclude`, whether each is backed up and whether git ignores it.

## How it works

Open "Settings" and choose "Files". The list has three groups. "Trackwall" is Trackwall's own folder, `~/.trackwall` unless the `TRACKWALL_HOME` environment variable names another one: it holds `workspace.yaml` and the files Trackwall keeps for itself, folded into one line, since Trackwall rewrites them. "Projects folder" holds your repos and the folders Trackwall keeps beside them, with names that start with a dot: the mise config every session gets, the [local config](/features/local-config) backup, the [task](/features/tasks) worktrees and the repos the [supervisor](/features/supervisor) removed. "Copilot CLI" is Copilot CLI's `config.json`, which Trackwall only reads.

Each file or folder shows who writes it (you, Trackwall or Copilot CLI), whether it is there ("found", "not there", "not created yet" or "cannot be read"), what is in it in one line, and its full path. "Open in VS Code" opens a file, "Show in Explorer" (Finder on macOS) opens its folder, and "Docs" opens its page on this site.

Under `workspace.yaml` a table lists its keys:

| Key | What it does | Changed in |
| --- | --- | --- |
| `projectsDir` | the folder with all your repos | "Settings > Workspace" |
| `worktreesDir` | where agent tasks get their own copy of a repo | "Settings > Workspace" |
| `repoHosts` | where the Repos view searches and clones from | "Settings > Repo hosts" |
| `toolPermissions` | which tools sessions may use without asking you | by hand |
| `agentSecrets` | the secrets from mise that the tools of sessions may read | by hand |
| `supervisor` | whether the supervisor may change code itself | by hand |
| `repoTags` | your own tags on repo cards | by hand |
| `dayStart` | your addition to the first message of Start my day | by hand |
| `graph` | package aliases and links the graph cannot find by itself | by hand |

A key Trackwall cannot read shows its line and the reason in red, and a key Trackwall does not know, such as a misspelled one, its line in yellow; the [doctor](/features/doctor) lists both. The other keys keep working meanwhile, and a misspelled key leaves its setting at the default.

"Local config in repos" below lists only the repos that have a local config file or a backup of one, with "Restore from the store" and "Ignore locally" as on the repo's "mise tasks" tab.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS) and choose "Files".
2. Read the line under a file to see what is in it; click "Docs" to learn more about it.
3. To change a key marked "by hand", click "Open in VS Code" next to `workspace.yaml`, edit it and save.
4. Click "Check again" to see the result.

## Good to know

- The view only reads. It never changes a file; Settings and your editor do.
- `daemon.json` and each session's files hold the key the app and sessions use to reach Trackwall, so they are not in the list.
- For the mise config, only the names of the variables and secrets are shown, never their values.
- mise also reads config from the folders above the projects folder and its own global config; the list shows only the one in the projects folder.
