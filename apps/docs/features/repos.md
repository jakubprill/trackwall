---
title: Repos
description: Browse, clone and sync every git repo in your projects folder from one list.
---

# Repos

Browse, clone and sync every git repo in your projects folder from one list.

![The repo list with the uncommitted changes of orders-api](/screenshots/repos.png)

## What you get

- Every repo of your projects folder in one list, with its branch, its uncommitted changes and how far it is ahead of or behind its remote.
- The card, files, commits, uncommitted changes (file by file, with the diff) and README of each repo without leaving Trackwall, and VS Code one click away.
- A search across your GitLab and GitHub hosts that clones the repo you pick in one click.
- "Sync all": every repo fetched, and every default branch moved forward where that is safe.
- What is going on in a repo at a glance: its sessions, tasks, task proposals and running mise tasks, one click from each.

## How it works

Trackwall works with one projects folder: every git repo directly inside it is on the list in "Repos". A repo you clone into the folder appears by itself. Select a repo and it opens on its [card](/features/repo-card), a summary of what the repo is and provides. The other tabs show its files, its latest commits, its uncommitted changes, its mise tasks and, last, its README (formatted as on GitHub, with tables, task lists, code and Mermaid diagrams).

The list shows every repo as soon as you open it. Each one says "loading" until git has read it, and the repo you selected and the ones at the top of the list come first, so you do not wait for the whole folder. If reading fails, the list says so and offers "Retry".

The list and the repo header count your uncommitted work as "3 changed, 1 new". The "Changes" tab, or a click on the "Working tree" tile, shows those files with their diff; you commit or discard them in your editor.

"In this repo", under the header, lists the repo's task proposals, the sessions running in it, its tasks and its running mise tasks, each with its state, whichever tab is open. Click one to go to it: a proposal, session or task opens in "Sessions", a mise task in the "mise tasks" tab, and a mise task running in a task opens that task.

"Sync all" fetches every repo and moves its default branch to the remote one when that is a clean fast-forward. A repo with changes on its default branch, or with a branch that has diverged, stays untouched. When the sync is done, a panel says in one sentence per repo what happened: whether the default branch moved, whether your files changed, and how many uncommitted files are left. The same sentence is in the tooltip on the list.

The "+" button above the list searches the GitLab and GitHub hosts you added in "Settings > Repo hosts" and clones the repo you pick into the projects folder. If the [local config backup](/features/local-config) has files for that repo, such as `mise.local.toml`, they are put back before the clone shows as done.

## Use it

1. Open "Settings" and choose your projects folder with "Choose…", or drop the folder onto the Trackwall window. When your home folder has a `Dev`, `Projects`, `Code` or `source\repos` folder, Settings offers it with "Use this folder".
2. Open "Repos" (Ctrl+2, ⌘2 on macOS) and select a repo.
3. Press "Sync all" to bring every repo up to date.
4. To clone, press "+", search for the repo and pick it.

## Good to know

- Trackwall needs `git` on your `PATH`. Cloning needs a signed-in `glab` (`glab auth login --hostname <host>`) for GitLab or `gh` (`gh auth login`) for GitHub; Trackwall does not store your token.
- Only repos directly inside the projects folder are listed, and folders whose name starts with a dot are skipped.
- A commit, checkout, pull or new branch, made in Trackwall or anywhere else, shows in the list within a couple of seconds, and so does a repo cloned into the folder. The count of uncommitted files refreshes about every 30 seconds.
- Dropping a folder on the window: a listed repo opens in "Repos"; a folder full of repos, or a repo from somewhere else, is offered as the new projects folder.
- "Show in Explorer" ("Show in Finder" on macOS) in the repo header opens the repo folder.
- In a README, links to websites open in your browser; links to files in the repo and images show only as text. A `.txt`, `.rst` or `.adoc` README stays plain text.
- The projects folder and the hosts are saved in `~/.trackwall/workspace.yaml` (`projectsDir` and `repoHosts`), where you can also edit them by hand.
- If starting git is slow on your machine (security software checks every program start), you can point "Git program" in "Settings > Workspace" at another git, for example [MinGit](https://github.com/git-for-windows/git/releases) unpacked into a folder your antivirus skips. Trackwall then reads your repos with that git right away; fetch, push and clone keep using git from `PATH`. Clear the field to go back. A path typed into `workspace.yaml` by hand (`gitProgram`) is used once you open Settings or restart Trackwall.
- When Trackwall runs in a [dev container](/guide/dev-container), "Open in VS Code" and "Show in Explorer" are not there, and README links open in a new tab of your browser.
