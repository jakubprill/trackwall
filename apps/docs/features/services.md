---
title: Services
description: Start a service together with the services it calls, see when it is ready, and call its endpoints.
---

# Services

Start a service together with the services it calls, see when it is ready, and call its endpoints.

![The mise tasks of admin-bff: its service ready on port 8095 and the log of the service open](/screenshots/mise-tasks.png)

## What you get

- One button that starts a service and, first, every service it calls.
- A clear state for each service: starting, ready on its port, not answering or crashed.
- One button that stops the service and what that start brought up.
- The same for agents: they can start a service, call its endpoints and read the errors the services logged during the call.
- An agent task can run its own copy of a service from its worktree, on its own port, next to yours.

## How it works

A repo with a mise task called `dev` has a "Service" panel at the top of its [mise tasks](/features/mise-tasks) tab. "Start with dependencies" looks at the [connection graph](/features/graph), finds the repos this service calls over HTTP and runs `dev` in each of them, starting a repo only once the repos it calls are up.

A service is "ready on port N" as soon as its port accepts connections. Trackwall takes the port from the service's log (`Tomcat started on port 8081`, `Local: http://localhost:5173`) or from `server.port` on its [repo card](/features/repo-card). A service is "not answering" when its port does not open within five minutes or stops answering, and "crashed" when its process ends by itself.

A dependency that cannot start is skipped, and the panel says why: it has no `dev` mise task, its mise configuration is not trusted, or its port is already taken by another service or by a program Trackwall did not start.

"Stop with dependencies" stops the service and the dependencies this start brought up, and leaves alone the ones that were already running. Pressing it while the start is still going cancels the start.

Agents do the same through the [MCP server](/features/mcp): `start_service` starts a service and reports what is ready and what crashed, with the errors from its log; `call_endpoint` sends an HTTP request to a ready service and returns the answer together with the errors any service logged meanwhile, such as the stack trace from the service behind the one called.

An agent working on a [task](/features/tasks) can start the service from the task's worktree instead, so it runs the code the agent changed. That copy listens on the task's own port, so it runs next to the service started from the repo, and the services it calls start from their repos as usual. The services that call this one keep calling the copy started from the repo; the agent calls its own copy directly with `call_endpoint`. A task's service shows in the task panel as its running `dev` mise task.

## Use it

1. Give the repo a mise task called `dev` that starts the service.
2. Open "Repos", select the repo and open "mise tasks".
3. Press "Start with dependencies" and wait for "ready on port N".
4. Press "Stop with dependencies" when you are done.

## Good to know

- One start takes at most 12 repos, this one included; a larger set is refused, and the panel says so.
- Dependencies come from HTTP calls in the graph, including connections you added by hand, not from shared packages.
- A `dev` mise task started with its own "Run" button also shows in the panel as the service.
- The "Service" panel shows the service started from the repo; a service started from a task's worktree shows only in that task.
- A service from a task's worktree gets the task's port in `SERVER_PORT` and `PORT`. Spring Boot and most Node servers listen on it without changes; a service that sets its port elsewhere, also in the repo's mise configuration, takes that port instead and cannot run next to the one from the repo.
- An agent in a session starts and stops only the service of its own repo, and a task's agent only the one of its own worktree, but either may call any running service.
- `call_endpoint` works only on this computer, returns at most 32 KB of the body and replaces secrets from the environment with `***`.
