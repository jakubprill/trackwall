---
title: Agent tasks
description: Give an agent a task on its own branch and worktree, and review its changes before anything lands.
---

# Agent tasks

Give an agent a task on its own branch and worktree, and review its changes before anything lands.

![An agent task in pricing on its own branch, with a failed verification of its tests](/screenshots/tasks.png)

## What you get

- A task for an agent in two fields, a repo and a prompt, that survives a restart of Trackwall, ready to resume.
- A fresh branch and a separate working copy for every task, so several agents can work in one repo at once and your own working copy stays untouched.
- The task's changes live: files, diff and commits against the default branch, with a warning when two tasks in one repo change the same files.
- Comments on the lines of that diff, sent to the agent as one review, so it fixes what you pointed at without you retyping file names and lines into its terminal.
- A worktree ready to run: the task's builds and tests run there, where you can watch and stop them, with your local config files (`.env`, a local profile) copied in and a port of its own, so the agent can also start the service it changed next to yours, and one "Verify" button that runs the task's tests there and shows whether they pass.

## How it works

Press "+" in "Sessions", pick a repo and write the prompt. Trackwall creates a branch named after the task's title or prompt (`trackwall/<slug>`) from the repo's default branch, in a separate git worktree, and starts Copilot CLI there with your prompt as the first message. The task shows on the list like a session, with the same states.

The "Changes" tab follows the worktree live: the files and diff against the default branch, the task's commits and what the agent has not committed yet. "VS Code" opens the worktree in your editor. When the agent finishes, it leaves a summary above the task's tabs. A task that another session proposed also shows, above the summary, the messages that session sent its agent (see [Main session and task proposals](/features/main-session)).

To ask for changes, hover a line of the diff in "Changes" and press the comment icon in front of it. Write what the agent should change and press "Add comment" (or Ctrl+Enter, ⌘+Enter on a Mac). Add as many comments as you like, on added, unchanged or removed lines; they gather in a list above the diff, where you can remove one before sending. "Send N comments to the agent" sends them all as one review. If the agent is waiting for you, it gets the review at once; if it is in the middle of something, or asks for your approval, it gets it as soon as it waits for you again; and if the task has no session, it gets it when you press "Resume". The line under the list says which of these happened. The agent reads every comment with its file, line and the code on that line, makes the changes, commits and reports again.

![Two review comments waiting to be sent, and a third being written under its line](/screenshots/task-review.png)

When another task in the same repo changes some of the same files, a warning above the tabs names that task and lists the shared files, with "Open that task". Trackwall only warns; both tasks carry on.

The agent builds and tests its changes by running the repo's mise tasks in the task's worktree. While one runs, it shows above the task's tabs with "Log" and "Stop". Trackwall runs them only with the mise configuration you have agreed to: the one the worktree started with. If the agent changes a mise file (`mise.toml`, `.tool-versions`, a file task), a warning above the tabs lists the changed files, each of which you can open to read, and no mise task runs in the worktree until you have read them and press "Trust this config". If the agent changes them again while the warning is open, it says so and shows the new version only when you ask, so you always trust what you read.

To check the task's changes yourself, press "Verify" in the task's header. Trackwall runs the repo's mise task `test` in the worktree and, when it ends, shows a "Verification" section below the summary: passed or failed, why it failed (such as the mise task's exit code), how many tests ran, failed and were skipped, and the first failed tests with their messages and the first errors from the run's log. "Log" opens the whole output, and "Cancel" stops a run in progress. The agent gets the same verdict: Trackwall asks it to verify its task before it reports that it is done, so a finished task usually shows its verdict already. A verification passes when the mise task exits with code 0 and no test in the reports the run wrote failed; a report Trackwall cannot read counts as a failure, since it may hide one.

