---
title: Trackwall in ten minutes
description: A short talk about Trackwall as slides, with what to say and what to show on each one.
search: false
---

# Trackwall in ten minutes

A short talk about Trackwall as slides, with what to say and what to show on each one.

[Po polsku](/pl/talk) · The arrows at the bottom, the left and right arrow keys, Page Up and Down (a clicker) or J and K move one slide at a time. Ten minutes in all, nine without the two optional slides. The demo is the made-up shop of twenty repos from the screenshots of this site.

<section class="slide">

<p class="slide-meta">01 · Opening · 0:30</p>

## What Trackwall is

A desktop app for working across **many git repositories** and **many coding agents** at once.

- Point it at your projects folder, and it keeps every repo there in view: what each one is built from, how the repos call each other, and what waits for you.
- Next to them it runs your Copilot CLI sessions and tells you which agent is waiting for you.
- The agents get the same picture of your repos through its MCP server.
- It keeps working when you close the window; the tray tells you when an agent needs you.

![Home: the repos of the demo shop around the sessions that work in them](/screenshots/home.png)

</section>

<section class="slide">

<p class="slide-meta">02 · The problem · 1:00</p>

## Many repos, one head

A system made of many repos is hard to keep in your head. An agent makes a change in one repo faster, but it sees only its own folder, and you carry the context between them.

- "Which repo implements this integration, and who uses it?" You search through ten repos by hand.
- "Does my change break a consumer in another repo?"
- "The agent mixes its changes into my branch."
- "Starting a service with its dependencies takes half a day."
- "In the morning I don't know what changed in twenty repos."
- "I run several agents at once and miss the one that is waiting for me."

::: tip The idea
Build the knowledge of the system once, from the code, and give the same picture to you and to every agent.
:::

</section>

<section class="slide">

<p class="slide-meta">03 · Principles · 0:40</p>

## What it stands on

- **Facts come from the code, not from a model.** The repo card and the graph are read from build files, configuration and code, with the file and line as evidence. An agent can reason about them; it does not invent them.
- **Light enough to leave running.** It reads commits straight from git, without building or indexing anything, and without a server or a database.
- **One picture for you and your agents.** The views and the MCP tools ask the same background process, the daemon.
- **You stay in charge.** An agent can propose a task, but nothing starts until you approve it, and you push.
- **On your computer, with your tools:** Copilot CLI, git, mise, Maven and Gradle as they are installed.

</section>

<section class="slide">

<p class="slide-meta">04 · Connection graph · 1:00</p>

## Who calls whom, with evidence

- Trackwall reads every repo's build files and code and draws the connections: packages, HTTP clients, endpoints.
- Every connection has the file and line that prove it, and how sure Trackwall is, from "certain" to "possible".
- The repo card: the stack, apps and ports, endpoints, required tools and mise tasks, without building anything.

::: info On screen
"Overview", the graph, who calls `POST /api/payments`, then a click on a connection for its file and line.
:::

![The connection graph of the demo shop](/screenshots/overview.png)

</section>

<section class="slide">

<p class="slide-meta">05 · The agent sees the other repos · 1:00</p>

## The agent checks the consumers itself

- An agent works in one repo but asks Trackwall about the rest of the system through MCP.
- `find_endpoint`: where an endpoint is. `who_calls`: who calls it. `search_code`: code in every repo at once.
- Before it changes a contract, it knows which repos would break, and why.

::: info On screen
A session in `payments`, asked: "Who uses POST /api/payments, and what happens if I change a field?" Live, with a real Copilot CLI.
:::

</section>

<section class="slide">

<p class="slide-meta">06 · Agent tasks · 1:00</p>

## The agent on its own branch, you review

- An agent task gets its own copy of the repo (a worktree) and its own branch. Your branch stays untouched.
- "Changes": the diff, and comments on lines that go back to the agent as a review.
- "Verify" runs the task's tests; a red result goes back to the agent.
- <Badge type="tip" text="new" /> **Automatic review:** Copilot CLI's `/review` of the task's changes, and one click turns a finding into a comment on its line.
- The branch is pushed and the merge request opened only when you press "Push".

