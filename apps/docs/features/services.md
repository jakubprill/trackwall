# Services

Start a service together with the services it calls, and call its endpoints.

A repo with the mise task `dev` has a "Service" panel at the top of the "mise tasks" tab. "Start with dependencies" runs `dev` in the repo and, first, in every repo it calls according to the connection graph (HTTP clients and manual connections from `workspace.yaml`, not packages), up to 12 repos; a repo starts once the repos it calls are up. A service is "ready on port N" once its port accepts a connection: the port it logs (`Tomcat started on port 8081`, `Local: http://localhost:5173`) or `server.port` from its card.

It is "not answering" when the port does not open within 5 minutes or stops answering, and "crashed" when the process ends by itself. A dependency without `dev`, with an untrusted mise config, or whose port is already taken (by another service or by a program Trackwall did not start; the reason says which) is skipped with the reason, the repo itself too. A stop during a start cancels it: nothing starts after the stop. "Stop with dependencies" stops the service and the dependencies this start started (not the ones that were already running).

The same over MCP: `start_service` (waits up to 55 s and says what is ready, what crashed and with which errors from its log; call it again to keep waiting), `stop_service`, `list_services` and `call_endpoint`, which sends an HTTP request (method, path, headers, body) to a ready service on this computer and returns the status and body (up to 32 KB, secrets from the environment replaced with `***`) together with the errors that the services logged during the call, e.g. the stack trace from the service behind the one called.

A session from "Sessions" starts and stops only its own repo's service, but may call any running service, e.g. the ones behind its own. A `dev` started with the "Run" button is shown in the panel as the service too. The service runs from the repo root, not from a task worktree.

## Decisions

Why it works this way: ADR-45 in [§12 of the architecture document](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief).
