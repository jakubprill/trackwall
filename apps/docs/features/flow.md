---
title: Flow
description: Watch every group of agent work on one wall, on a second monitor, with what waits for you and what has stood too long.
---

# Flow

Watch every group of agent work on one wall, on a second monitor, with what waits for you and what has stood too long.

![Flow: the tasks of the demo shop in rows by group and columns by state, each card with how long it has been there](/screenshots/flow.png)

## What you get

- Every task, session and task proposal on one screen, without opening any of them.
- A row for each group of work: a project of [Plan](/features/plan), a [change across several repos](/features/changes), the [supervisor's](/features/supervisor) work, a session with the [tasks it proposed](/features/main-session), and the rest.
- A column for each state: "Working", "Waits for you", "In review", "Stuck" and "Idle", with the count of each above the wall.
- How long each card has been in its column, so a long wait or a quiet agent shows from across the room.

## How it works

"Flow" is a view for looking at, not for working in. Open it in its own window and move that window to your second monitor; it keeps itself up to date, and the times on the cards move on by themselves.

Each row is a group you already made. A task started on an item of a Plan project is in that project's row, with how far the project is. The parts of a change share a row named after its first part. The supervisor, the tasks it proposed and its proposals waiting for you share a row too, and so does any other session with the tasks it proposed, under the session's name as in "Sessions". Everything else, such as a task you typed yourself, is under "No group".

A card goes to "Waits for you" when its agent asks for an approval or a plan, when its turn ended and you have not looked yet, or when it is a task proposal waiting for your decision. It goes to "In review" when the agent handed its work over, and to "Stuck" when the agent may be stuck, its session ended with an error, or its verification or pipeline failed. A column lists its longest wait first.

Click a card to open its task or session. In the desktop app it opens in the window that shows "Sessions", so the wall stays as it is.

## Use it

1. Press Ctrl+Shift+6 (⌥⌘6 on macOS) to open "Flow" in a new window.
2. Drag the window to your second monitor, and press Ctrl+= (⌘= on macOS) until the cards read well from your desk.
3. Click a card in "Waits for you" or "Stuck" to deal with it.

## Shortcuts

| Keys | What happens |
|---|---|
| Ctrl+6 (⌘6) | Show "Flow" in this window. |
| Ctrl+Shift+6 (⌥⌘6) | Open "Flow" in a new window. |
| Ctrl+= and Ctrl+- (⌘= and ⌘-) | Make the wall larger or smaller in this window. |

## Good to know

- Flow changes nothing: to move an item, answer an agent or stop a task, open it from its card.
- A task's time counts from its last change of state that Trackwall saw; after Trackwall restarts, a task without a session counts from when it was created.
- A task leaves the wall when you end it.
- The window comes back on the same monitor the next time you start Trackwall, as every window does (see [Navigation and windows](/features/navigation-and-windows)).
