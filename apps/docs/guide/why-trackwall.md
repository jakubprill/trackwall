---
title: Why Trackwall
description: The everyday problems of working across many repos with coding agents, and how Trackwall helps with each of them.
---

# Why Trackwall

The everyday problems of working across many repos with coding agents, and how Trackwall helps with each of them.

A system made of many repos is hard to keep in your head. One service calls three others, a library is built in a fourth repo, the frontend talks to a backend-for-frontend, and the knowledge of who calls whom lives in code nobody has open. Coding agents make it faster to change one repo, but they see only the folder they run in, and you end up as the one who carries the context between them.

Trackwall's idea is to build that knowledge once, from the code itself, and give the same picture to you and to every agent: which repos there are, what each is made of, how they connect, what runs, and what waits for you.

## The problems it solves

| The problem | What Trackwall does | Where |
|---|---|---|
| "Which repo implements this integration, and who uses it?" You search through ten repos by hand. | Reads every repo's build files and code and draws the connections: packages, HTTP clients, endpoints, each with the file and line that proves it. | [Connection graph](/features/graph), [Repo card](/features/repo-card) |
| "Does my change break a consumer in another repo?" | An agent looks it up before it answers: which repos call this endpoint, which endpoint makes each call, and the code that does it in every repo at once. | [MCP server](/features/mcp) (`find_endpoint`, `who_calls`, `search_code`) |
| "The agent mixes its changes into my branch." | An agent task works on its own branch in its own copy of the repo; you review its diff, comment on lines, run its tests with "Verify" and open the merge request. | [Agent tasks](/features/tasks), [Where agents work](/guide/where-agents-work) |
| "Starting a service with its dependencies takes half a day." | Starts a service with the services it calls, in order, waits until each answers, and lets a task's version of a service take over its port for a test through the whole system. | [Services](/features/services) |
| "In the morning I don't know what changed in twenty repos." | One button syncs every repo safely and starts a briefing of what changed and what waits for you; a plan keeps the bigger picture between tasks. | [Start my day](/features/start-my-day), [Plan](/features/plan) |
| "How is this mechanism done in our other services? Is the bug on our side or theirs?" | Calling an endpoint returns the answer together with the errors every service logged meanwhile, and the agent reads the logs and the code of every repo. | [Services](/features/services), [MCP server](/features/mcp) (`call_endpoint`, `get_errors`) |
| "What is this repo even built from? How do I run it?" | The repo card lists the stack, apps and ports, endpoints, required tools and mise tasks, read from the files, without building anything. | [Repo card](/features/repo-card), [mise tasks](/features/mise-tasks) |
| "I run several agents at once and miss the one that is waiting for me." | Every session's state in one list, a counter, notifications, and approvals you can answer from the tray. | [Sessions](/features/sessions), [Approvals](/features/approvals), [Home](/features/home) |
| "A change touches three repos, and I coordinate the agents myself." | The supervisor splits the work into one task per repo, waits for your approval, follows the tasks and steers them. | [Supervisor](/features/supervisor), [Main session and task proposals](/features/main-session) |
| "Tokens and local config end up in places they shouldn't, or get lost with a clone." | Variables and secrets come from your mise config, secrets stay out of the agent's commands by default and masked in logs, and your local config is backed up outside the repo. | [Environment from mise](/features/mise-environment), [Local config backup](/features/local-config) |

## The principles behind it

**Facts come from the code, not from a model.** The repo card and the connection graph are read from build files, configuration and source code, with the file and line for every fact. Connections are matched by rules, and each one comes with its evidence and how sure Trackwall is, from "certain" to "possible", so you can check it. An agent can reason about the facts, but it does not invent them.

**Light enough to leave running.** Trackwall reads committed files straight from git, without building or indexing anything and without a server or database. A repo's card is computed once per commit and kept. It watches your repos for new commits with a few cheap file checks a second.

**One picture for you and your agents.** The views you look at and the tools an agent calls ask the same background process, the daemon. When you see that a service is ready or a task is waiting, the agents see the same.

**You stay in charge.** An agent can propose a task, but nothing starts until you approve it. A task works on its own branch and is told not to push; you review its changes, and its branch is pushed when you press "Push". Trackwall gives no agent a tool that changes its settings or answers an approval. [Security model](/guide/security-model) has the details.

**It works on your computer, with your tools.** Trackwall runs Copilot CLI, git, mise and your build tools as they are installed, in your projects folder. Trackwall itself goes online only for what you set up or ask for: syncing and pushing with git, the remote of your local config backup, downloads you start, and the check for its own updates. Copilot CLI sends your conversation and the code it reads to its model, as it does anywhere.

## Read on

- [How Trackwall works](/guide/how-it-works): the parts and how they talk to each other.
- [Key flows](/guide/key-flows): sessions, tasks, the supervisor and services, step by step in diagrams.
- [Limits today](/guide/limits): what Trackwall does not do yet.
