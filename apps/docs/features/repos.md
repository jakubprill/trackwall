---
title: Repos
description: Browse, clone and sync every git repo in your projects folder from one list.
status: stable
---

# Repos

Browse, clone and sync every git repo in your projects folder from one list.

![All repos: catalog with 15 commits to pull, inventory diverged, orders-api and shop-web with uncommitted files, payments with 2 commits to pull, each with its next step, and the clean repos folded into one line under the table](/screenshots/repos.png)

## What you get

- "All repos": the repos that need a look in one table, each with what runs in it and its next step, and the clean ones folded into one line; every 15 minutes it learns of new commits on your repos' servers, without fetching them.
- Every repo of your projects folder in one list, with its branch, its uncommitted changes and the commits it has to pull, and the repos you starred at the top.
- "Sync all": every repo fetched, and every default branch moved forward where that is safe; "Pull" does the same for the branch you have checked out.
- The card, files, commits, uncommitted changes (file by file, with the diff) and README of each repo, and what is going on in it, without leaving Trackwall, and VS Code one click away.
- A search across your GitLab and GitHub hosts that clones the repo you pick in one click.

## How it works

Trackwall works with one projects folder: every git repo directly inside it is on the list in "Repos". A repo you clone into the folder appears by itself.

"Repos" opens on "All repos", the first entry of the list, which says in one line what your repos need, such as "3 to pull · 2 changed". Its table has a row for each repo that needs a look: it has uncommitted files, commits to pull from the server or new commits on it, a branch that has diverged from the server's, or git cannot read it. Each row says what is going on in the repo, such as a session waiting for you, and ends with the next step: "Pull" when its branch can move forward, "Changes" when changed files are in the way, "Shell" when the branches have diverged, or "Open". The clean repos fold into one line under the table, such as "15 more repos: clean, nothing to pull"; click it to see them. A row you pulled stays with what the pull did until you leave All repos, so you see it turn clean. In a narrow window, the parts of a repo's state stand under one another.

Every 15 minutes Trackwall asks the server of each repo whether the branch you have checked out, or the default branch, has new commits there, without fetching them. A repo whose checked-out branch has such commits reads "new on the server" in All repos, in the list and in the "Upstream" tile of its header, and its row and the tile offer "Pull", which fetches the commits and counts them. New commits on the default branch, where a new task starts, show in the New task form, which offers "Sync main" ([Tasks](/features/tasks)). The header of All repos says when the servers were asked, such as "Checked the servers for new commits 4 min ago." When a server does not answer, for example while your VPN is off, the header says so calmly, such as "Could not reach the server of 3 repos at 10:05.", and those repos show what their last fetch found. You can turn the check off under "Check for new commits" in "Settings > Repo hosts".

Select a repo and it opens on its [card](/features/repo-card), a summary of what the repo is and provides. The other tabs show its files, its latest commits, its uncommitted changes, its mise tasks, a [shell](/features/shell) in its folder and, last, its README (formatted as on GitHub, with tables, task lists, code and Mermaid diagrams).

The list is alphabetical, with your starred repos first. Hover over a repo in the list and click the star on its right to star it; click the filled star to unstar it, and the repo goes back to its place. Stars are kept in `~/.trackwall/workspace.yaml` (`starredRepos`), so they are the same in the app window and in a browser tab, and they stay when Trackwall restarts.

The list shows every repo as soon as you open it. Each one says "loading" until git has read it, and the repo you selected and the ones at the top of the list come first, so you do not wait for the whole folder. If reading fails, the list says so and offers "Retry".

The list and the repo header count your uncommitted work as "3 changed, 1 new". The list also counts the commits a repo has to pull, "15 to pull", says "diverged" when its branch has commits of its own too, or "new on the server" when the server has commits your last fetch did not bring. On a machine where starting git is slow, the list can show these counts up to about a minute late, so that it does not keep git busy; a commit, a checkout, a fetch or staging shows at once, and "Refresh the repo list", under the "…" button above the list, reads every repo anew. The "Changes" tab, or a click on the "Working tree" tile, shows those files with their diff; you commit or discard them in your editor.

"In this repo", under the header, lists the repo's task proposals, the sessions running in it, its tasks and its running mise tasks, each with its state, whichever tab is open. Click one to go to it: a proposal, session or task opens in "Sessions", a mise task in the "mise tasks" tab, and a mise task running in a task opens that task.

"Sync all", above the table of All repos, fetches every repo and moves its default branch to the remote one when that is a clean fast-forward. A repo with changes on its default branch, or with a branch that has diverged, stays untouched. The table follows the sync as it goes: a repo whose default branch moved turns clean, and a repo with another branch checked out can show commits to pull that it had not fetched before. "Results", next to the button, says in one sentence per repo what happened: whether the default branch moved, whether your files changed, and how many uncommitted files are left. The same sentence is in the tooltip on the list.

