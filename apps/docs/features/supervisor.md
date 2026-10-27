---
title: Supervisor
description: Talk to one agent above all your repos, pinned on the right of every view, that plans the work and hands it to other agents.
---

# Supervisor

Talk to one agent above all your repos, pinned on the right of every view, that plans the work and hands it to other agents.

## What you get

- One place to describe what you want done across repos, visible next to Home, Repos, Sessions and every other view.
- An agent that splits the work into task proposals, one per repo, and follows the agents that run them.
- A supervisor that wakes up when one of its tasks finishes a turn, reports or gets a verification verdict, and can send that task's agent a correction or an answer.
- Everything it delegated, with its state, right under it: in its panel and at the top of "Sessions".
- A bell on the panel when the supervisor, or a task proposal from it or from the work it delegated, is waiting for you.

## How it works

The supervisor is a Copilot CLI session that runs in your projects folder, not in a single repo, so it sees all your repos at once. There is one supervisor at a time. Its terminal sits in the panel on the right side of the window, whichever view you are in, so you can talk to it while you browse repos or watch the dashboard.

Ask it for something larger than one repo, like "add refunds to billing and show their status in the web shop". It looks through your repos and proposes a task for each repo involved. The proposals wait for you in "Sessions", under the "Supervisor" heading at the top of the list, and in "Delegated" in the panel. You read each one, edit the prompt if you want, and start it or reject it with a reason, as with any [task proposal](/features/main-session). Nothing starts without you.

Once a task runs, the supervisor does not have to keep checking on it. When the task's agent finishes a turn, reports its result, gets a verification verdict, or stops, Trackwall types one line into the supervisor's terminal asking it to look, as soon as the supervisor waits for input. The same happens in the other direction when the supervisor sends a task a message. If the session is in the middle of a turn, the line reaches its agent without typing: with the result of the next tool it runs, and again as the start of a new turn when the current one ends, so a busy supervisor or task picks it up right away. If the session sits idle, Trackwall types the line once the input box is really back on the screen, never types into text you are writing, and tries again a few seconds later if the line did not go through. The supervisor then reads the summary, reviews the diff, and tells you what came back and what needs your decision. It can also send the task's agent a message, for example "the BFF now returns `totalCents`, use that", which you see in the task's panel. A task's agent can still propose more work of its own; that work sits under the task, inside the supervisor's part of the list.

The panel can be folded to a narrow strip at the right edge, which keeps a bell when something waits for you. The panel stays pinned or folded the next time you open Trackwall. In a small window the panel is narrower, and the views next to it narrow their side panels, so a task's terminal and the Home dashboard keep their room.

## Use it

1. Set your projects folder in "Settings", if you have not yet.
2. Press "Start supervisor" in the panel on the right (or Alt+0 to get there first), or "Start my day" to begin with a briefing (see [Start my day](/features/start-my-day)). Once you have talked to a supervisor, the panel shows "Resume" and "New" instead: "Resume" goes on with the last conversation, "New" starts a clean one.
3. Tell it what you want done.
4. Review its proposals in "Sessions" or from "Delegated" in the panel, and start the ones you want.

## Shortcuts

| Keys | What happens |
|---|---|
| Alt+0 (⌥0 on macOS) | Pin the supervisor panel open and put the keyboard in its terminal, from any view. |

## Good to know

- The supervisor coordinates and does not change code itself: it cannot run shell commands or write files, so every change goes through a task you approve and review. It still reads your repos. Every task it proposes needs your approval.
- If you want the supervisor to run commands and edit files itself, add this to `~/.trackwall/workspace.yaml` (you edit this file by hand) and start a new supervisor; it then asks for approval like any other session:

  ```yaml
  supervisor:
    changesCode: true
  ```
- Ask the supervisor to remove a repo you no longer need and it proposes the removal instead of a task. It waits for you with the other proposals; "Remove repo" moves the repo's folder into `.trackwall-removed` in your projects folder, so you can move it back or delete it for good. Trackwall refuses while a session, a task or a running service still uses the repo, and tells you what to stop first.
- It sees every session and task, also the ones you started yourself, but it sends messages only to the tasks it proposed, never to sessions you started, and it cannot change Trackwall's settings.
- After five messages to a task without you, the supervisor has to ask you before it sends more. Typing anything into the supervisor or the task, or sending the task a review, counts as you taking part.
- Stop ends the supervisor. "Resume" brings it back with the same conversation, also after you closed it or Trackwall restarted, so it still knows what you worked on; "New" starts a new one in its place. "Start my day" always starts a new one. The work it delegated stays under the "Supervisor" heading, also after Trackwall restarts.
- After Trackwall restarts or updates, the supervisor and the sessions that were running come back on their own, with their conversations. A task whose session had already ended stays without one: ask the supervisor to continue it, and it resumes the task in its own worktree with the same conversation, as "Resume" does, instead of proposing the work again on a new branch. It does this for tasks you started too, and only when you ask.
- When the supervisor waits for you, the tray, the system notification and the tray panel call it "Supervisor". The "Sessions" counter leaves it out, since its panel shows it; Alt+J and "Next waiting" go to it once nothing else is waiting. It is not on the [Home dashboard](/features/home) either.
- The supervisor does not run mise tasks or services itself: it works in no single repo, so it proposes a task in the repo instead.
- A task works in a copy of one repo, so the supervisor does not hand it work on the projects folder itself, such as removing a repo; it tells you what that takes instead. A follow-up on a task that is still running goes to that task as a message rather than to a new task, so it ends up on the same branch.
- It needs Copilot CLI, like any [session](/features/sessions), and the projects folder to be set.
