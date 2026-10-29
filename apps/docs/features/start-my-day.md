---
title: Start my day
description: One button syncs every repo and starts the supervisor with a briefing of what changed since your last day and what waits for you.
---

# Start my day

One button syncs every repo and starts the supervisor with a briefing of what changed since your last day and what waits for you.

## What you get

- Every repo in your projects folder synced before you start, without opening "Repos".
- A short briefing from the supervisor: new commits on each repo's main branch since your last day start, repos the sync could not update, and tasks that wait for you or fell behind.
- At most three task proposals for the day, which wait for your approval like any other.
- Your own morning instructions added to the briefing, such as which issues or merge requests to check.

## How it works

Press "Start my day" in the supervisor panel. Trackwall syncs every repo first, as "Sync all" in "Repos" does, and the panel lists the steps with the one under way marked: sync every repo, write what changed since your last day start, start the supervisor with the briefing.

Trackwall then writes a day report. It compares each repo's main branch on the server with what it was at your last day start: how many commits came in, with the newest ones and who wrote them, whether the history was rewritten, and which repos are new. It adds the repos the sync skipped, with the reason (for example uncommitted changes on the checked-out branch), and every open task: whether its agent waits for you, when it last reported, and how many commits its repo's main branch has that the task does not. Repos with nothing new are only counted, so the report stays short with many repos.

A new supervisor starts with one message already sent: read the day report and brief me. It reads the report in one step, instead of opening every repo, and answers in its panel. If your Copilot CLI has tools for your repo host or issue tracker, the supervisor uses them too: it knows which project on the host each repo is, and which branch belongs to which task. It proposes at most three tasks and lists anything else with a number, so you can ask for the ones you want.

The report stays until the next day start. Ask the supervisor about it again later in the day, and it gets the same report.

## Use it

1. Set your projects folder in "Settings", if you have not yet.
2. If a supervisor is running, press "Stop" in its panel: a new day starts with a new supervisor.
3. Press "Start my day" in the supervisor panel.
4. Read the briefing, and start or reject its proposals in "Sessions" or from "Delegated" in the panel.

## Good to know

- To add your own instructions, write them under `dayStart` in `~/.trackwall/workspace.yaml` (you edit this file by hand), for example:

  ```yaml
  dayStart:
    prompt: Check my open issues and the merge requests waiting for my review.
  ```

  They are added after Trackwall's own message every day.
- "Start my day" does not stop a running supervisor for you. Stop it first, so no conversation ends without you.
- The first day start has nothing to compare with, so its briefing lists only what the sync could not update and your open tasks. From the second one on, it shows what came in since.
- The briefing is as fresh as the sync: a repo the sync could not reach still shows what it knew before.
- It needs Copilot CLI, like the [supervisor](/features/supervisor). If the supervisor cannot start, the day report is still written, and the panel says why the start stopped.
- Agents outside Trackwall can read the same report with the `get_day_report` tool of the [MCP server](/features/mcp).