"Sync all" moves only the default branch. When you have another branch checked out, such as `develop`, its fetch is what makes the "Upstream" tile in the repo header show commits to pull, for example "↓ 320 origin/develop". The "Pull 320" button under that number, and the same button in the repo's row of All repos, fetches the repo, moves the default branch as "Sync all" does, and moves your checked-out branch to the branch it tracks when that is a clean fast-forward. It never merges, rebases, pushes or touches your uncommitted changes. When it cannot pull, the tile says why and where to go instead: "Show changes" when changed files are in the way, "Open Shell" when your branch and the remote one have diverged. When a session or a mise task works in the repo folder itself, the button asks first, because pulling changes files under it; tasks work in their own folders and are not affected. When it is done, the tile or the row says how many commits came, also the ones the fetch found after the number was shown.

When changed files are in the way, the tile also offers "Put aside and pull…". It lists every file that would leave the working folder and asks before anything moves. The changes go into a git stash, not the bin: new files stay where they are, and when the pull still cannot move your branch, the changes come back at once. The repo's Changes tab then lists them under "Put aside by Trackwall", with "Restore" to bring them back and "Delete…" to drop them for good. `git stash pop` in a terminal brings them back too. Your own stashes are not listed or touched.

The "+" button above the list searches the GitLab and GitHub hosts you added in "Settings > Repo hosts" and clones the repo you pick into the projects folder. The search matches the repo's name, group and description. On GitLab, "My projects" covers the projects you are a member of, also through a group, and "All I can see" adds every project you can open, such as other teams' internal ones. You can narrow the list to one topic, one language (`Java`, `TypeScript`) or the repos you starred on the host, and each repo shows its topics. GitLab gives the results 100 at a time, most recently changed first; "Show more" adds the next 100. While you type, the results you see stay in place, dimmed, until the new ones arrive. If the [local config backup](/features/local-config) has files for that repo, such as `mise.local.toml`, they are put back before the clone shows as done.

## Use it

1. Open "Settings" and choose your projects folder with "Choose…", or drop the folder onto the Trackwall window. When your home folder has a `Dev`, `Projects`, `Code` or `source\repos` folder, Settings offers it with "Use this folder".
2. Open "Repos" (Ctrl+2, ⌘2 on macOS). It opens on "All repos".
3. Press "Sync all" above the table to bring every repo up to date.
4. In a row with commits to pull, or new on the server, press "Pull"; in any other row, press its next step.
5. Select a repo in the list to open it, and star the repos you open most, so they stay at the top.
6. To clone, press "+", search for the repo (or pick a topic or language) and press "Clone" next to it.

## Good to know

- Trackwall needs `git` on your `PATH`. Cloning needs a signed-in `glab` (`glab auth login --hostname <host>`) for GitLab or `gh` (`gh auth login`) for GitHub; Trackwall does not store your token.
- The search shows at most 1000 repos per host. On GitLab, type at least 3 characters of the name, or pick a topic or language, and GitLab searches all of its projects; on GitHub, Trackwall filters your first 1000 repos. "Show more" adds 100 more on every GitLab host at once. GitHub always lists your own repos, those you collaborate on and those of your organisations, so "My projects" and "All I can see" change only the GitLab results. A search shorter than 3 characters filters the repos already shown.
- Only repos directly inside the projects folder are listed, and folders whose name starts with a dot are skipped.
- The commits to pull are counted as of the repo's last fetch. Trackwall never fetches by itself, so a repo whose server got commits since then says only "new on the server", without a number, until "Sync all", "Pull" or your own `git fetch` counts them. The header of All repos, and the tooltip on "From the server", say when your repos last fetched and when the servers were asked.
- The check for new commits asks only about the branch you have checked out, and only servers with an HTTPS or SSH address. It signs in the way the "Git access to repo hosts" check in [Diagnostics](/features/doctor) does: with your own SSH key or credential manager, never asking for a password, and without the settings of the repo itself. When a server cannot be reached, that check says why.
- When Trackwall runs in a [dev container](/guide/dev-container), All repos has a column "Only in this container" with the work that is on no remote, such as commits you have not pushed and stashes, which removing the Docker volume would delete; "Shell" in the row opens a shell in the repo to push it.
- A commit, checkout, pull or new branch, made in Trackwall or anywhere else, shows in the list within a couple of seconds, and so does a repo cloned into the folder. The count of uncommitted files refreshes about every 30 seconds.
- Dropping a folder on the window: a listed repo opens in "Repos"; a folder full of repos, or a repo from somewhere else, is offered as the new projects folder.
- "Show in Explorer" ("Show in Finder" on macOS) in the repo header opens the repo folder.
- In a README, links to websites open in your browser; links to files in the repo and images show only as text. A `.txt`, `.rst` or `.adoc` README stays plain text.
- The projects folder, the hosts and the check for new commits are saved in `~/.trackwall/workspace.yaml` (`projectsDir`, `repoHosts` and `serverCheck`), where you can also edit them by hand.
- If starting git is slow on your machine (security software checks every program start), you can point "Git program" in "Settings > Workspace" at another git, for example [MinGit](https://github.com/git-for-windows/git/releases) unpacked into a folder your antivirus skips. Trackwall then reads your repos with that git right away; fetch, push and clone keep using git from `PATH`. Clear the field to go back. A path typed into `workspace.yaml` by hand (`gitProgram`) is used once you open Settings or restart Trackwall.
- When Trackwall runs in a [dev container](/guide/dev-container), "Open in VS Code" opens the repo in VS Code inside the container (with the Dev Containers extension), "Show in Explorer" is not there, and README links open in a new tab of your browser.
