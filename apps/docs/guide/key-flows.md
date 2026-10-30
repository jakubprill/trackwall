---
title: Key flows
description: What happens, step by step, when you open a session, answer an approval, run an agent task, let the supervisor delegate, start your day or start a service.
---

# Key flows

What happens, step by step, when you open a session, answer an approval, run an agent task, let the supervisor delegate, start your day or start a service.

Each flow below is a diagram with a few sentences around it. "Daemon" is Trackwall's background process, which does the work; [How Trackwall works](/guide/how-it-works) introduces it and the other parts.

## Opening a session

```mermaid
sequenceDiagram
  actor You
  participant D as Daemon
  participant C as Copilot CLI
  You->>D: "+" in Sessions:<br/>a repo and a prompt
  Note over D: instructions, hooks,<br/>MCP with the session's token,<br/>environment from mise
  D->>C: starts copilot in a terminal<br/>in the repo's folder
  C->>D: connects to the MCP server
  C->>D: hook: ready for input
  D-->>You: "waiting for you",<br/>a notification
  You->>C: your message in its terminal
  C->>D: hooks: working, tools,<br/>turn ended
  D-->>You: "waiting for you" again
```

The daemon starts Copilot CLI itself, so every session is connected to Trackwall from its first second: it can use the [MCP tools](/features/mcp), it gets [short instructions](/features/session-instructions) on how to work with you, and its state reaches the list without you watching its terminal. The terminal belongs to the daemon, so closing the window does not end the session. See [Copilot CLI sessions](/features/sessions).

## Answering an approval outside the terminal

```mermaid
sequenceDiagram
  participant C as Copilot CLI
  participant D as Daemon
  actor You
  Note over C: wants to run "mvn test"
  C->>C: shows its approval question
  D->>C: reads the question on the screen
  D-->>You: the command and the answers,<br/>in the tray panel and on Home
  You->>D: "Yes"
  D->>C: the question is still there:<br/>presses its key
  Note over C: runs the command, goes on
```

The click does exactly what the key in the terminal does, and only while the question you saw is still there. Commands you always allow or always refuse go into `toolPermissions` once and are never asked about. See [Approvals outside the terminal](/features/approvals).

## An agent task, from prompt to merge request

```mermaid
flowchart TB
  start(["You: a prompt, 'Own worktree' on"]) --> wt["Daemon: new branch trackwall/task-name<br/>from the default branch, in its own worktree;<br/>copies the files .worktreeinclude lists;<br/>gives the task its own port"]
  wt --> work["Copilot CLI works in the worktree:<br/>edits, builds and tests with the repo's mise tasks"]
  work --> verify["Verification: the mise task 'test'<br/>passed or failed, with the failed tests"]
  verify --> summary["The agent reports a summary"]
  summary --> review{"You review 'Changes'"}
  review -- "comments on lines" --> work
  review -- "good" --> push["Push: the task's branch to the remote"]
  push --> mr["Open merge request:<br/>your repo host's form, filled in"]
  mr --> done(["End task: the worktree goes,<br/>the branch stays if you want"])
```

Your own working copy is never touched: the agent has its own folder on its own branch, and it runs services on its own port, so you can keep working next to it. The agent is told not to push: you push its branch with "Push". See [Agent tasks](/features/tasks) and [Where agents work](/guide/where-agents-work).

## The supervisor hands work to other agents

```mermaid
sequenceDiagram
  actor You
  participant S as Supervisor
  participant D as Daemon
  participant T as Task agents
  You->>S: "Let customers retry<br/>a failed payment"
  S->>D: who_calls, search_code,<br/>get_repo_card
  D-->>S: the repos involved<br/>and how they connect
  S->>D: propose_task: payments,<br/>notifications, admin-web
  D-->>You: three proposals to read,<br/>edit, start or reject
  You->>D: Start task, on each one
  D->>T: a task each, in its own worktree
  T->>D: report_result,<br/>verification verdict
  D->>S: "read your updates"
  S->>D: get_updates, get_task_changes
  S->>D: send_message:<br/>"the field is retryCount"
  D->>T: "read your messages"
  S-->>You: what is done,<br/>what waits for you
```

The supervisor runs in your projects folder, sees every repo, and does not change code itself. It plans and proposes, and you decide what starts. While the tasks run it is woken when one of them moves, so it can check the work and steer it. After five messages to a task without you, it has to ask you first. See [Supervisor](/features/supervisor) and [Main session and task proposals](/features/main-session).

## Start my day

```mermaid
sequenceDiagram
  actor You
  participant D as Daemon
  participant S as Supervisor
  You->>D: Start my day
  D->>D: sync every repo
  D->>D: the day report: new commits,<br/>repos not updated, open tasks
  D->>S: a new supervisor, asked for a briefing
  S->>D: get_day_report
  S-->>You: what changed, what waits,<br/>up to three proposed tasks
```

See [Start my day](/features/start-my-day) and [Repos](/features/repos) for how syncing keeps your work safe.

## Starting a service with its dependencies

```mermaid
sequenceDiagram
  actor You
  participant D as Daemon
  participant P as payments (dev)
  participant O as orders-api (dev)
  participant A as An agent
  You->>D: Start with dependencies: orders-api
  D->>D: the graph: orders-api<br/>calls payments
  D->>P: mise run dev, as one process group
  P-->>D: "started on port 8082",<br/>the port answers
  Note over D: payments is ready, next wave
  D->>O: mise run dev
  O-->>D: the port answers
  D-->>You: both ready, with their ports
  A->>D: call_endpoint POST /orders
  D->>O: the request
  O->>P: its own call
  D-->>A: the answer, and the errors<br/>the services logged meanwhile
```

Each service starts only after the services it calls are up, a dependency that cannot start is skipped with the reason, and "Stop with dependencies" stops only what this start brought up. An agent does the same with `start_service` and `call_endpoint`. See [Services](/features/services).

## Read on

- [Security model](/guide/security-model): what an agent can and cannot do in these flows.
- [All features](/features/): every feature on its own page.