A new worktree has only the files git tracks, so local config that is ignored by git is missing there. List those files in a `.worktreeinclude` file in the repo, with the same patterns as `.gitignore` (for example `.env` and `src/main/resources/application-local.yml`), and Trackwall copies them from the repo into every new task's worktree. Only files git ignores are copied, so the list never overwrites a file of the repo, and the agent does not commit them by accident. The task panel lists the files it copied and anything it left out.

Every task also gets a port of its own, shown in the task's header. Every mise task that runs in the worktree gets it in `SERVER_PORT` and `PORT`, so the agent can start the repo's [service](/features/services) from the worktree without taking the port of the one you run from the repo.

"Resume" starts Copilot CLI again with the task's conversation. "End task" (also the X of a task without a session in the Sessions list and grid) removes the worktree and keeps the branch, or removes both; if that would lose changes, Trackwall asks first. A task cannot be ended while a mise task runs in its worktree: stop it first.

## Use it

1. Open "Sessions" and press "+".
2. Pick a repo, write the prompt and start the task.
3. Watch the agent in the terminal and its work in "Changes".
4. Press "Verify" to see whether its tests pass.
5. Comment on the lines you want changed and press "Send N comments to the agent"; repeat until you are happy.
6. Review the changes in VS Code, then push the branch yourself or end the task.

## Good to know

- Worktrees live in `~/.trackwall/worktrees/<repo>/`.
- Comments you have not sent yet stay while you switch between "Terminal" and "Changes", but not when you open another task. While a comment form is open, "Changes" stops refreshing, so the line does not move under it. A review holds up to 15 comments of up to 2000 characters, and up to 60 comments can wait for the agent to read them; beyond that Trackwall asks you to wait. Sent comments the agent has not read yet are lost if Trackwall restarts; send them again.
- Trackwall asks the agent to read the review by typing one line into its terminal, but only while the agent waits for your message. If you have typed something there that you have not sent yet, the review waits until you send it; if you stopped the agent with Esc, it waits until the agent's next turn ends.
- `.worktreeinclude` can stay untracked; Claude Code reads the same file. At most 100 files and 10 MB are copied, and only regular files, not links; the task panel names every file left out and why. Files are copied once, when the task is created: a change in the repo later does not reach the worktree.
- The copied files often hold secrets. The task's agent can read them, as it could read them in the repo, and they are removed with the worktree when the task ends.
- Task ports are 41000 to 41999. A task keeps its port until it ends; Trackwall does not check that no other program uses it, and a service that finds its port taken says so.
- A task created with an older version of Trackwall asks you to trust its mise configuration once before its first mise task.
- A mise file or folder that is a symbolic link Trackwall cannot check (to something outside the worktree, a broken link, or a linked folder) stops mise tasks there, and the warning says why.
- Trusting a mise configuration covers the commands it defines, not the code they run: tests and build scripts the agent changed run as written. Review the changes as you would before merging.
- Copilot CLI asks to trust every new folder. To stop it asking for every task, add the `worktrees` folder (the new task form shows its full path) to `trustedFolders` in `~/.copilot/config.json`.
- Trackwall tells a task's agent to stay in its worktree, commit on its branch and not push unless your prompt asks for it. This is an instruction to the agent, not a lock: the branch is yours to push.
- "Verify" needs a mise task named `test` in the repo; without one, Trackwall says so and runs nothing. If the agent is already running `test`, "Verify" waits for that run instead of starting another. The test counts come from the JUnit reports the run wrote (Maven, Gradle, jest-junit, Vitest); a run that wrote none, for example because Gradle found the tests up to date, passes on its exit code alone, and the section says so.
- The sections above the task's terminal (included files, warnings, messages, summary, verification, mise tasks) take at most a third of the panel and scroll when they need more, so the terminal keeps room on a small screen.
- The verdict is about the changes as they were when the run started; it does not change when the agent edits files afterwards. Trackwall keeps only the last verification of each task, until it restarts.
- After running the tests in its worktree, the agent reads which tests failed and why from the reports your build tools write there, instead of scrolling the build log.
- An agent can also propose a task for you to start: see [Main session and task proposals](/features/main-session).
