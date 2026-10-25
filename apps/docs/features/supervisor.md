---
title: Supervisor
description: Talk to one agent above all your repos, pinned on the right of every view, that plans the work and hands it to other agents.
---

# Supervisor

Talk to one agent above all your repos, pinned on the right of every view, that plans the work and hands it to other agents.

## What you get

- One place to describe what you want done across repos, visible next to Home, Repos, Sessions and every other view.
- An agent that splits the work into task proposals, one per repo, and follows the agents that run them.
- Everything it delegated, with its state, right under it: in its panel and at the top of "Sessions".
- A bell on the panel when the supervisor or one of its proposals is waiting for you.

## How it works

The supervisor is a Copilot CLI session that runs in your projects folder, not in a single repo, so it sees all your repos at once. There is one supervisor at a time. Its terminal sits in the panel on the right side of the window, whichever view you are in, so you can talk to it while you browse repos or watch the dashboard.

Ask it for something larger than one repo, like "add refunds to billing and show their status in the web shop". It looks through your repos and proposes a task for each repo involved. The proposals wait for you in "Sessions", under the "Supervisor" heading at the top of the list, and in "Delegated" in the panel. You read each one, edit the prompt if you want, and start it or reject it with a reason, as with any [task proposal](/features/main-session). Nothing starts without you.

Once a task runs, the supervisor follows its agent, reads its summary and changes, and tells you what came back and what needs your decision. A task's agent can still propose more work of its own; that work sits under the task, inside the supervisor's part of the list.

The panel can be folded to a narrow strip at the right edge, which keeps a bell when something waits for you. The panel stays pinned or folded the next time you open Trackwall.

## Use it

1. Set your projects folder in "Settings", if you have not yet.
2. Press "Start supervisor" in the panel on the right (or Alt+0 to get there first).
3. Tell it what you want done.
4. Review its proposals in "Sessions" or from "Delegated" in the panel, and start the ones you want.

## Shortcuts

| Keys | What happens |
|---|---|
| Alt+0 (⌥0 on macOS) | Pin the supervisor panel open and put the keyboard in its terminal, from any view. |

## Good to know

- The supervisor coordinates; it is told not to change code itself. Every task it proposes still needs your approval.
- It sees every session and task, also the ones you started yourself, but it cannot type into other sessions or change Trackwall's settings.
- Stop ends the supervisor; "Start again" starts a new one in its place. The work it delegated stays under the "Supervisor" heading, also after Trackwall restarts.
- When the supervisor waits for you, the tray, the system notification and the tray panel call it "Supervisor". Alt+J and the "Sessions" counter leave it out, since its panel already shows it.
- It needs Copilot CLI, like any [session](/features/sessions), and the projects folder to be set.
