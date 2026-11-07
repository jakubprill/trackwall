---
title: Connection graph
description: See which repo uses which, through shared packages and HTTP calls, with the line that proves it.
---

# Connection graph

See which repo uses which, through shared packages and HTTP calls, with the line that proves it.

![The connection graph of twenty repos: who calls whom over HTTP and who uses the shared libraries](/screenshots/overview.png)

## What you get

- A map of your projects folder, frontends on the left and libraries on the right, each with its running service: which repo uses another repo's package and which one calls another repo's endpoints.
- For every connection, whether one repo calls the other or depends on it to build, how sure Trackwall is, and the file and line that prove it.
- The HTTP calls that lead nowhere Trackwall knows, so you can tell an external service from a missing link, and a place to add the connections Trackwall cannot see.
- How many of your repos agents can build, test and run, and what stands in their way in the others, with one fix for each gap.
- The versions your repos disagree on: Java, Node.js and the other tools in their mise config, Spring Boot, parent poms and BOMs, and build plugins, with a way to bring the older repos up to the newest one.

## How it works

Open "Overview" and Trackwall draws your repos as a graph, built from their [repo cards](/features/repo-card). A line goes from a repo that uses a package to the repo that builds it (Maven, Gradle or npm), and from a repo whose HTTP client calls another repo's app or endpoints, matched by app name, host, `localhost` port or path.

Every connection says what it is, "calls" (at runtime, over HTTP) or "depends on" (to build, through a package), and has a confidence: certain, almost certain, likely or possible. Click a repo and the panel on the right lists what it uses and who uses it, each with its evidence.

A repo whose [service](/features/services) runs shows it on its box: a green dot and the port, such as `:8081`, once it is ready, otherwise its state, such as "starting" or "crashed". Point at it for the whole state; the panel shows it too. While an agent task runs its copy of the service on the repo's port, the box shows that copy, since it is the one the other services reach.

When a repo's HTTP client calls an app that no repo in your projects folder is, the panel lists it under "Calls without a target", with the file and line of the client and what Trackwall looked for. That is either a service outside your folder, or one of your repos under another name, which an `apps` entry in `workspace.yaml` connects.

With no repo selected, the panel starts with "Agent readiness": how many of your repos are ready for agents, such as "4 of 6 ready", and a bar of the repos ready, with gaps and blocked. Below it, each gap is listed once, with the repos it is in:

