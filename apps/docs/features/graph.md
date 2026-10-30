---
title: Connection graph
description: See which repo uses which, through shared packages and HTTP calls, with the line that proves it.
---

# Connection graph

See which repo uses which, through shared packages and HTTP calls, with the line that proves it.

![The connection graph of twenty repos: who calls whom over HTTP and who uses the shared libraries](/screenshots/overview.png)

## What you get

- A map of your projects folder: which repo uses another repo's package and which one calls another repo's endpoints.
- Frontends on the left, gateways and backends in the middle, libraries on the right.
- For every connection, whether one repo calls the other or depends on it to build, how sure Trackwall is, and the file and line that prove it.
- The HTTP calls that lead nowhere Trackwall knows, so you can tell an external service from a missing link.
- A place to add the connections Trackwall cannot see.

## How it works

Open "Overview" and Trackwall draws your repos as a graph, built from their [repo cards](/features/repo-card). A line goes from a repo that uses a package to the repo that builds it (Maven, Gradle or npm), and from a repo whose HTTP client calls another repo's app or endpoints, matched by app name, host, `localhost` port or path.

Every connection says what it is, "calls" (at runtime, over HTTP) or "depends on" (to build, through a package), and has a confidence: certain, almost certain, likely or possible. Click a repo and the panel on the right lists what it uses and who uses it, each with its evidence.

When a repo's HTTP client calls an app that no repo in your projects folder is, the panel lists it under "Calls without a target", with the file and line of the client and what Trackwall looked for. That is either a service outside your folder, or one of your repos under another name, which an `apps` entry in `workspace.yaml` connects.

Some connections do not show in the code, for example an address that only exists in your deployment. Add those by hand in `~/.trackwall/workspace.yaml`, and they appear in the graph like the others.

## Use it

1. Open "Overview" (Ctrl+4, ⌘4 on macOS).
2. Click a repo to see what it uses and who uses it.
3. Add a missing connection under `graph` in `~/.trackwall/workspace.yaml` (below).

## Good to know

- Under `graph`, `packages` assigns a package to a repo (`com.example:orders-client: orders-api`), `apps` assigns an app name or a host (`orders.internal.example.com: orders-api`), and `edges` adds a connection with a note (`- { from: shop-web, to: orders-bff, note: HTTP /api/orders }`). A connection you add is "calls" unless you add `kind: depends-on`; only "calls" connections are started with a service when you start it with its dependencies. A repo is named by its identifier or its `host/path` address.
- Agents read the same graph through the [MCP server](/features/mcp) (`who_calls`, `subgraph_for`, `find_endpoint`); `subgraph_for` also gives the calls without a target of the repos in it.
- A frontend that generates its API client from a backend's OpenAPI spec is connected through that spec: commit the spec in the frontend repo, under any name, and Trackwall finds the repo that serves its operations, by `operationId` or by path, even when a tool such as Redocly CLI added a prefix to the paths or the servers point to a gateway. If your `package.json` script downloads the spec for `openapi-typescript` from a running service instead (`openapi-typescript http://localhost:8090/v3/api-docs`), Trackwall connects the frontend to the app on that host or port. The same goes for a Java service whose build generates a client from another service's spec. When no repo serves them, the spec shows under "Calls without a target".
- `find_endpoint` takes a path the way you have it: with or without the app's context path or a gateway prefix, a whole URL, `GET /api/orders/42`, or a few words such as "cancel order", which it looks for in paths, handler names and OpenAPI summaries. The closest matches come first, and each result says whether it matched the whole path, its end or the words.
- For Java repos, `find_endpoint` also tells which endpoint makes a call, not only which repo: Trackwall follows the calls from each endpoint's code to the HTTP clients it uses. So an agent can ask what a change to one endpoint affects and follow it from endpoint to endpoint. Calls made by scheduled jobs or event listeners belong to no endpoint, and repos with Kotlin code are not followed yet.
- "Impact of" at the top lights the repos a task's change reaches, ring by ring: see [Impact of a task](/features/impact).
- A commit, checkout or pull in any repo, or a repo added to the projects folder, redraws the graph within a couple of seconds. A hand edit of `workspace.yaml` shows up within five minutes, or at once with the refresh button.
- The first graph after a start waits for the cards of every repo; while they are computed, the view says how many are done.
