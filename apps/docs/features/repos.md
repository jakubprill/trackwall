# Repos

Browse, clone and sync every repo in your projects folder.

In the "Settings" view you set the projects folder (by full path), and the "Repos" view shows every git repo that lies directly in it: branch, number of changes and ahead/behind, the README, files and commits from the latest commit, and opens the repo in VS Code. A Markdown README is formatted as on GitHub: headings, tables, task lists, code blocks and Mermaid diagrams (with zoom and full screen); a link to a website opens in the browser, links to files in the repo are text, and images show only their description; a `.txt`, `.rst` or `.adoc` README stays plain text (ADR-35).

A repo cloned into the folder appears on the list by itself. The "+" button on the repo list opens a search for repos from GitLab and GitHub (hosts are added in "Settings") and clones the chosen one with one click; it needs a logged-in `glab` (`glab auth login --hostname <host>`) or `gh` (`gh auth login`) in `PATH`, and Trackwall does not store the token. The "Sync all" button fetches the changes of every repo (`git fetch`) and moves the default branch to the remote one when it is a clean fast-forward; a repo with changes in the default branch or with a diverged branch stays untouched.

The sync panel in place of the repo details has a sentence about every repo, including an up-to-date one: what happened to the default branch, whether the files changed (no, when you work on another branch) and how many uncommitted files are left, changed and new separately; the same sentence is in the tooltip of the result on the repo list. The list and the repo header write changes as "3 changed, 1 new" (a new directory is one entry), and the "Changes" tab (or a click on the "Working tree" tile) shows the files and diff of the working directory against the latest commit, with new files; you commit and discard them in the editor.

In the Trackwall window, "Choose…" next to the projects folder path opens the system folder picker, and the folder you pick is saved at once. "Show in Explorer" (Finder on macOS) in the repo header opens the repo folder. A folder dropped on the window outside a session opens that repo in Repos when it is already listed; a folder with repos directly inside it, or a repo from somewhere else, is offered as the projects folder (for a repo, the folder that holds it), because Trackwall lists the repos of one folder (ADR-51).

A folder inside a listed repo opens that repo, the projects folder itself opens Repos, and a repo whose name starts with a dot is only reported, because the list skips such folders. Dragging text or a link onto the window does nothing. The folder path is the `projectsDir` key, and the hosts the `repoHosts` key in `~/.trackwall/workspace.yaml`; both can also be set by hand. Needs `git` in `PATH`.

## Decisions

Why it works this way: [ADR-35](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-51](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
