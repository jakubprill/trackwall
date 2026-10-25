---
title: MCP server
description: "Give Copilot CLI and other agents your whole projects folder: repos, code search, graph, logs and services."
---

# MCP server

Give Copilot CLI and other agents your whole projects folder: repos, code search, graph, logs and services.

## What you get

- Agents that can list your repos, read their cards and search code in all of them at once.
- Answers to "who calls this?" and "where is this endpoint?" from the [connection graph](/features/graph).
- Logs and errors of running mise tasks and services, with stack traces, for the agent to read.
- mise tasks and [services](/features/services) the agent can start, wait for and stop.
- Sessions that see each other and hand work over as [task proposals](/features/main-session).

## How it works

Trackwall runs an MCP server that every session in "Sessions" is connected to. Copilot CLI in your own terminal, or another MCP client, can connect to it too: [Connect Copilot CLI](/guide/connect-copilot-cli) shows how.

The agent sees the same projects folder you see in Trackwall, through the tools below. It can read everything, and it can run mise tasks and services, but never in a repo whose mise configuration you have not trusted. No tool changes Trackwall's settings, and no tool starts, answers or stops a session: those stay with you.

## Use it

1. Connect Copilot CLI once, with the command from the "Daemon" view.
2. Ask the agent things like "which repos call orders-api?" or "start the shop with its dependencies and call /api/orders".

## Tools

| Tool | What the agent gets |
|---|---|
| `list_repos` | The repos of the projects folder with branch, status, last sync and tags; filter by tags. |
| `get_repo` | One repo's README, latest commits, mise tasks and tags. |
| `get_repo_card` | The [repo card](/features/repo-card), with evidence. |
| `search_code` | Text or a regular expression in all repos at once, narrowed by repo, tag or path, with line and context. |
| `who_calls` | Who uses a repo, through packages and HTTP, with evidence. |
| `subgraph_for` | The part of the connection graph around a repo. |
| `find_endpoint` | An HTTP endpoint by path or name, with its types and the repos that call it. |
| `run_mise_task`, `wait_for_mise_task`, `stop_mise_task`, `list_running_mise_tasks` | Run a repo's mise task, wait up to 55 s for it, stop it, list what runs. With `task`, in that task's worktree. |
| `tail` | A mise task's log from a cursor, with secrets replaced by `***`; with `task`, the run in that task's worktree. |
| `get_errors` | Errors from the mise task logs, newest first: error lines, compiler errors, exceptions with stack traces, Spring and Gradle failure reports; repeats counted once. With `minLevel: warn`, warnings too. |
| `start_service`, `stop_service`, `list_services`, `call_endpoint` | Start a service with its dependencies, stop it, list services, send an HTTP request to a running one. |
| `list_sessions`, `get_session`, `get_task_changes` | The sessions and tasks in "Sessions", with state, repo, a task's changed files and their diff. |
| `propose_task`, `wait_for_session`, `report_result` | Propose a task, wait up to 55 s for a session or task to need someone, report a task's summary. |

## Good to know

- An agent in a session runs and stops only the mise tasks and the service of its own repo; every run is logged with the repo, mise task and session.
- A task's agent runs mise tasks in the repo root or in its own task's worktree, never in another task's, and in its worktree only with the mise configuration you have trusted (see [Agent tasks](/features/tasks)).
- Agents get links in the form `trackwall://…` to point you at a repo, session or task: see [trackwall:// links](/features/links).
- Calls that wait (`wait_for_mise_task`, `start_service`, `wait_for_session`) return after at most 55 seconds; the agent calls again to keep waiting.
