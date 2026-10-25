---
title: mise tasks
description: Run, stop and follow the mise tasks of any repo, with live logs and the errors picked out.
---

# mise tasks

Run, stop and follow the mise tasks of any repo, with live logs and the errors picked out.

## What you get

- Every mise task of a repo in one tab, with "Run" and "Stop".
- A live log of each task, with errors and warnings highlighted.
- A clean stop: a stopped task takes everything it started with it.
- Secrets kept out of the log.
- The tasks agents run, in the same place, where you can watch and stop them.

## How it works

Select a repo and open its "mise tasks" tab: it lists the repo's tasks as `mise tasks ls` shows them. "Run" starts a task in the repo root and opens its log, which follows the output live, with errors and warnings highlighted. When a task fails, the tab shows its exit code and the last lines of output.

"Stop" ends the task together with every process it started, on Windows and on macOS alike, so no server is left holding a port. Quitting Trackwall stops every task, and if Trackwall ever crashes, its next start cleans up what was left running.

Values of environment variables with secret-looking names (`*_TOKEN`, `*_PASSWORD`, `*_SECRET` and similar) are replaced with `***` before they reach the log.

mise asks you to trust a repo's configuration before it runs its tasks. When it has not been trusted yet, the tab offers a button for it. Only a trusted repo's tasks can also be run by agents through the [MCP server](/features/mcp); those runs show in the same tab, with their log, and you can stop them here.

## Use it

1. Install mise and make sure `mise` is on your `PATH`.
2. Open "Repos", select a repo and open "mise tasks".
3. If asked, trust the repo's mise configuration.
4. Press "Run" next to a task and follow its log; press "Stop" to end it.

## Good to know

- On macOS the `PATH` from your login shell is enough.
- The full log of every task is kept in `~/.trackwall/logs/mise-task/<repo>/<task>.jsonl`, at most 10 MB plus one previous file. Characters other than lowercase letters, digits, `_` and `-` in the name are written as `%XX`: the task `build:ui` is `build%3Aui.jsonl`.
- A repo with a mise task called `dev` also gets a [Services](/features/services) panel at the top of this tab.
