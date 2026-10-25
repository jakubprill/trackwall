---
title: Copilot CLI sessions
description: Run several Copilot CLI agents side by side, each in its own repo, and always know which one is waiting for you.
---

# Copilot CLI sessions

Run several Copilot CLI agents side by side, each in its own repo, and always know which one is waiting for you.

![Copilot CLI sessions and agent tasks in a grid, some working, some waiting for you or asking for approval](/screenshots/sessions-grid.png)

## What you get

- Several Copilot CLI sessions at once, each in a repo from your projects folder, all in one window.
- A state for every session: working, waiting for you, asking for approval or idle.
- A nudge when an agent needs you: a flashing taskbar icon, a system notification and an entry in the tray.
- A grid of terminals, so you can watch up to nine agents at once on a wide monitor.
- Sessions that keep running when you close the window.

## How it works

Open "Sessions", pick a repo and Copilot CLI starts in a terminal inside Trackwall, already connected to the [Trackwall MCP server](/features/mcp). Start as many sessions as you like; the list on the left shows each one with its repo, its state and what the agent is doing right now.

When an agent finishes its turn, its session shows "waiting for you"; when it asks for approval of a step or a plan, "asking for approval" or "waiting for plan approval". Either way the counter on the view bar goes up. The session stays waiting until you have looked at it: select it, or type into its terminal, and it becomes "idle". In the grid, only the selected tile counts as looked at. A request for approval keeps waiting until you answer it. "Next waiting" (or Alt+J) takes you straight to the next session that needs you.

You do not have to keep Trackwall in front. When its window is in the background, a waiting session shows a system notification ("Session in orders-api: Copilot CLI is asking for approval"), the taskbar icon flashes (the Dock icon bounces on macOS), and the tray menu gets a "Waiting: orders-api" item. Win+Alt+J (⌃⌥J on macOS) works from any app: it brings Trackwall forward on the next session that needs you. A left click on the tray icon opens a small panel with everything waiting for you.

The switch above the terminal changes the layout: 1 shows the selected session with its full panel, 2 and 4 show pages of that many terminals, and Auto fits the whole list on screen, up to nine at a time (six sessions on a 34-inch ultrawide are three columns and two rows). The selected tile has the accent ring and takes the keyboard; a tile waiting for you has a warning frame.

Every session also gets short instructions from Trackwall on how to work with you: a session in a repo hands larger work over as a [task proposal](/features/main-session), and a session of an [agent task](/features/tasks) stays in its own worktree, does not push and finishes with a summary. They also tell the agent which Trackwall it runs in and where this documentation is; [Session instructions](/features/session-instructions) has the details.

## Use it

1. Install Copilot CLI and sign in to it.
2. Open "Sessions" (Ctrl+3, ⌘3 on macOS).
3. Pick a repo and start a session.
4. Work in the terminal as you would in any Copilot CLI session.
5. When a session waits for you, press Alt+J to jump to it.

## Shortcuts

| Keys | What happens |
|---|---|
| Alt+1 … Alt+9 (⌥ on macOS) | Select the session at that position in the list, turning the grid to its page. |
| Alt+J | Jump to the next session or task proposal waiting for you, from any view. |
| Alt+0 | Open the [supervisor](/features/supervisor) panel, from any view. |
| Win+Alt+J (⌃⌥J on macOS) | Bring Trackwall forward on the next session waiting for you, from any app. |

Alt+1 … Alt+9, Alt+0 and Alt+J work while a terminal has the focus too, and are not typed into the session; Esc and Ctrl+C go to Copilot CLI as usual and interrupt the agent's turn. On macOS, an Option key that types a character on your keyboard layout (⌥5 for `[` on a German keyboard) stays a character.

## Good to know

- Copilot CLI must be on your `PATH` as `copilot` and signed in.
- The [supervisor](/features/supervisor) is not one of the numbered entries: its heading tops the list with the work it delegated under it, and selecting it opens its panel on the right.
- Copilot CLI takes over the mouse in the terminal. Select text by dragging with Option (macOS) or Shift (Windows) held down, then copy with Cmd+C or Ctrl+C. Ctrl+C without a selection interrupts the agent.
- Drag a file or folder from Explorer or Finder onto a terminal to paste its path, quoted when it has a space.
- "Stop" ends the session with everything it started; "Close" removes an ended session from the list. The X next to a session does both in one click and asks first while the agent is working. On an [agent task](/features/tasks), the X closes only its session: the task stays on the list; select it and press "Resume" to start a new session in its worktree. Once the task has no session, its X ends the task: it asks, in the tile or under the row, whether to keep the branch and remove the worktree or remove both, and the task leaves the list.
- Sessions end when Trackwall quits and are not recorded.
- The notifications appear under "Trackwall" in the notification settings of Windows and macOS, where you can turn them off.
- The layout lasts until Trackwall closes; an extra window keeps its layout across restarts.
