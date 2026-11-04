---
title: Impact of a task
description: See which repos a task's API change reaches, ring by ring, get a task proposed for each repo that calls what changed, and hand any of them a task in one click.
---

# Impact of a task

See which repos a task's API change reaches, ring by ring, get a task proposed for each repo that calls what changed, and hand any of them a task in one click.

![The Impact tab of a task in pricing: three changed endpoints, the repos they reach drawn in rings round pricing, and a task being handed to orders-api](/screenshots/task-impact.png)

## What you get

- The endpoints a task's commits add, remove or change, with their request and response types and the DTOs whose fields changed.
- The repos that call them, and then the repos whose endpoints call those repos, ring by ring, up to three rings out.
- A drawing of the rings round the task's repo, and the same rings lit on the connection graph.
- A task proposed for each repo that calls a changed endpoint, as soon as the task's agent finishes a turn. Nothing starts until you approve it.
- "Hand off" on every reached repo: a new task there, with a prompt that lists what changed and where that repo calls it.

## How it works

Open a task and choose the "Impact" tab. Trackwall compares the endpoints of the task's last commit with those of the commit the task started from, the same way the [repo card](/features/repo-card) reads them, and lists what changed. A changed path counts as one removed endpoint and one added.

Ring 1 is every repo whose HTTP client calls a removed or changed endpoint, found the way the [connection graph](/features/graph) finds calls. Ring 2 is every repo that calls an endpoint of ring 1 whose code makes such a call, and so on. A repo marked "maybe" is reached only through a repo whose code Trackwall could not follow, or through a client that knows an address but no paths, such as a frontend's proxy to its BFF: the change may reach it, or not. Hover a repo, in the drawing or in the list, to light what it calls.

"Hand off" opens the prompt of a new task in that repo, which you can edit before "Start task in …". The new task is a subtask of this one: its agent is told which task handed it the work and reads the change with its tools, it hears when this task commits again, and its result goes back to this task's agent, as with a task the agent proposed itself (see [Main session and task proposals](/features/main-session)). Its agent asks before running tools.

You do not have to open the tab for the repos that call a changed endpoint directly. Each time the task's agent finishes a turn, Trackwall compares again and proposes a task for each such repo, with the same prompt "Hand off" would start with. The proposals wait in "Sessions" under the task, marked "Proposed by Trackwall", like the ones an agent makes: open one, edit the prompt if you like, and start or reject it. A repo is proposed each endpoint once, so a rejected proposal does not come back, unless the task later changes another endpoint that repo calls. No proposal goes to a repo marked "maybe", to the rings further out, or to a repo where the task already has work going on (its own repo, a task it proposed or handed off, the other parts of its change). If the task's agent proposes a task in that repo itself, its proposal replaces Trackwall's.

"Show on Overview" opens the connection graph with the task's repo, the reached repos in the colour of their ring and the calls between the rings lit, and the rest dimmed. You can also pick any task under "Impact of" at the top of "Overview".

![The connection graph of twenty repos with the impact of the pricing task lit: catalog and orders-api in ring 1, six services in ring 2, two frontends in ring 3](/screenshots/overview-impact.png)

## Use it

1. Commit the change in the task's worktree (the agent usually does).
2. When the agent finishes its turn, check the proposals under the task in "Sessions" and start or reject each one.
3. For any other reached repo, open the task's "Impact" tab, click "Hand off" on the repo, check the prompt and click "Start task in …".

## Good to know

- Only commits count: uncommitted work is not in the comparison. The tab shows which commit it read and checks again every ten seconds.
- An endpoint's callers come from the default branch of the other repos, which is usually what is deployed.
- When a card of the task could not be fully read, only added and removed endpoints are listed, not changed contracts, and the tab says so.
- Only HTTP endpoints count. Messages, events and GraphQL are not compared yet, and repos with Kotlin code are not followed from endpoint to endpoint, so what they reach shows as "maybe".
- Agents read the same list, rings included, with the `get_changed_endpoints` tool of the [MCP server](/features/mcp).
