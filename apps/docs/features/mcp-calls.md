---
title: MCP calls
description: See every call an agent made to Trackwall's tools, which agent made it, what it named and how it ended, for all agents or for one task.
---

# MCP calls

See every call an agent made to Trackwall's tools, which agent made it, what it named and how it ended, for all agents or for one task.

## What you get

- One list of what agents asked Trackwall for and did through it: read a repo, ran a mise task, started a service, proposed a task.
- For each call, the agent that made it: the supervisor, a task in a repo, a session, or an agent outside Trackwall.
- The repo, task and mise task the call named, and the error the agent got when it failed.
- The calls that write or run something, and the failed ones, a click away from the rest.
- A task's own calls in its panel, next to its changes.

## How it works

Every call an agent makes to Trackwall's [MCP server](/features/mcp) is noted when it ends: the tool, when it came and how long it took, who called, and how it ended. A call that runs or stops code, such as `run_mise_task`, `start_service` or `call_endpoint`, is marked "runs or stops code"; one that only writes text, such as a task proposal or a message, "writes".

Only names are kept from what the agent sent: the repo, the task, the session, the mise task, a board item, a method. Free text is never kept: not a task's prompt, a message, a search pattern, the path, headers or body of an endpoint call. So the list says that the agent sent a `POST` to `shop`, never to which path or with what.

"MCP calls" in "Settings > Agents" shows the calls of every agent, newest first, as they come. The "MCP calls" tab in a task's panel shows only the calls of that task's sessions, also those of a session that has ended, and reads them again every few seconds. "Changes" leaves out the calls that only read, and "Errors" shows only the failed ones.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS), choose "Agents" and scroll to "MCP calls".
2. Click "Changes" to see only what agents ran, stopped or wrote.
3. To see what one task's agent did, open the task in "Sessions" and choose its "MCP calls" tab.

## Good to know

- The list keeps the last 500 calls, also after a restart. They are `logs/mcp-calls.jsonl` in Trackwall's state folder (`~/.trackwall`, on Windows `%USERPROFILE%\.trackwall`), one line per call; nothing is sent anywhere.
- A call whose arguments the tool refuses before it starts (a missing or misspelt one) is not in the list: nothing ran, and the agent got the error.
- Agents cannot read the list. It is for you, not for one agent to see what another did.
- The list shows who called as the daemon knows it. A program on your computer that reaches the daemon with its token shows as "Agent outside Trackwall"; see [Security model](/guide/security-model).
