---
title: mise tasks
description: Run, stop and follow the mise tasks of any repo, with live logs and the errors picked out.
---

# mise tasks

Run, stop and follow the mise tasks of any repo, with live logs and the errors picked out.

![The mise tasks of admin-bff, with the service ready and the log of dev open](/screenshots/mise-tasks.png)

## What you get

- Every mise task of a repo in one tab, with "Run" and "Stop", and where it comes from: the repo, your local files, your global mise config or Trackwall's convention tasks.
- Convention tasks: `setup`, `build` and `test` for every Maven, Gradle and npm repo that has none of its own, with one click.
- A live log of each task, with errors and warnings highlighted, and secrets kept out of it.
- A clean stop: a stopped task takes everything it started with it.
- Arguments for a run, such as one test class for `test`, and the mise tasks agents run, in the same place, where you can watch and stop them.

## How it works

Select a repo and open its "mise tasks" tab: it lists the repo's tasks as `mise tasks ls` shows them. A label next to each name says where the task is defined: "repo" for a file in the repo's git, "local" for a file only your clone has, such as `mise.local.toml`, and "outside repo" for your global mise config or a parent folder's. Tasks from Trackwall's convention tasks file are labelled "convention". Hover the label to see the file. "Run" starts a task in the repo root and opens its log, which follows the output live, with errors and warnings highlighted. When a task fails, the tab shows its exit code and the last lines of output. "Log" next to any task shows or hides its log, also for a run an agent started.

A task that declares arguments (a `usage` in its mise config) gets a field next to "Run": type the arguments separated by spaces, for example `OrderServiceTest` for `test`. Each argument is one word of letters, digits and `_ . , / = # * @ + -`, and cannot start with `-`. Agents pass arguments the same way, so an agent fixing one test can run just that test.

"Stop" ends the task together with every process it started, on Windows and on macOS alike, so no server is left holding a port. Quitting Trackwall stops every task, and if Trackwall ever crashes, its next start cleans up what was left running.

Values of environment variables with secret-looking names (`*_TOKEN`, `*_PASSWORD`, `*_SECRET` and similar) are replaced with `***` before they reach the log.

mise asks you to trust a repo's configuration before it runs its tasks. When it has not been trusted yet, the tab offers a button for it. Only a trusted repo's tasks can also be run by agents through the [MCP server](/features/mcp); those runs show in the same tab, with their log, and you can stop them here. An agent in Trackwall that was turned away because the configuration was not trusted hears when you trust it, and runs its task again. A task's agent runs its mise tasks in the task's worktree instead, so they test its changes; those runs show in the task's panel in "Sessions" (see [Agent tasks](/features/tasks)).

### Convention tasks

Verify, the [Batch command](/features/batch-command) and agents build and test a repo with its mise tasks `setup`, `build` and `test`. When a repo has no mise tasks, its tab offers to add convention tasks. One click writes one file into your projects folder, `.config/mise/conf.d/trackwall-convention-tasks.toml`, and trusts it. mise reads that file for every repo in the folder, so each repo without its own `setup`, `build` or `test` gets:

- `setup`: `npm ci` for an npm project. Maven and Gradle download their dependencies in `build` and `test`.
- `build`: `mvn package` without tests, `gradle assemble` or `npm run build`.
- `test`: `mvn test`, `gradle test` or `npm test`. It takes one optional argument, a test filter: `OrderServiceTest` or `OrderServiceTest#creates` for Maven, `OrderServiceTest.creates` for Gradle.

Each task uses the repo's Maven or Gradle wrapper when there is one. A task fails with a message in a repo with no `pom.xml`, `build.gradle`, `build.gradle.kts` or `package.json`, so Verify never passes a repo it could not test. A repo's own task of the same name always wins, and so does a task in your projects folder's own `mise.toml`. There is no convention `dev`, because a service needs its own port.

You can edit the file. Once it differs from what Trackwall writes, Trackwall leaves it as it is.

## Use it

1. Install mise and make sure `mise` is on your `PATH`.
2. Open "Repos", select a repo and open "mise tasks".
3. If asked, trust the repo's mise configuration.
4. Press "Run" next to a task and follow its log; press "Stop" to end it.

## Good to know

- On macOS the `PATH` from your login shell is enough.
- The full log of every task is kept in `~/.trackwall/logs/mise-task/<repo>/<task>.jsonl`, at most 10 MB plus one previous file. Characters other than lowercase letters, digits, `_` and `-` in the name are written as `%XX`: the task `build:ui` is `build%3Aui.jsonl`. A run in a task's worktree is kept in `~/.trackwall/logs/task-mise-task/<task>/<mise task>.jsonl`.
- Task worktrees get the convention tasks while they sit inside the projects folder, which is where Trackwall puts them by default.
- A repo with a mise task called `dev` also gets a [Services](/features/services) panel at the top of this tab.
- Tasks only for your computer go in `mise.local.toml`, or in a `mise.toml` you keep out of git; above the tasks the tab shows their [backup](/features/local-config). The repo list marks such repos with the `local-mise` tag.
