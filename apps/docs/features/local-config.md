---
title: Local config backup
description: Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.
status: stable
---

# Local config backup

Keep mise tasks only on your computer, out of the repo, with every version backed up and restored into a new clone.

## What you get

- mise tasks that never reach the repo: write them in `mise.local.toml`, or keep a whole `mise.toml` out of git when the repo has none of its own.
- A backup a few seconds after you or an agent save the file, with every earlier version kept.
- Your files back by themselves when Trackwall clones a repo again, so a deleted folder costs you nothing.
- "Ignore locally", so the file never slips into a commit or a merge request.
- The same tasks on a second computer, through a private repo you choose as the remote, and, if you turn it on, your approved knowledge and routines, the board, your task templates, and Trackwall's and Copilot CLI's settings with the tokens taken out.

## How it works

Some teams do not want mise configuration in their repos. Then the tasks you work out for a repo, by hand or with an agent, go into `mise.local.toml` in the repo root. mise reads it on top of `mise.toml`, so the [mise tasks](/features/mise-tasks) tab, the [Batch command](/features/batch-command), [Services](/features/services) and agents run these tasks like any other.

Trackwall watches `mise.toml`, `mise.local.toml` and `.worktreeinclude` in every repo of your projects folder. A few seconds after one of them changes, it copies the file into the workspace store: the folder `.trackwall/local` in your projects folder, a git repo with one folder per repo under `repos/`. Each copy is a commit, so an older version is always there. A file that disappears from a repo stays in the store. A file the repo's own commits already have is the team's, and Trackwall leaves it alone: a `mise.toml` the repo commits is never copied, one you keep out of git is.

The "mise tasks" tab of a repo shows a "Local config" section with each file's state. When you clone a repo with the "+" button above the [repo list](/features/repos), its files come back from the store before the clone shows as done. In a repo cloned another way the state is "only in the store", and "Restore from the store" puts the files back. A file git does not ignore shows a warning: anyone working in the repo could commit it, an agent too. "Ignore locally" adds it to the clone's `.git/info/exclude`, which git never pushes. Restore does this by itself. [Where agents work](/guide/where-agents-work) shows how these files reach a session in the repo and a task's worktree.

"Settings > Workspace" shows where the store is, the last backup, and whether it was pushed. Without a remote the backups stay on this computer. With one, an HTTPS or SSH address of a private repo on a repo host that you allowed there, Trackwall pushes after every backup, and on another computer you clone the store into its projects folder; repos you then clone with Trackwall get their files back by themselves, and a repo already there gets them with "Restore from the store".

The store can also keep what you set up in Trackwall itself. Turn on "Keep Plan and knowledge in the store" under the workspace store in "Settings > Workspace", and once a minute Trackwall copies into the store the [knowledge](/features/knowledge) entries and [routines](/features/routines) in the version you approved, every item of the [board](/features/plan) and your own [task templates](/features/task-templates), each kind in a folder of its own. Changes made within that minute go into one commit. An entry an agent proposed stays out until you approve it, and an entry changed after you approved it stays in the store as you approved it until you approve the change. The store is only a copy: Trackwall and its agents keep reading these things from the projects folder, never from the store. Turning it off takes the four folders out of the store with one commit; their history stays.