::: info On screen
The task "Retry the payment call", its "Changes", a red "Verify", then "Review".
:::

![A task's changes with review comments](/screenshots/task-review.png)

</section>

<section class="slide">

<p class="slide-meta">07 · A change across repos · 0:50</p>

## One change, four repos

- The supervisor splits the work into one task per repo, waits for your approval, follows the tasks and steers them.
- The demo's example: `payments`, `notifications`, `admin-web` and `billing`.
- <Badge type="tip" text="new" /> A proposed change arrives as one card with its repos in merge order; you can edit the prompt and untick repos.
- <Badge type="tip" text="new" /> The "Change" section lists every merge request with its state and the merge order, with its reason from the graph (which repo calls which), and pushes all parts at once.

</section>

<section class="slide">

<p class="slide-meta">08 · Services · 0:45</p>

## A service and its dependencies in one click

- Starts a service with the services it calls, in order, and waits until each answers.
- A task's version of a service can take over its port for a test through the whole system.
- Calling an endpoint returns the answer together with the errors every service logged meanwhile.

::: info On screen
"Services", start a service with its dependencies, and watch each one turn ready.
:::

</section>

<section class="slide">

<p class="slide-meta">09 · Many agents at once · 0:45</p>

## The agent that waits for you is not missed

- Every session's state in one list, a counter, notifications, and approvals you answer from the tray.
- <Badge type="tip" text="new" /> **The conversation view** (preview) instead of the terminal: the files the agent works on, a coloured diff, a file change shown before you allow it, the Agent and Plan modes, how much of the model's context is used, and pasted screenshots and logs.

::: info On screen
The session grid, one session waiting for an approval, and the approval answered from the tray.
:::

![The session grid](/screenshots/sessions-grid.png)

</section>

<section class="slide">

<p class="slide-meta">10 · The morning · 0:30 · optional</p>

## Start my day

- One button syncs every repo safely and starts a briefing of what changed and what waits for you.
- A plan keeps the bigger picture between tasks.

</section>

<section class="slide">

<p class="slide-meta">11 · Security · 0:50</p>

## Safe, and honest about its limits

- The daemon listens only on `127.0.0.1`, and every request needs its token.
- No MCP tool changes Trackwall's settings or answers an approval; only you do, in the app.
- <Badge type="tip" text="new" /> A task with "No approvals" runs in Copilot CLI's **sandbox**, on Linux by default and on macOS and Windows when you turn it on: it writes only in its worktree and the repo's git folder, and cannot read your other repos or `~/.ssh`.
- Secrets come from mise and are masked in logs. Every tool call an agent makes is in "MCP calls".
- The limit: an agent runs as you. Keeping secrets out of its way prevents accidents, not a determined agent.

</section>

<section class="slide">

<p class="slide-meta">12 · Dev container · 0:30 · optional</p>

## <Badge type="tip" text="new" /> Trackwall in a dev container

- Where security software slows git and builds down on Windows, everything that touches the repos runs in Linux in a container, with the repos in a Docker volume.
- You use Trackwall from the browser or the desktop app through a forwarded port.

</section>

<section class="slide">

<p class="slide-meta">13 · Where it stands · 0:40</p>

## Today, and what comes next

- An early version: features are missing and edges are rough.
- Copilot CLI only. Another agent can use the tools through MCP, without sessions or approvals in the app.
- The card reads Maven, Gradle, npm, Spring Boot and OpenAPI. Kafka and queues are not in the graph yet; you can add those connections by hand.
- One person, one computer. Windows and macOS, Linux through a container.

::: tip To close
The agent stops seeing only its own folder. It sees the whole system, the way you do.
:::

[Why Trackwall](/guide/why-trackwall) · [How it works](/guide/how-it-works) · [Security model](/guide/security-model) · [Limits today](/guide/limits) · [Install](/guide/install)

</section>
