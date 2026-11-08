---
title: Copilot usage
description: See which tasks, sessions and tools used the most of Copilot in a week, and how the use changed over the last thirteen weeks.
---

# Copilot usage

See which tasks, sessions and tools used the most of Copilot in a week, and how the use changed over the last thirteen weeks.

![The Copilot usage section in Settings: a bar for each of thirteen weeks with the tool definitions set apart, the week's totals, and the tasks and sessions ranked with a bar each.](/screenshots/copilot-usage.png)

## What you get

- The week's total: AI credits or premium requests, and the tokens the model read and wrote.
- Every task and session of the week, the most expensive first, with what it used and a bar to compare it with the others.
- How much of what the model read was only the definitions of its tools, sent again with every call.
- Every tool agents called, from Trackwall, your own MCP servers and Copilot CLI itself, ranked by how many tokens its results added.
- A bar for each of the last thirteen weeks, with the part that was tool definitions set apart, to see at a glance whether a change made agents cheaper.

## How it works

Copilot CLI writes down what every model call used and every tool call it made, in a log it keeps for each conversation on your computer. "Copilot usage" in "Settings > Usage" reads those logs for the last seven days when you open it, and adds them up. "Tokens in by week" comes first: one bar for each week, the oldest on the left, with the tokens of tool definitions at the bottom and the rest of what the model read above them. Point at a bar to see its dates and numbers, and click it to open that week below. The week's total follows as a few numbers, then the two lists, side by side when the window is wide enough, each row with a bar of how much it took compared with the first.

"Tasks and sessions" lists the work the calls were for, the one that read the most tokens first. A task shows by its title, also after you ended it. A session in a repo's folder shows as "Sessions in" and the repo, the supervisor as "Supervisor", and Copilot CLI you ran in a folder outside your projects folder as one line of its own. Under each you see the tokens in, how many of them were tool definitions, and the tokens out; on the right, what it cost, the same way a session's [usage](/features/sessions) shows.

"Tools" lists every tool called in the week, the one whose results added the most tokens first, with its MCP server in front of its name (`trackwall / search_code`, `jira / get_issue`) and the calls that failed. A built-in tool of Copilot CLI, such as `view` or `bash`, shows by its own name.

The arrows step back a week at a time, up to twelve weeks, and forward again to the last seven days, the same as clicking the bars.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS) and choose "Usage": "Copilot usage" is at the top.
2. Read the top of "Tasks and sessions" and "Tools": that is where most of the week went.
3. Look at "Tokens in by week" for a step down or up after you changed something, such as the MCP servers your sessions get, and click a bar to see what that week was spent on.

## Good to know

- It counts every Copilot CLI conversation on this computer, also those Trackwall did not start, from Copilot CLI's own folder (`~/.copilot`, or the folder `COPILOT_HOME` names). Nothing is sent anywhere, and Trackwall keeps no copy.
- A week Copilot CLI has already cleaned up is empty: the report can only show the conversations Copilot CLI still keeps.
- The bars count tokens, not AI credits: every model call reports tokens, while credits are missing with your own model provider and on plans billed by premium requests.
- Tool definitions count in every model call, used or not, which is why a long list of tools costs even when agents call few of them.
- A failed tool call adds no tokens of its own, only the error the agent read.
- Copilot CLI that you ran by hand inside a repo's folder counts under "Sessions in" that repo, since its log does not say who started it.