Turn on "Keep Trackwall and Copilot CLI settings in the store" as well, and the same minute's commit also keeps your own setup: Trackwall's `workspace.yaml` in `trackwall/`, with your repo hosts, starred repos, session profile and the other settings, and in `copilot/` the Copilot CLI files your tasks depend on, `settings.json` (with the sandbox's paths), `copilot-instructions.md` and `mcp-config.json`. A token never goes in: in `mcp-config.json` every value under `env` and `headers`, and the value of an argument such as `--token`, becomes `<masked by Trackwall: fill in on this computer>`, unless it only names an environment variable, such as `${GITLAB_TOKEN}`, which stays as it is. The address of the store's remote in `workspace.yaml` loses its user and token. An `mcp-config.json` Trackwall cannot read as JSON is not copied, since its tokens cannot be found: the store keeps the version it has, and "Settings" says why.

A setting that is off only stops new copies. What the store already keeps leaves it only when you untick the setting in "Settings", so a new container, whose `workspace.yaml` starts empty, takes nothing out of the store.

## Use it

1. Write your tasks in `mise.local.toml` in the repo root, under `[tasks]` as in `mise.toml`.
2. If the repo's agent tasks should get the file too, add the line `mise.local.toml` to `.worktreeinclude` in the repo root.
3. Open the repo's "mise tasks" tab and press "Ignore locally" if the section shows a warning.
4. For a copy off this computer, create an empty private repo on your repo host and add it to the store with git: `git -C <projects folder>/.trackwall/local remote add origin <HTTPS or SSH address>`.
5. Open "Settings > Workspace" and press "Push to this remote" under the workspace store. Trackwall pushes the next backup there.
6. To keep your knowledge, routines, board and task templates in the store as well, tick "Keep Plan and knowledge in the store" there.
7. To keep `workspace.yaml` and your Copilot CLI settings there too, tick "Keep Trackwall and Copilot CLI settings in the store".

## Good to know

- Only `mise.toml`, `mise.local.toml` and `.worktreeinclude` are backed up, and only real files of up to 256 KB, never a link.
- Values in `[env]` of a backed-up `mise.toml` or `mise.local.toml` go into the store and to its remote. Keep secrets out of the file, or keep the remote private.
- The store's commits are made by "Trackwall", without your git hooks and signing. Agents never commit to the store.
- With "Keep Plan and knowledge in the store" on, your knowledge, routines, board and task templates go to the same remote as the mise files. If the remote is a private repo on a personal account, knowledge about work repos does not belong there: keep a work store on your company's repo host. The setting says where they go before you turn it on.
- With "Keep Trackwall and Copilot CLI settings in the store" on, `workspace.yaml` goes to the remote with the names of your repo hosts and the rules of your agents. The same as for knowledge: keep a work store on your company's repo host.
- Masking finds tokens where `mcp-config.json` keeps them, under `env` and `headers`, and in arguments named like `--token`, `--password` or `--api-key`. A token written anywhere else, such as inside a server's address or `copilot-instructions.md`, would go in as written: name an environment variable there instead.
- Copilot CLI's own `config.json`, with your sign-in, never goes in, and neither does the age key mise uses for encrypted values. Keep that key in a password manager: without it the encrypted values in a restored `mise.toml` cannot be read.
- A Copilot CLI file that is a link is not followed: the store keeps the version it has, and "Settings" says why.
- Bringing these files back from the store is not built yet. Until it is, copy them back by hand from the store's folder.
- The store gets a `README.md` with the first of these folders, which says what lies where. Trackwall writes it once and never over a `README.md` the store already has.
- Trackwall pushes the store only to the address you allowed, whatever the store's remote says later. An agent that can write in your projects folder could change that remote; the backups still go only to your address, and "Settings" shows the new remote with "Push to this remote". Press it only if you changed the remote yourself.
- "Stop pushing" under the store keeps the backups on this computer again. Removing the store's remote with git does not stop the pushes, since Trackwall pushes to the address you chose, not to whatever the store's remote says.
- Trackwall keeps the address you allowed in `~/.trackwall/workspace.yaml` as you wrote it. If it has a token in it and you keep that file in a repo, use a credential helper instead of the token.
- Trackwall pushes the store only to an HTTPS or SSH address. A remote in a local or shared folder cannot be chosen, and neither can a remote with several addresses, with a space, backslash or non-ASCII letter in its address, or whose user looks like a host name.
- When another computer pushed to the remote first, the push fails and "Settings" says so. Pull in the store yourself; Trackwall never pulls or forces a push. After a pull, each computer's own file wins: where it differs, Trackwall commits it on top, and the other version stays in the history.
- Trackwall checks the store before it uses it. If its `.git/config` has a setting git did not write itself, such as a filter, the backup stops and "Settings" names the setting to remove.
- Restore never overwrites a file: a repo that already has its own `mise.local.toml` keeps it, and the next backup takes that one, with the old version kept in the store's history.
- A repo whose mise tasks are only in these files does not get the `no-mise` [tag](/features/repo-card); it gets `local-mise` instead, so the repo list shows which repos have tasks only your clone has.
- On the "mise tasks" tab every task is marked "local" when it comes from one of these files, "repo" when it comes from the repo's git, and "outside repo" when it comes from your global mise config.
