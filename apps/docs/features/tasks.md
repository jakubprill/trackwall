---
title: Agent tasks
description: Give an agent a task on its own branch and worktree, and review its changes before anything lands.
---

# Agent tasks

Give an agent a task on its own branch and worktree, and review its changes before anything lands.

![An agent task in pricing, working on its own branch](/screenshots/tasks.png)

## What you get

- A task for an agent in two fields: a repo and a prompt.
- A fresh branch and a separate working copy for every task, so several agents can work in one repo at once and your own working copy stays untouched.
- The task's changes live: files, diff and commits against the default branch, with a warning when two tasks in one repo change the same files.
- A worktree ready to run: the task's builds and tests run there, where you can watch and stop them, with your local config files (`.env`, a local profile) copied in and a port of its own, so the agent can also start the service it changed next to yours.
- Tasks that survive a restart of Trackwall, ready to resume.

## How it works

Press "+" in "Sessions", pick a repo and write the prompt. Trackwall creates a branch named after the task's title or prompt (`trackwall/<slug>`) from the repo's default branch, in a separate git worktree, and starts Copilot CLI there with your prompt as the first message. The task shows on the list like a session, with the same states.

The "Changes" tab follows the worktree live: the files and diff against the default branch, the task's commits and what the agent has not committed yet. "VS Code" opens the worktree in your editor. When the agent finishes, it leaves a summary above the task's tabs.

When another task in the same repo changes some of the same files, a warning above the tabs names that task and lists the shared files, with "Open that task". Trackwall only warns; both tasks carry on.

The agent builds and tests its changes by running the repo's mise tasks in the task's worktree. While one runs, it shows above the task's tabs with "Log" and "Stop". Trackwall runs them only with the mise configuration you have agreed to: the one the worktree started with. If the agent changes a mise file (`mise.toml`, `.tool-versions`, a file task), a warning above the tabs lists the changed files, each of which you can open to read, and no mise task runs in the worktree until you have read them and press "Trust this config". If the agent changes them again while the warning is open, it says so and shows the new version only when you ask, so you always trust what you read.

A new worktree has only the files git tracks, so local config that is ignored by git is missing there. List those files in a `.worktreeinclude` file in the repo, with the same patterns as `.gitignore` (for example `.env` and `src/main/resources/application-local.yml`), and Trackwall copies them from the repo into every new task's worktree. Only files git ignores are copied, so the list never overwrites a file of the repo. The task panel lists the files it copied and anything it left out.

Every task also gets a port of its own, shown in the task's header. Every mise task that runs in the worktree gets it in `SERVER_PORT` and `PORT`, so the agent can start the repo's [service](/features/services) from the worktree without taking the port of the one you run from the repo.

"Resume" starts Copilot CLI again with the task's conversation. "End task" removes the worktree and keeps the branch, or removes both; if that would lose changes, Trackwall asks first. A task cannot be ended while a mise task runs in its worktree: stop it first.

## Use it

1. Open "Sessions" and press "+".
2. Pick a repo, write the prompt and start the task.
3. Watch the agent in the terminal and its work in "Changes".
4. Review the changes in VS Code, then push the branch yourself or end the task.

## Good to know

- Worktrees live in `~/.trackwall/worktrees/<repo>/`.
- `.worktreeinclude` can stay untracked; Claude Code reads the same file. At most 100 files and 10 MB are copied, and only regular files, not links. Files are copied once, when the task is created: a change in the repo later does not reach the worktree.
- The copied files often hold secrets. The task's agent can read them, as it could read them in the repo, and they are removed with the worktree when the task ends.
- Task ports are 41000 to 41999. A task keeps its port until it ends; Trackwall does not check that no other program uses it, and a service that finds its port taken says so.
- A task created with an older version of Trackwall asks you to trust its mise configuration once before its first mise task.
- A mise file or folder that is a symbolic link Trackwall cannot check (to something outside the worktree, a broken link, or a linked folder) stops mise tasks there, and the warning says why.
- Trusting a mise configuration covers the commands it defines, not the code they run: tests and build scripts the agent changed run as written. Review the changes as you would before merging.
- Copilot CLI asks to trust every new folder. To stop it asking for every task, add the `worktrees` folder (the new task form shows its full path) to `trustedFolders` in `~/.copilot/config.json`.
- Trackwall tells a task's agent to stay in its worktree, commit on its branch and not push unless your prompt asks for it. This is an instruction to the agent, not a lock: the branch is yours to push.
- After running the tests in its worktree, the agent reads which tests failed and why from the reports your build tools write there, instead of scrolling the build log.
- An agent can also propose a task for you to start: see [Main session and task proposals](/features/main-session).
