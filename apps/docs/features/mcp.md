---
title: MCP server
description: "Give Copilot CLI and other agents your whole projects folder: repos, code search, graph, logs and services."
---

# MCP server

Give Copilot CLI and other agents your whole projects folder: repos, code search, graph, logs and services.

## What you get

- Agents that can list your repos, read their cards and search code in all of them at once.
- Answers to "who calls this?" and "where is this endpoint?" from the [connection graph](/features/graph).
- Logs and errors of running mise tasks and services with stack traces, and which tests failed and why, for the agent to read.
- mise tasks and [services](/features/services) the agent can start, wait for and stop.
- Sessions that see each other and hand work over as [task proposals](/features/main-session).

## How it works

Trackwall runs an MCP server that every session in "Sessions" is connected to. Copilot CLI in your own terminal, or another MCP client, can connect to it too: [Connect Copilot CLI](/guide/connect-copilot-cli) shows how.

The agent sees the same projects folder you see in Trackwall, through the tools below. It can read everything, and it can run mise tasks and services, but never in a repo whose mise configuration you have not trusted. No tool changes Trackwall's settings, answers an approval or stops a session: those stay with you. A new task starts only when you approve its proposal; after that, the session that proposed it can send its agent messages and resume it.

## Use it

1. Connect Copilot CLI once, with the command from "Settings > Agents".
2. Ask the agent things like "which repos call orders-api?" or "start the shop with its dependencies and call /api/orders".

## Tools

| Tool | What the agent gets |
|---|---|
| `list_repos` | The repos of the projects folder with branch, status, last sync and tags; filter by tags. |
| `get_repo` | One repo's README, latest commits, mise tasks and tags. |
| `get_repo_card` | The [repo card](/features/repo-card), with evidence. |
| `search_code` | Text or a regular expression in all repos at once, narrowed by repo, tag or path, with line and context. |
| `who_calls` | Who uses a repo, through packages and HTTP, with evidence. |
| `subgraph_for` | The part of the connection graph around a repo, with its calls that lead to no repo. |
| `find_endpoint` | An HTTP endpoint from code or an OpenAPI spec, by path, URL or words, with its types, the repos and endpoints that call it, and the endpoints it calls. |
| `run_mise_task`, `wait_for_mise_task`, `stop_mise_task`, `list_running_mise_tasks` | Run a repo's mise task, wait up to 55 s for it, stop it, list what runs. With `task`, in that task's worktree. |
| `tail` | A mise task's log from a cursor, with secrets replaced by `***`; with `task`, the run in that task's worktree. `contains` keeps only lines with that text and `minLevel` only lines at that level or above. |
| `get_errors` | Errors from the mise task logs, newest first: error lines, compiler errors, exceptions with stack traces, Spring and Gradle failure reports; repeats counted once. With `minLevel: warn`, warnings too. `contains` keeps only errors with a line holding that text, such as an exception class or an endpoint path. |
| `get_test_results` | The results of the latest test run from the JUnit reports Maven, Gradle, jest or Vitest left in the repo, or with `task` in that task's worktree: totals, each report with its time, and the failed tests with their message and stack trace. |
| `verify_task` | Verify a task: run the repo's mise task `test` in the task's worktree and return one verdict (passed, failed or cancelled) with the test counts and the first failed tests and log errors, the same as the "Verify" button. Waits up to 55 s; called again, it keeps waiting for the same run. A task session verifies only its own task. |
| `start_service`, `stop_service`, `list_services`, `call_endpoint` | Start a service with its dependencies, stop it, list services, send an HTTP request to a running one; from a repo or from a task's worktree on the task's port, or on the repo's port in place of the repo's own service. |
| `list_sessions`, `get_session`, `get_task_changes` | The sessions and tasks in "Sessions", with state, repo, a task's changed files and their diff, and its last verification. |
| `propose_task`, `wait_for_session`, `report_result` | Propose a task (for an item of your [plan](/features/plan) when given one), wait up to 55 s for a session or task to need someone, report a task's summary. |
| `list_items`, `get_item`, `create_item`, `update_item` | Your [plan](/features/plan): list the inbox or a project's items, read one item with where it sits, its children and its tasks, write an idea or a smaller piece of work (from a task, under its task's item), and change an item's text, repos, link or move it between "Idea" and "Ready". Projects are yours alone. |
| `propose_folder_action` | Propose removing a repo from the projects folder; nothing happens until you approve it, see the [supervisor](/features/supervisor). |
| `get_review_comments` | The comments you sent on lines of a task's changes, for that task's agent; see [Agent tasks](/features/tasks). |
| `send_message`, `get_messages` | A message from the session that proposed a task to that task's agent, and the agent reading it; see [Main session and task proposals](/features/main-session). |
| `get_handoff` | For a task another task handed its work: where that task's branch is now and which files its new commits change since the agent last looked; see [Main session and task proposals](/features/main-session). |
| `resume_task` | Continue a task whose session no longer runs, in its own worktree and conversation, the same as "Resume". The supervisor resumes any task, another session only the tasks it proposed. |
| `get_day_report` | The report of your last [day start](/features/start-my-day): new commits on each repo's main branch since the one before, repos the sync could not update, and open tasks with how far behind they are. |
| `get_updates` | What happened to the tasks a session proposed since it last asked: a finished turn, a reported result, a verification verdict, an error or end, a rejected proposal. |

## Good to know

- An agent in a session runs and stops only the mise tasks and the service of its own repo; every run is logged with the repo, mise task and session.
- A task's agent runs mise tasks and the service in the repo root or in its own task's worktree, never in another task's, and in its worktree only with the mise configuration you have trusted (see [Agent tasks](/features/tasks)).
- Agents get links in the form `trackwall://…` to point you at a repo, session or task: see [trackwall:// links](/features/links).
- Calls that wait (`wait_for_mise_task`, `start_service`, `wait_for_session`) return after at most 55 seconds; the agent calls again to keep waiting.
