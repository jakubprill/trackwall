---
title: Copilot usage
description: See which tasks, sessions and tools used the most of Copilot in a week, and compare one week with the one before.
---

# Copilot usage

See which tasks, sessions and tools used the most of Copilot in a week, and compare one week with the one before.

## What you get

- The week's total: AI credits or premium requests, and the tokens the model read and wrote.
- Every task and session of the week, the most expensive first, with what it used.
- How much of what the model read was only the descriptions of its tools, sent again with every call.
- Every tool agents called, from Trackwall, your own MCP servers and Copilot CLI itself, ranked by how many tokens its results added.
- Earlier weeks a click away, to see whether a change made agents cheaper.

## How it works

Copilot CLI writes down what every model call used and every tool call it made, in a log it keeps for each conversation on your computer. "Copilot usage" in "Settings > Agents" reads those logs for the last seven days when you open it, and adds them up.

"Tasks and sessions" lists the work the calls were for, the one that read the most tokens first. A task shows by its title, also after you ended it. A session in a repo's folder shows as "Sessions in" and the repo, the supervisor as "Supervisor", and Copilot CLI you ran in a folder outside your projects folder as one line of its own. Under each you see the tokens in, how many of them were tool descriptions, and the tokens out; on the right, what it cost, the same way a session's [usage](/features/sessions) shows.

"Tools" lists every tool called in the week, the one whose results added the most tokens first, with its MCP server in front of its name (`trackwall / search_code`, `jira / get_issue`) and the calls that failed. A built-in tool of Copilot CLI, such as `view` or `bash`, shows by its own name.

The arrows step back a week at a time, up to twelve weeks, and forward again to the last seven days.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS), choose "Agents" and scroll to "Copilot usage".
2. Read the top of "Tasks and sessions" and "Tools": that is where most of the week went.
3. Click the left arrow to see the week before, and compare.

## Good to know

- It counts every Copilot CLI conversation on this computer, also those Trackwall did not start, from Copilot CLI's own folder (`~/.copilot`, or the folder `COPILOT_HOME` names). Nothing is sent anywhere, and Trackwall keeps no copy.
- A week Copilot CLI has already cleaned up is empty: the report can only show the conversations Copilot CLI still keeps.
- Tool descriptions count in every model call, used or not, which is why a long list of tools costs even when agents call few of them.
- A failed tool call adds no tokens of its own, only the error the agent read.
- Copilot CLI that you ran by hand inside a repo's folder counts under "Sessions in" that repo, since its log does not say who started it.