| Gap | What it costs an agent |
| --- | --- |
| No build or test task: no mise task `build` or `test`, or only the [convention tasks](/features/mise-tasks#convention-tasks) in a repo without a `pom.xml`, `build.gradle` or `package.json` in its root | Blocks: it cannot build or test the repo, and Verify cannot judge a task there |
| mise config not trusted, mise cannot list the tasks, or mise is not installed | Blocks: it cannot run any mise task |
| Problems in the mise config: what `mise tasks validate` finds, such as a dependency on a task that does not exist, and fields mise does not know, such as `taskz` or `rn` | Weakens: a broken task fails when an agent runs it, and a mistyped field is ignored |
| A Spring Boot app without a `dev` task | Weakens: the app cannot start as a [service](/features/services) |
| A tool version only in `pom.xml`, `.nvmrc` and the like, not in the mise config | Weakens: the build uses whatever version the computer has |
| HTTP calls without a target | Weakens: the graph cannot tell an external service from a missing link |
| A mise config that `mise fmt` would rewrite | Good to know, not counted |
| An incomplete card, or no card yet | Good to know, not counted |

A repo is ready when nothing blocks or weakens agents in it. Each gap has one fix: "Add convention tasks" gives `setup`, `build` and `test` to every Maven, Gradle and npm repo at once, "Format" runs `mise fmt` in each repo with an unformatted config, which leaves the change in the repo for you to commit, and "Ask an agent…" opens a prompt you can edit, then starts a task in one repo or a [change](/features/changes) in several, each told what its repo lacks. A repo's name opens it: in "Repos" for a mise config to trust, which its mise tasks tab shows before you trust it, and on the graph for calls without a target. Nothing changes until you press a button. "Check again" asks mise about every repo again, for a change you made outside Trackwall, such as a new `mise.local.toml`.

Below that, the panel lists the versions your repos disagree on under "Version drift": for example Java 17 in two repos and 21 in the rest, or three versions of the Spring Boot parent. Each repo shows its version, and the ones behind the newest are marked. A selected repo shows the same for itself, with the file and line of each version. "Align to 21" opens a short form with the repos behind and a prompt you can edit; Start runs a task in one repo, or a [change](/features/changes) with one task per repo, each told which lines hold its old version. Nothing starts until you press Start.

Some connections do not show in the code, for example an address that only exists in your deployment. Add those by hand in `~/.trackwall/workspace.yaml`, and they appear in the graph like the others.

## Use it

1. Open "Overview" (Ctrl+4, ⌘4 on macOS).
2. Click a repo to see what it uses and who uses it.
3. To make your repos ready for agents, close the repo panel and work through "Agent readiness" from the top: the gaps that block agents come first.
4. To align versions, close the repo panel, find the subject under "Version drift" and choose "Align to …", check the repos and the prompt, and press Start.
5. Add a missing connection under `graph` in `~/.trackwall/workspace.yaml` (below).

## Good to know

- Under `graph`, `packages` assigns a package to a repo (`com.example:orders-client: orders-api`), `apps` assigns an app name or a host (`orders.internal.example.com: orders-api`), and `edges` adds a connection with a note (`- { from: shop-web, to: orders-bff, note: HTTP /api/orders }`). A connection you add is "calls" unless you add `kind: depends-on`; only "calls" connections are started with a service when you start it with its dependencies. A repo is named by its identifier or its `host/path` address.
- Agent readiness asks mise about each repo (`mise tasks ls`, `mise fmt --check` and `mise tasks validate`) and keeps the answers until the repo's next commit; a config you trusted or a mise you installed shows at once. A config mise cannot read is not checked for format or problems until mise lists its tasks, and an older mise without `mise fmt --check` or `mise tasks validate` skips those checks. Formatting keeps the order of the sections, `[tools]` above `[tasks]` or the other way round, as you wrote it. Your repo's branch and how far it is behind are not part of it, since the repo list shows them.
- Agents read the same graph through the [MCP server](/features/mcp) (`who_calls`, `subgraph_for`, `find_endpoint`); `subgraph_for` also gives the calls without a target of the repos in it.
- A frontend that generates its API client from a backend's OpenAPI spec is connected through that spec: commit the spec in the frontend repo, under any name, and Trackwall finds the repo that serves its operations, by `operationId` or by path, even when a tool such as Redocly CLI added a prefix to the paths or the servers point to a gateway. If your `package.json` script downloads the spec for `openapi-typescript` from a running service instead (`openapi-typescript http://localhost:8090/v3/api-docs`), Trackwall connects the frontend to the app on that host or port. The same goes for a Java service whose build generates a client from another service's spec. When no repo serves them, the spec shows under "Calls without a target".
- `find_endpoint` takes a path the way you have it: with or without the app's context path or a gateway prefix, a whole URL, `GET /api/orders/42`, or a few words such as "cancel order", which it looks for in paths, handler names and OpenAPI summaries. The closest matches come first, and each result says whether it matched the whole path, its end or the words.
- For Java repos, `find_endpoint` also tells which endpoint makes a call, not only which repo: Trackwall follows the calls from each endpoint's code to the HTTP clients it uses. So an agent can ask what a change to one endpoint affects and follow it from endpoint to endpoint. Calls made by scheduled jobs or event listeners belong to no endpoint, and repos with Kotlin code are not followed yet.
- When several of your apps run on the same `localhost` port (Spring's default 8080 is common), the port alone does not say which one an address means: Trackwall connects the caller only to the app whose endpoints match its calls, and an address without calls gets no connection from the port. Giving each app its own port makes the connection firmer.
- Version drift compares Java by its major version, so `17`, `17.0.9` and `temurin-17.0.9` are the same Java; every other version is compared as written. A repo with a mise config is judged by it rather than by its `pom.xml` or `.java-version`, because mise installs what it says. Plain dependencies are not compared, since their versions usually come from a BOM; a range such as `>=18`, an alias such as `lts/iron`, or a property Trackwall cannot fill in (`${jacoco.version}`) is skipped, since it names no one version. The target is the newest version among your repos, a release before its own release candidate or snapshot.
- "Impact of" at the top lights the repos a task's change reaches, ring by ring: see [Impact of a task](/features/impact).
- A commit, checkout or pull in any repo, or a repo added to the projects folder, redraws the graph within a couple of seconds. A hand edit of `workspace.yaml` shows up within five minutes, or at once with the refresh button.
- The first graph after a start waits for the cards of every repo; while they are computed, the view says how many are done.
