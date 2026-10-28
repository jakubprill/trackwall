---
title: Copilot CLI sessions
description: Run several Copilot CLI agents side by side, each in its own repo, and always know which one is waiting for you.
---

# Copilot CLI sessions

Run several Copilot CLI agents side by side, each in its own repo, and always know which one is waiting for you.

![Copilot CLI sessions and agent tasks in a grid, some working, some waiting for you or asking for approval](/screenshots/sessions-grid.png)

## What you get

- Several Copilot CLI sessions at once, all in one window: in a repo's own working copy, or as free sessions in your projects folder, tied to no repo.
- A state for every session: working, waiting for you, asking for approval or idle.
- A nudge when an agent needs you: a flashing taskbar icon with the number waiting, a system notification and an entry in the tray.
- A grid of terminals, so you can watch up to nine agents at once on a wide monitor.
- Sessions that keep running when you close the window, and come back with their conversations after Trackwall restarts or updates.

## How it works

Open "Sessions", press "+" and pick where the agent works. With a repo and "In its own worktree" checked, your prompt becomes an [agent task](/features/tasks) on its own branch. Uncheck it and "Start session" opens Copilot CLI in the repo's own folder, the working copy your editor uses; pick "No repo: the projects folder" instead and it opens a free session in your projects folder, which can look at every repo. Either way the prompt is optional: what you write there is the agent's first message, otherwise you type in its terminal. Copilot CLI starts in a terminal inside Trackwall, already connected to the [Trackwall MCP server](/features/mcp). Start as many sessions as you like; the list on the left shows each one with its repo (or "Free session"), its state and what the agent is doing right now.

A session without its own worktree changes your files directly: there is no "Changes" tab, review, "Verify" or merge request, which only a task has. The form says so, and warns you when another session already works in the same folder, because two agents in one working copy change each other's files and switch its branch under each other.

A new session shows "waiting for you" as soon as Copilot CLI is ready for your first message. When an agent finishes its turn, its session shows "waiting for you" again; when it asks for approval of a step or a plan, "asking for approval" or "waiting for plan approval". Either way the counter on the view bar goes up. The session stays waiting until you have looked at it: select it, or type into its terminal, and it becomes "idle". In the grid, only the selected tile counts as looked at. A request for approval keeps waiting until you answer it. "Next waiting" (or Alt+J) takes you straight to the next session that needs you.

You do not have to keep Trackwall in front. When its window is in the background, a waiting session shows a system notification ("Session in orders-api: Copilot CLI is asking for approval"), the taskbar icon flashes (the Dock icon bounces on macOS), and the tray menu gets a "Waiting: orders-api" item. While anything waits for you, the Trackwall icon on the taskbar (in the Dock on macOS) shows how many sessions and task proposals are waiting, and the tray icon has a dot. Win+Alt+J (⌃⌥J on macOS) works from any app: it brings Trackwall forward on the next session that needs you. A left click on the tray icon opens a small panel with everything waiting for you, where you can also [answer an approval request](/features/approvals) without opening the session.

The switch above the terminal changes the layout: 1 shows the selected session with its full panel, 2 and 4 show pages of that many terminals, and Auto fits the whole list on screen, up to nine at a time (six sessions on a 34-inch ultrawide are three columns and two rows). The selected tile has the accent ring and takes the keyboard; a tile waiting for you has a warning frame. A task's tile shows a badge next to its title when the task has something to say: yellow with the number of warnings (such as a changed mise config or files another task also changes), grey otherwise. The badge opens the task's sections over its terminal, and Esc closes them. A warning that comes up while you watch the grid lies over the terminal as one line, with "Show" and an X. Neither changes the terminal's size.

Every session also gets short instructions from Trackwall on how to work with you: a session in a repo hands larger work over as a [task proposal](/features/main-session), and a session of an [agent task](/features/tasks) stays in its own worktree, does not push and finishes with a summary. They also tell the agent which Trackwall it runs in and where this documentation is; [Session instructions](/features/session-instructions) has the details.

## Use it

1. Install Copilot CLI and sign in to it.
2. Open "Sessions" (Ctrl+3, ⌘3 on macOS).
3. Press "+", pick a repo (or "No repo: the projects folder"), uncheck "In its own worktree" and press "Start session".
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
- Each session gets the variables and tokens of your mise config, and the line under its header says which: see [Environment from mise](/features/mise-environment).
- A free session runs in the projects folder, so the trusted folder you set for Copilot CLI and the antivirus exclusion of that folder cover it. It can change any repo there, and it can hand work over as a [task proposal](/features/main-session), but it does not run a repo's mise tasks or services through Trackwall. Unlike the [supervisor](/features/supervisor), you can run several, and it may run commands and change files.
- The [supervisor](/features/supervisor) is not one of the numbered entries: its heading tops the list with the work it delegated under it, and selecting it opens its panel on the right.
- Copilot CLI takes over the mouse in the terminal. Drag over text to select it and press Ctrl+C or right-click to copy it, as the hint under the selection says. You can also drag with Option (macOS) or Shift (Windows) held down, then copy with Cmd+C or Ctrl+C. Ctrl+C without a selection interrupts the agent. Paste with Cmd+V or Ctrl+V (Ctrl+Shift+V works too). While text is selected, links in the session open only after you clear the selection with a click.
- Session terminals use Trackwall's own colours and have no background of their own, so Copilot CLI's text, highlights and diffs blend into the rest of the window. To hide Copilot CLI's tab bar and start-up tip, see the [supervisor](/features/supervisor) page.
- Drag a file or folder from Explorer or Finder onto a terminal to paste its path, quoted when it has a space.
- "Stop" ends the session with everything it started; "Close" removes an ended session from the list. The X next to a session does both in one click and asks first while the agent is working. On an [agent task](/features/tasks), the X closes only its session: the task stays on the list; select it and press "Resume" to start a new session in its worktree. Once the task has no session, its X ends the task: it asks, in the tile or under the row, whether to keep the branch and remove the worktree or remove both, and the task leaves the list.
- When Trackwall quits, restarts or updates, its sessions stop, and the next start opens again every session that was running then, the [supervisor](/features/supervisor) and task sessions included, with the same conversation. An agent that was in the middle of a turn waits for you in the reopened session: ask it to go on. Sessions you stopped yourself stay stopped. Sessions are not recorded.
- Trackwall follows a session's state without starting a program at each step of the agent, so an antivirus that scans every program start does not hold the agent up. Copilot CLI itself loads its package (over 200 MB) from `%LOCALAPPDATA%\copilot\pkg` on Windows at every start. If your antivirus skips only your projects folder, move the package there: run `setx COPILOT_PKG_CACHE_HOME "<projects folder>\.copilot-pkg"`, then Quit Trackwall from the tray and start it again. Copilot CLI unpacks itself there on its next start, and the folder does not show up as a repo.
- Behind a proxy, Trackwall adds `127.0.0.1` to `NO_PROXY` for its sessions, so the agent reaches Trackwall's tools on your computer directly. Programs the agent runs see that value too.
- The notifications appear under "Trackwall" in the notification settings of Windows and macOS, where you can turn them off.
- The layout lasts until Trackwall closes; an extra window keeps its layout across restarts.
