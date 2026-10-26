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
- For every connection, how sure Trackwall is and the file and line that prove it.
- A place to add the connections Trackwall cannot see.

## How it works

Open "Overview" and Trackwall draws your repos as a graph, built from their [repo cards](/features/repo-card). A line goes from a repo that uses a package to the repo that builds it (Maven, Gradle or npm), and from a repo whose HTTP client calls another repo's app or endpoints, matched by app name, host, `localhost` port or path.

Every connection has a confidence: certain, almost certain, likely or possible. Click a repo and the panel on the right lists what it uses and who uses it, each with its evidence.

Some connections do not show in the code, for example an address that only exists in your deployment. Add those by hand in `~/.trackwall/workspace.yaml`, and they appear in the graph like the others.

## Use it

1. Open "Overview" (Ctrl+4, ⌘4 on macOS).
2. Click a repo to see what it uses and who uses it.
3. Add a missing connection under `graph` in `~/.trackwall/workspace.yaml` (below).

## Good to know

- Under `graph`, `packages` assigns a package to a repo (`com.example:orders-client: orders-api`), `apps` assigns an app name or a host (`orders.internal.example.com: orders-api`), and `edges` adds a connection with a note (`- { from: shop-web, to: orders-bff, note: HTTP /api/orders }`). A repo is named by its identifier or its `host/path` address.
- Agents read the same graph through the [MCP server](/features/mcp) (`who_calls`, `subgraph_for`, `find_endpoint`).
- `find_endpoint` takes a path the way you have it: with or without the app's context path or a gateway prefix, a whole URL, `GET /api/orders/42`, or a few words such as "cancel order", which it looks for in paths, handler names and OpenAPI summaries. The closest matches come first, and each result says whether it matched the whole path, its end or the words.
- For Java repos, `find_endpoint` also tells which endpoint makes a call, not only which repo: Trackwall follows the calls from each endpoint's code to the HTTP clients it uses. So an agent can ask what a change to one endpoint affects and follow it from endpoint to endpoint. Calls made by scheduled jobs or event listeners belong to no endpoint, and repos with Kotlin code are not followed yet.
- A commit, checkout or pull in any repo, or a repo added to the projects folder, redraws the graph within a couple of seconds. A hand edit of `workspace.yaml` shows up within five minutes, or at once with the refresh button.
- The first graph after a start waits for the cards of every repo; while they are computed, the view says how many are done.
