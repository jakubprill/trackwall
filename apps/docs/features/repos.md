---
title: Repos
description: Browse, clone and sync every git repo in your projects folder from one list.
---

# Repos

Browse, clone and sync every git repo in your projects folder from one list.

![The repo list with the uncommitted changes of orders-api](/screenshots/repos.png)

## What you get

- Every repo of your projects folder in one list, with its branch, its uncommitted changes and how far it is ahead of or behind its remote.
- The README, files and commits of each repo without leaving Trackwall, and VS Code one click away.
- A search across your GitLab and GitHub hosts that clones the repo you pick in one click.
- "Sync all": every repo fetched, and every default branch moved forward where that is safe.
- A view of your uncommitted changes, file by file, with the diff.

## How it works

Trackwall works with one projects folder: every git repo directly inside it is on the list in "Repos". A repo you clone into the folder appears by itself. Select a repo to see its README (formatted as on GitHub, with tables, task lists, code and Mermaid diagrams), its files and its latest commits.

The list and the repo header count your uncommitted work as "3 changed, 1 new". The "Changes" tab, or a click on the "Working tree" tile, shows those files with their diff; you commit or discard them in your editor.

"Sync all" fetches every repo and moves its default branch to the remote one when that is a clean fast-forward. A repo with changes on its default branch, or with a branch that has diverged, stays untouched. When the sync is done, a panel says in one sentence per repo what happened: whether the default branch moved, whether your files changed, and how many uncommitted files are left. The same sentence is in the tooltip on the list.

The "+" button above the list searches the GitLab and GitHub hosts you added in "Settings" and clones the repo you pick into the projects folder.

## Use it

1. Open "Settings" and choose your projects folder with "Choose…", or drop the folder onto the Trackwall window.
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
