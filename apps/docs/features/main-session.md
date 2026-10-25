---
title: Main session and task proposals
description: Let one agent plan work and hand it to other agents, while you approve every task before it starts.
---

# Main session and task proposals

Let one agent plan work and hand it to other agents, while you approve every task before it starts.

![Three task proposals from the main session in orders-api, with the first one open](/screenshots/main-session.png)

## What you get

- A main session that splits a larger job into tasks and proposes them, each with a title and a prompt.
- Every proposal waiting for your decision: read it, edit the prompt, start it or reject it with a reason.
- Several proposals started with one press; they start one after another.
- The main session following its tasks to the end and reading their summaries and changes.

## How it works

Any Copilot CLI session connected to Trackwall can act as a main session, whether it runs in "Sessions" or in your own terminal. When it calls `propose_task`, the proposal appears in "Sessions" as "waiting for your decision", is counted with the waiting sessions on the view bar, shows in the "Needs you" queue on the [Home dashboard](/features/home) and in the tray menu, and flashes the taskbar icon.

All proposals of one session are one entry, indented under that session, which gets a "main" badge with the number of items under it. Select the entry to see who proposed them and each proposal with its full prompt; open a proposal to read and edit it. "Start task" turns it into an ordinary [agent task](/features/tasks). With several proposals, tick the ones you want and press "Start N selected"; a proposal can be ticked once you have opened it. "Reject…" asks for an optional reason, which goes back to the main session so it can propose something else. Nothing starts until you decide.

A task's agent finishes with a summary, shown above the task's tabs. The main session waits for its tasks and reads their summaries and changes, so it can plan the next step.

## Use it

1. Start a session in "Sessions" (or run `copilot` with the Trackwall MCP server in your projects folder).
2. Describe the larger job and ask the agent to split it into task proposals.
3. Open the proposals, edit the prompts if needed, and start the ones you want.
4. Let the main session collect the results.

## Good to know

- A proposal for a repo that already has tasks says so.
- In the session grid, a tile with proposals shows their prompts with "Start task" and "Reject…"; "Next waiting" and Alt+J go to proposals too.
- Proposals last until Trackwall quits, at most 20 at a time; summaries stay with their tasks.
- A proposal from an agent outside Trackwall is marked "agent outside Trackwall" and listed at the top level, like a proposal from a session you have closed. Such an agent can propose tasks, but cannot report a task's summary.
- Prompts, titles and summaries cannot contain invisible characters, so what you read before "Start task" is the whole prompt.
